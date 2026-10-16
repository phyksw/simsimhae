// 공개 사이트 업로드(src/publish.js) 테스트: 서버(자식 프로세스, 임시 DATA_DIR)가 가짜 Worker(이 프로세스의 http 서버)로 올리는 내용을 확인한다.
// 출처 어댑터와 reader.js(readPost)는 가짜로 바꿔 외부 사이트로는 요청을 보내지 않는다. Claude API 도 가짜 Worker 가 400 으로 받는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : os.tmpdir();
const tmpDirs = [];
const mkTmp = (name) => {
  mkdirSync(tmpBase, { recursive: true });
  const d = mkdtempSync(path.join(tmpBase, `pub-${name}-`));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다리다 시간 초과: ${what}`);
    await sleep(25);
  }
}

// =====================================================================
// 가짜 Worker (CONTRACT.md 의 업로드 API) + 가짜 Claude API(/v1/messages → 400)
// =====================================================================
const TOKEN = 'tok-test';
function makeFakeWorker() {
  const w = {
    token: TOKEN,
    requests: [], // 업로드 API 요청 (인증 실패 포함)
    snapshots: [], // 받아들인 스냅샷
    reads: new Map(), // id -> 미리보기 문서
    readLog: [], // 받아들인 미리보기 id 순서
    version: null,
    failSnapshot: 0,
    rejectRead: new Set(), // 이 id 의 미리보기는 413 으로 거절
    delayMs: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  w.server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/v1/')) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'test' } });
    w.inFlight++;
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
    try {
      if (w.delayMs) await sleep(w.delayMs);
      const rec = { method: req.method, path: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: raw ? JSON.parse(raw) : null, at: Date.now() };
      w.requests.push(rec);
      if (req.headers.authorization !== `Bearer ${w.token}`) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/api/sync/status') {
        return send(200, { version: w.version, posts: w.snapshots.at(-1)?.posts.length ?? 0, reads: w.reads.size, updatedAt: null });
      }
      if (req.method === 'PUT' && req.url === '/api/sync/snapshot') {
        if (w.failSnapshot > 0) {
          w.failSnapshot--;
          return send(500, { error: 'boom' });
        }
        w.snapshots.push(rec.body);
        w.version = rec.body.version;
        const keep = new Set(rec.body.posts.map((p) => p.id));
        let pruned = 0;
        for (const id of [...w.reads.keys()]) if (!keep.has(id)) (w.reads.delete(id), pruned++);
        return send(200, { ok: true, posts: rec.body.posts.length, pruned });
      }
      const m = /^\/api\/sync\/read\/([^/]+)$/.exec(req.url);
      if (req.method === 'PUT' && m) {
        const id = decodeURIComponent(m[1]);
        if (w.rejectRead.has(id)) return send(413, { error: '너무 커요' });
        w.reads.set(id, rec.body);
        w.readLog.push(id);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    } finally {
      w.inFlight--;
    }
  });
  return w;
}

// =====================================================================
// 서버 (가짜 출처·가짜 readPost)
// =====================================================================
const SOURCES = ['humoruniv', 'dogdrip', 'todayhumor', 'dcinside', 'fmkorea', 'inven', 'quasarzone', 'etoland'];
const MOCK_SOURCES = `
  import { existsSync, readFileSync } from 'node:fs';
  import path from 'node:path';
  const items = () => { const f = path.join(process.env.DATA_DIR, 'mock-items.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
  const mk = (id, extra = {}) => ({ id, name: id + ' 이름', short: id.slice(0, 3), color: '#123456', homepage: 'https://' + id + '.example.invalid/',
    strictness: 'normal', imageHosts: ['img.' + id + '.example.invalid'], referer: 'https://' + id + '.example.invalid/',
    async list(page) { return page === 1 ? (items()[id] || []) : []; }, async read() { throw new Error('테스트에서는 원문을 읽지 않음'); }, ...extra });
  const list = ${JSON.stringify(SOURCES)}.map((id) => mk(id, ['quasarzone', 'etoland'].includes(id) ? { disabled: true, disabledReason: '테스트' } : {}));
  export const loadErrors = {};
  export async function loadSources() { return list; }
  export async function getSource(id) { return list.find((s) => s.id === id) || null; }`;
// readPost 가짜: 'fmkorea:7' 은 본문 검사로 차단되고, 'inven:66' 은 원문을 못 읽는다(404)
const MOCK_READER = `
  import * as store from './store.js';
  export function proxiedUrl(s, u) { return '/api/img?s=' + encodeURIComponent(s) + '&u=' + encodeURIComponent(u); }
  export function forgetCached() {}
  export function cleanHtml(h) { return h; }
  export function cleanComments() { return []; }
  export function htmlToText(h) { return h; }
  export async function readPost(post) {
    console.log('[mock-read] ' + post.id);
    if (post.id === 'inven:66') throw Object.assign(new Error('없는 글'), { status: 404 });
    let statusChanged = false;
    const live = store.getPost(post.id);
    if (post.id === 'fmkorea:7' && live && !live.bodyChecked) {
      live.auto = { status: 'blocked', reasons: ['본문 정치'], flags: {} };
      live.bodyChecked = true;
      const before = live.status;
      live.status = store.resolveStatus(live);
      statusChanged = before !== live.status;
      store.upsertPost(live);
    }
    return { title: post.title, html: '<p>본문 ' + post.id + '</p><img src="' + proxiedUrl(post.source, 'https://img.' + post.source + '.example.invalid/a.jpg') + '">',
      text: '본문 ' + post.id + '\\n[이미지]', mediaCount: 1, statusChanged,
      comments: [{ author: '댓글러', text: '댓글 ' + post.id, likes: 1, dislikes: null, best: false, reply: false, postedAt: null, images: [] }], commentTotal: 1 };
  }`;

function writeHook(dir) {
  const hook = path.join(dir, 'mock-hook.mjs');
  writeFileSync(
    hook,
    `import { registerHooks } from 'node:module';
     registerHooks({ load(url, ctx, next) {
       if (url.endsWith('/src/sources/index.js')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(MOCK_SOURCES)} };
       if (url.endsWith('/src/reader.js')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(MOCK_READER)} };
       return next(url, ctx);
     } });`,
  );
  return pathToFileURL(hook).href;
}

function startServer(dataDir, extraEnv) {
  const env = { ...process.env, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', CRAWL_INTERVAL_MIN: '0', ADMIN_PASSWORD: 'pub-admin', ...extraEnv };
  for (const k of ['ADULT_PASSWORD', 'ANTHROPIC_AUTH_TOKEN', 'SESSION_SECRET', 'TRUST_PROXY', 'COOKIE_SECURE', 'SOURCES', 'DISABLE_SOURCES']) delete env[k];
  const child = spawn(process.execPath, ['--import', writeHook(dataDir), 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버 시작 시간 초과\n${out}`)), 20000);
    child.stdout.on('data', (b) => {
      out += b;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m && /Claude 검수/.test(out)) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${m[1]}`, output: () => out, stop: () => child.kill() });
      }
    });
    child.stderr.on('data', (b) => (out += b));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`서버가 종료됨 (${code})\n${out}`));
    });
  });
}

// ---------- 시험 데이터 ----------
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60e3).toISOString();
const NOUNS = ['고양이', '강아지', '라면', '편의점', '자전거', '김밥', '우산', '냉장고'];
function seedPost(id, min, extra = {}) {
  const [source, postId] = id.split(':');
  const title = `${NOUNS[Number(postId) % NOUNS.length]} 이야기 ${postId}`;
  return {
    id, source, postId, title, url: `https://${source}.example.invalid/${postId}`,
    postedAt: null, firstSeenAt: ago(min), updatedAt: ago(min),
    commentCount: null, views: null, likes: null, category: null, nsfwHint: false, thumbnail: null,
    manual: null, ai: null, aiPending: false, dupOf: null, titleKey: title.replace(/\s+/g, ''), shorts: null,
    auto: { status: 'ok', reasons: [], flags: {} }, status: extra.manual || 'ok', shortsScore: 0,
    ...extra,
  };
}
const aiOk = (score) => ({ verdict: 'ok', shortsScore: score, reason: '', model: 'test', at: ago(1) });
const SEED = [
  // 썰·대화
  seedPost('humoruniv:101', 1, { manualVibe: true, likes: 50 }),
  seedPost('fmkorea:7', 2, { manualVibe: true, likes: 20 }), // 미리보기 본문 검사로 차단됨
  seedPost('dogdrip:103', 3, { manualVibe: true, likes: 30 }),
  // 웃긴 것만
  seedPost('todayhumor:201', 4, { manualVibe: false, ai: aiOk(80), likes: 70 }),
  seedPost('dcinside:202', 5, { manualVibe: false, ai: aiOk(75), likes: 10 }),
  // 전체
  seedPost('humoruniv:301', 6, { likes: 5 }),
  seedPost('inven:66', 7, { likes: 3 }), // 원문을 못 읽음
  seedPost('dogdrip:303', 8, { commentCount: 12 }),
  seedPost('todayhumor:401', 9, { likes: 40 }), // 대표 글 (사본 dogdrip:402)
  seedPost('dogdrip:402', 10, { likes: 15, dupOf: 'todayhumor:401' }), // 출처별 게시판에만
  seedPost('dcinside:501', 11, { manual: 'blocked' }), // 대표 글이 숨김 → 사본이 대신 전체에
  seedPost('humoruniv:502', 12, { manual: 'ok', dupOf: 'dcinside:501', likes: 8 }),
  seedPost('quasarzone:701', 13, { likes: 9 }), // 수집을 끈 출처 (자동으로 읽으러 가지 않음)
  seedPost('dcinside:601', 10 * 1440, { ai: aiOk(90), likes: 100 }), // 7일 지나 픽에서 빠짐
  // 므흣
  seedPost('humoruniv:801', 14, { manual: 'adult', likes: 60 }),
  seedPost('dogdrip:802', 15, { manual: 'adult', likes: 5, dupOf: 'humoruniv:801' }), // 므흣 게시판에선 묶여 안 보임 → 올리지 않음
  seedPost('dcinside:803', 16, { manual: 'adult', likes: 2 }),
  // 올리지 않는 글
  seedPost('inven:901', 17, { manual: 'blocked' }),
  seedPost('dogdrip:902', 1.5, { aiPending: true }), // Claude 검수 대기
];
// 미리보기를 올리는 순서: 썰·대화 → 웃긴 것만 → 전체 → 므흣 → 나머지, 게시판 안에서는 최신순
const ATTEMPT_ORDER = [
  'humoruniv:101', 'fmkorea:7', 'dogdrip:103',
  'todayhumor:201', 'dcinside:202',
  'humoruniv:301', 'inven:66', 'dogdrip:303', 'todayhumor:401', 'humoruniv:502', 'dcinside:601',
  'humoruniv:801', 'dcinside:803',
  'dogdrip:402',
];
const UPLOAD_ORDER = ATTEMPT_ORDER.filter((id) => !['fmkorea:7', 'inven:66'].includes(id));
const POST_KEYS = ['id', 'source', 'title', 'url', 'postedAt', 'firstSeenAt', 'commentCount', 'views', 'likes', 'category', 'status', 'alsoOn', 'boards', 'hot', 'hotIn', 'hasRead'].sort();
const READ_KEYS = ['title', 'html', 'text', 'mediaCount', 'comments', 'commentTotal', 'updatedAt'].sort();

let w;
let srv;
let dataDir;
const H = { 'x-admin-key': 'pub-admin' };
async function api(p, { headers = {}, body, method, type = 'application/json' } = {}) {
  const r = await fetch(srv.base + p, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { ...(body !== undefined ? { 'content-type': type } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
}
const mockReads = () => [...srv.output().matchAll(/\[mock-read\] (\S+)/g)].map((m) => m[1]);
const pubStatus = async () => (await api('/api/meta', { headers: H })).json.publish;
const idle = () => waitFor(async () => !(await pubStatus()).running, '업로드가 끝나기');
/** 지금 올리기를 누르고, 새 스냅샷(또는 실패)까지 기다린다 */
async function publishAndWait() {
  const n = w.snapshots.length;
  const r = await api('/api/admin/publish', { headers: H, body: {} });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  await waitFor(() => w.snapshots.length > n, '스냅샷');
  await idle();
  return w.snapshots.at(-1);
}

before(async () => {
  w = makeFakeWorker();
  await new Promise((r) => w.server.listen(0, '127.0.0.1', r));
  const workerUrl = `http://127.0.0.1:${w.server.address().port}`;
  dataDir = mkTmp('srv');
  writeFileSync(
    path.join(dataDir, 'posts.json'),
    JSON.stringify({ posts: Object.fromEntries(SEED.map((p) => [p.id, p])), sources: {}, lastCrawlAt: ago(3), settings: {} }),
  );
  srv = await startServer(dataDir, {
    AI_MODERATION: '1',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: workerUrl,
    PUBLISH_URL: `${workerUrl}/`,
    PUBLISH_TOKEN: TOKEN,
    PUBLISH_READ_LIMIT: '3',
    PUBLISH_DEBOUNCE_SEC: '1',
  });
});
after(() => {
  srv?.stop();
  w?.server.close();
});

test('서버 시작 시 한 번: 상태 확인 → 미리보기(우선순위, 한 번에 3개) → 스냅샷 순서, 모두 Bearer 토큰', async () => {
  await waitFor(() => w.snapshots.length >= 1, '첫 스냅샷');
  const reqs = w.requests.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(reqs, ['GET /api/sync/status', 'PUT /api/sync/read/humoruniv%3A101', 'PUT /api/sync/read/dogdrip%3A103', 'PUT /api/sync/snapshot']);
  assert.ok(w.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
  assert.ok(w.requests.filter((r) => r.method === 'PUT').every((r) => r.type === 'application/json'));
  // 본문 검사로 차단된 글도 읽기는 했지만(3개 중 하나) 올리지 않았다
  assert.deepEqual(mockReads(), ['humoruniv:101', 'fmkorea:7', 'dogdrip:103']);

  const read = w.reads.get('humoruniv:101');
  assert.deepEqual(Object.keys(read).sort(), READ_KEYS);
  assert.equal(read.title, SEED.find((p) => p.id === 'humoruniv:101').title);
  assert.match(read.html, /\/api\/img\?s=humoruniv&u=/);
  assert.equal(read.mediaCount, 1);
  assert.equal(read.commentTotal, 1);
  assert.equal(read.comments[0].text, '댓글 humoruniv:101');
  assert.ok(!Number.isNaN(Date.parse(read.updatedAt)));

  const snap = w.snapshots[0];
  assert.ok(!Number.isNaN(Date.parse(snap.version)));
  assert.equal(snap.siteName, '심심풀이');
  assert.equal(snap.lastCrawlAt, ago(3));
  const ids = snap.posts.map((p) => p.id).sort();
  const expected = SEED.map((p) => p.id).filter((id) => !['fmkorea:7', 'dcinside:501', 'inven:901', 'dogdrip:902', 'dogdrip:802'].includes(id)).sort();
  assert.deepEqual(ids, expected, '공개 글 + 므흣 게시판 글만 (걸러진 글·검수 대기·본문 검사로 차단된 글·므흣 게시판에서 묶여 안 보이는 사본 빼고)');
  for (const p of snap.posts) assert.deepEqual(Object.keys(p).sort(), POST_KEYS, p.id);
  const by = Object.fromEntries(snap.posts.map((p) => [p.id, p]));
  assert.deepEqual(snap.posts.filter((p) => p.hasRead).map((p) => p.id).sort(), ['dogdrip:103', 'humoruniv:101']);
  assert.deepEqual(by['humoruniv:101'].boards, ['story', 'all', 'humoruniv']);
  assert.deepEqual(by['todayhumor:201'].boards, ['pick', 'all', 'todayhumor']);
  assert.deepEqual(by['dogdrip:402'].boards, ['dogdrip'], '묶인 사본은 출처별 게시판에만');
  assert.deepEqual(by['humoruniv:502'].boards, ['all', 'humoruniv'], '대표 글이 숨김이면 사본이 전체에');
  assert.deepEqual(by['dcinside:601'].boards, ['all', 'dcinside'], '7일 지난 글은 픽에서 빠짐');
  assert.deepEqual(by['humoruniv:801'].boards, ['adult']);
  assert.deepEqual(by['humoruniv:801'].alsoOn, [{ source: 'dogdrip', url: 'https://dogdrip.example.invalid/802' }], '묶여 안 보이는 므흣 사본은 같은 글 배지로');
  assert.deepEqual(by['todayhumor:401'].alsoOn, [{ source: 'dogdrip', url: 'https://dogdrip.example.invalid/402' }]);
  assert.equal(by['dogdrip:303'].commentCount, 12);
  assert.ok(snap.posts.every((p) => typeof p.hot === 'number' && Number.isFinite(p.hot)));
  // 게시판별 인기순 점수: 이 글이 나오는 전체·픽·썰 게시판마다 하나씩 (므흣 글은 없음)
  for (const p of snap.posts) {
    assert.deepEqual(Object.keys(p.hotIn), p.boards.filter((b) => ['story', 'pick', 'all'].includes(b)), p.id);
    assert.ok(Object.values(p.hotIn).every((v) => typeof v === 'number' && Number.isFinite(v)), p.id);
  }
  assert.deepEqual(by['humoruniv:801'].hotIn, {});

  // 출처: /api/meta 와 같은 기준 (꺼진 출처라도 공개 글이 남으면 포함)
  assert.deepEqual(snap.sources.map((s) => s.id).sort(), ['dcinside', 'dogdrip', 'fmkorea', 'humoruniv', 'inven', 'quasarzone', 'todayhumor']);
  const qz = snap.sources.find((s) => s.id === 'quasarzone');
  assert.deepEqual(qz, {
    id: 'quasarzone', name: 'quasarzone 이름', short: 'qua', color: '#123456', homepage: 'https://quasarzone.example.invalid/',
    active: false, imageHosts: ['img.quasarzone.example.invalid'], referer: 'https://quasarzone.example.invalid/',
  });
});

test('미리보기는 지금 올리기마다 3개씩, 썰·대화 → 웃긴 것만 → 전체 → 므흣 → 나머지 순서로 모두 올라간다', async () => {
  await idle();
  for (let i = 0; i < 8; i++) {
    const before = w.readLog.length;
    await publishAndWait();
    if (w.readLog.length === before) break;
  }
  assert.deepEqual(w.readLog, UPLOAD_ORDER);
  assert.deepEqual(mockReads(), ATTEMPT_ORDER, '수집을 끈 출처(quasarzone)는 읽지 않고, 못 읽은 글은 곧바로 다시 시도하지 않는다');
  const snap = w.snapshots.at(-1);
  const notRead = snap.posts.filter((p) => !p.hasRead).map((p) => p.id).sort();
  assert.deepEqual(notRead, ['inven:66', 'quasarzone:701']);
  const st = await pubStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.url, `http://127.0.0.1:${w.server.address().port}`);
  assert.equal(st.lastError, null);
  assert.ok(Date.parse(st.lastOkAt) > NOW);
  assert.deepEqual(st.reads, { done: UPLOAD_ORDER.length, pending: 1 }, '못 읽은 글은 남은 수에 들어가고, 꺼진 출처의 글은 빠진다');

  // 올린 기록은 글에 남는다 (서버를 다시 켜도 다시 올리지 않게)
  await sleep(1800); // 저장 예약(1.5초)
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'posts.json'), 'utf8')).posts;
  assert.match(saved['humoruniv:101'].published.hash, /^[0-9a-f]{16}$/);
  assert.ok(!Number.isNaN(Date.parse(saved['humoruniv:101'].published.readAt)));
  assert.equal(saved['fmkorea:7'].status, 'blocked');
  assert.equal(saved['fmkorea:7'].published, undefined);
  assert.equal(saved['inven:66'].published, undefined);
});

test('스냅샷 boards 는 로컬 목록 API 와 정확히 같다 (total·글 목록·인기순·같은 글)', async () => {
  const snap = w.snapshots.at(-1);
  const boardIds = ['story', 'pick', 'all', 'adult', ...new Set(snap.posts.filter((p) => p.status === 'ok').map((p) => p.source))];
  for (const b of boardIds) {
    const local = await api(`/api/posts?board=${b}&size=100`, { headers: H });
    assert.equal(local.status, 200, b);
    const mine = snap.posts.filter((p) => p.boards.includes(b));
    assert.equal(mine.length, local.json.total, `${b} total`);
    assert.deepEqual(mine.map((p) => p.id).sort(), local.json.items.map((p) => p.id).sort(), b);
    for (const it of local.json.items) assert.deepEqual(snap.posts.find((p) => p.id === it.id).alsoOn, it.alsoOn, `${b} ${it.id} alsoOn`);
    // 인기순: Worker 처럼 그 게시판 점수(hotIn[b], 없으면 hot)가 큰 순, 같으면 최신순으로 세우면 로컬 인기순과 같다
    const hot = await api(`/api/posts?board=${b}&size=100&sort=hot`, { headers: H });
    const score = (p) => (Object.hasOwn(p.hotIn, b) ? p.hotIn[b] : p.hot);
    const ts = (p) => Date.parse(p.postedAt || p.firstSeenAt) || 0;
    const order = [...mine].sort((x, y) => score(y) - score(x) || ts(y) - ts(x)).map((p) => p.id);
    assert.deepEqual(order, hot.json.items.map((p) => p.id), `${b} 인기순`);
  }
  // 방문자용 /api/meta 와도 같다
  const meta = (await api('/api/meta')).json;
  for (const b of ['story', 'pick', 'all']) assert.equal(snap.posts.filter((p) => p.boards.includes(b)).length, meta.boardCounts[b], b);
  assert.deepEqual(snap.sources.map((s) => s.id), meta.sources.map((s) => s.id));
  for (const s of meta.sources) assert.equal(snap.posts.filter((p) => p.boards.includes(s.id)).length, s.count, s.id);
  assert.equal(meta.publish, undefined, '업로드 상태는 관리자에게만');
});

test('지금 올리기: 관리자만, JSON 만', async () => {
  assert.equal((await api('/api/admin/publish', { body: {} })).status, 401);
  assert.equal((await api('/api/admin/publish', { headers: H, body: 'x', type: 'text/plain' })).status, 415);
});

test('관리자 변경 뒤 디바운스로 한 번만 올리고, 실패해도 서버는 살아 있고 다음 기회에 다시 올린다', async () => {
  await idle();
  const start = w.requests.length;
  w.failSnapshot = 1;
  assert.equal((await api('/api/admin/posts/humoruniv:301', { headers: H, body: { manual: 'blocked' } })).status, 200);
  assert.equal((await api('/api/admin/posts/dogdrip:303', { headers: H, body: { manual: 'blocked' } })).status, 200);
  assert.equal(w.requests.length, start, '바로 올리지 않는다 (디바운스)');
  await waitFor(async () => (await pubStatus()).lastError, '실패 기록', 8000);
  await sleep(1500); // 디바운스가 한 번만 도는지 조금 더 본다
  const during = w.requests.slice(start).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(during, ['GET /api/sync/status', 'PUT /api/sync/snapshot'], '두 번 바꿔도 한 번만');
  const st = await pubStatus();
  assert.match(st.lastError, /HTTP 500/);
  assert.match(st.lastError, /boom/);
  assert.equal((await api('/api/posts?board=all')).status, 200, '서버는 계속 동작');

  const snap = await publishAndWait();
  const ids = snap.posts.map((p) => p.id);
  assert.ok(!ids.includes('humoruniv:301') && !ids.includes('dogdrip:303'), '숨긴 글은 공개 사이트에서도 빠진다');
  const after = await pubStatus();
  assert.equal(after.lastError, null);
  assert.deepEqual(after.reads, { done: UPLOAD_ORDER.length - 2, pending: 1 }, '빠진 글의 올린 기록은 지운다 (Worker 가 지웠으므로)');
});

test('토큰이 틀리면(401) 출처 사이트에 요청하지 않고 실패로 남긴다', async () => {
  await idle();
  // 숨겼던 글을 다시 게시 → 올린 기록이 지워졌으므로 미리보기를 다시 만들어야 함
  assert.equal((await api('/api/admin/posts/humoruniv:301', { headers: H, body: { manual: 'ok' } })).status, 200);
  w.token = 'other-token';
  const readsBefore = mockReads().length;
  const start = w.requests.length;
  await api('/api/admin/publish', { headers: H, body: {} });
  await waitFor(async () => /401/.test((await pubStatus()).lastError || ''), '401 기록');
  await sleep(1300); // 디바운스(1초)도 지나가게
  await idle();
  assert.match((await pubStatus()).lastError, /PUBLISH_TOKEN/);
  assert.equal(mockReads().length, readsBefore, '원문을 읽으러 가지 않음');
  assert.ok(w.requests.slice(start).every((r) => r.method === 'GET' && r.path === '/api/sync/status'));

  w.token = TOKEN;
  const snap = await publishAndWait();
  assert.equal(mockReads().at(-1), 'humoruniv:301');
  assert.equal(w.readLog.at(-1), 'humoruniv:301');
  assert.equal(snap.posts.find((p) => p.id === 'humoruniv:301').hasRead, true);
  assert.equal((await pubStatus()).lastError, null);
});

test('바뀐 게 없으면 스냅샷을 다시 올리지 않는다 (지금 올리기는 항상 올림)', async () => {
  await idle();
  const start = w.requests.length;
  // 걸러진 글의 후보함 변경은 공개 목록에 영향이 없다
  assert.equal((await api('/api/admin/posts/inven:901', { headers: H, body: { shorts: { stage: 'candidate' } } })).status, 200);
  await waitFor(() => w.requests.length > start, '디바운스 실행', 5000);
  await sleep(300);
  await idle();
  assert.deepEqual(w.requests.slice(start).map((r) => `${r.method} ${r.path}`), ['GET /api/sync/status']);
  assert.equal((await pubStatus()).lastError, null);
});

test('수집이 끝나면 올리고, 제목이 바뀐 글은 미리보기를 다시 만든다', async () => {
  await idle();
  const n = w.snapshots.length;
  const old = w.reads.get('humoruniv:502');
  writeFileSync(path.join(dataDir, 'mock-items.json'), JSON.stringify({ humoruniv: [{ postId: '502', title: '라면 이야기 502 (수정)', url: 'https://humoruniv.example.invalid/502', likes: 8 }] }));
  assert.equal((await api('/api/admin/crawl', { headers: H, body: {} })).status, 202);
  await waitFor(() => w.snapshots.length > n, '수집 뒤 스냅샷');
  await idle();
  const snap = w.snapshots.at(-1);
  const p = snap.posts.find((x) => x.id === 'humoruniv:502');
  assert.equal(p.title, '라면 이야기 502 (수정)');
  assert.equal(p.hasRead, true);
  assert.equal(w.readLog.at(-1), 'humoruniv:502');
  assert.equal(w.reads.get('humoruniv:502').title, '라면 이야기 502 (수정)');
  assert.notEqual(w.reads.get('humoruniv:502').updatedAt, old.updatedAt);
  assert.notEqual(snap.lastCrawlAt, ago(3), '마지막 수집 시각도 함께');
});

test('동시에 두 번 돌지 않는다: 도는 중에 온 요청은 끝난 뒤 한 번으로 합친다', async () => {
  await idle();
  const start = w.requests.length;
  w.delayMs = 150;
  w.maxInFlight = 0;
  try {
    await Promise.all([1, 2, 3].map(() => api('/api/admin/publish', { headers: H, body: {} })));
    await sleep(100);
    await idle();
  } finally {
    w.delayMs = 0;
  }
  assert.equal(w.maxInFlight, 1);
  const runs = w.requests.slice(start).filter((r) => r.path === '/api/sync/status').length;
  assert.equal(runs, 2, '지금 도는 것 + 끝난 뒤 한 번');
});

test('Worker 저장소가 비어 있으면(새로 만듦) 미리보기를 처음부터 다시 올린다', async () => {
  await idle();
  // 기대 순서: 지금 로컬 목록의 썰·대화 → 웃긴 것만 → 전체 (최신순), 못 읽어 쉬는 글·꺼진 출처의 글은 빼고 3개
  const order = [];
  for (const b of ['story', 'pick', 'all']) for (const it of (await api(`/api/posts?board=${b}&size=100`, { headers: H })).json.items) if (!order.includes(it.id)) order.push(it.id);
  const expected = order.filter((id) => !['inven:66', 'quasarzone:701'].includes(id)).slice(0, 3);
  assert.equal(expected[0], 'humoruniv:101');
  w.reads.clear();
  w.version = null;
  const log = w.readLog.length;
  const snap = await publishAndWait();
  assert.deepEqual(w.readLog.slice(log), expected);
  assert.deepEqual(snap.posts.filter((p) => p.hasRead).map((p) => p.id).sort(), [...expected].sort());
});

test('공개 사이트가 미리보기 하나를 거절(413)하면 그 글만 건너뛰고 나머지는 계속 올린다', async () => {
  await idle();
  const read = new Set(w.snapshots.at(-1).posts.filter((p) => p.hasRead).map((p) => p.id));
  const order = [];
  for (const b of ['story', 'pick', 'all']) for (const it of (await api(`/api/posts?board=${b}&size=100`, { headers: H })).json.items) if (!order.includes(it.id)) order.push(it.id);
  const next = order.filter((id) => !read.has(id) && !['inven:66', 'quasarzone:701'].includes(id)).slice(0, 3);
  assert.equal(next.length, 3);
  w.rejectRead = new Set([next[0]]);
  const start = w.requests.length;
  try {
    let snap = await publishAndWait();
    assert.equal((await pubStatus()).lastError, null, '작업 전체는 성공');
    assert.ok(snap.posts.find((p) => p.id === next[1]).hasRead && snap.posts.find((p) => p.id === next[2]).hasRead);
    assert.equal(snap.posts.find((p) => p.id === next[0]).hasRead, false);
    snap = await publishAndWait();
    const tries = w.requests.slice(start).filter((r) => r.path === `/api/sync/read/${encodeURIComponent(next[0])}`).length;
    assert.equal(tries, 1, '거절된 글은 다시 보내지 않는다');
  } finally {
    w.rejectRead = new Set();
  }
});

test('설정: 주소·토큰이 둘 다 있어야 켜지고, https 만 (테스트 중에는 이 컴퓨터 주소로만)', () => {
  const cfg = (env) => {
    const e = { ...process.env, DATA_DIR: mkTmp('cfg'), PUBLISH_URL: '', PUBLISH_TOKEN: '', ...env };
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.js'); console.log(JSON.stringify(config.publish));"], { cwd: ROOT, env: e });
    return JSON.parse(String(out));
  };
  let c = cfg({ PUBLISH_URL: 'https://simsimhae.board.workers.dev' });
  assert.equal(c.enabled, false);
  assert.match(c.error, /PUBLISH_TOKEN/);
  assert.equal(cfg({ PUBLISH_TOKEN: 'x' }).enabled, false);
  assert.match(cfg({ PUBLISH_URL: 'http://simsimhae.board.workers.dev', PUBLISH_TOKEN: 'x' }).error, /https/);
  assert.match(cfg({ PUBLISH_URL: 'https://simsimhae.board.workers.dev/?t=1', PUBLISH_TOKEN: 'x' }).error, /주소만/);
  c = cfg({ PUBLISH_URL: 'https://simsimhae.board.workers.dev/', PUBLISH_TOKEN: 'x' });
  assert.equal(c.enabled, false, '테스트 중에는 공개 사이트로 올리지 않는다');
  c = cfg({ PUBLISH_URL: 'https://simsimhae.board.workers.dev/', PUBLISH_TOKEN: 'x', NODE_TEST_CONTEXT: undefined });
  assert.equal(c.enabled, true);
  assert.equal(c.url, 'https://simsimhae.board.workers.dev');
  assert.equal(c.readLimit, 40);
  assert.equal(c.debounceMs, 30000);
  c = cfg({ PUBLISH_URL: 'http://127.0.0.1:9/', PUBLISH_TOKEN: 'x', PUBLISH_READ_LIMIT: '0' });
  assert.equal(c.enabled, true);
  assert.equal(c.readLimit, 0);
});

test('꺼져 있으면 /api/meta 에 enabled:false, 지금 올리기는 409', async () => {
  const dir = mkTmp('off');
  const off = await startServer(dir, { AI_MODERATION: '0', PUBLISH_URL: '', PUBLISH_TOKEN: '' });
  try {
    const meta = await (await fetch(`${off.base}/api/meta`, { headers: H })).json();
    assert.deepEqual(meta.publish, { enabled: false, url: null, lastOkAt: null, lastError: null, running: false, reads: { done: 0, pending: 0 } });
    const r = await fetch(`${off.base}/api/admin/publish`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 409);
  } finally {
    off.stop();
  }
});
