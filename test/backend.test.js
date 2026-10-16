// 백엔드 회귀 테스트: 서버(별도 프로세스, 임시 DATA_DIR, 임의 포트)와 수집기(이 프로세스, 가짜 소스·가짜 Claude API).
// 외부 사이트로는 요청을 보내지 않는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_ENV = { ...process.env }; // 아래 수집기 테스트가 process.env 를 바꾸기 전의 값
const tmpBase = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : os.tmpdir();
const tmpDirs = [];
const mkTmp = (name) => {
  mkdirSync(tmpBase, { recursive: true });
  const d = mkdtempSync(path.join(tmpBase, `be-${name}-`));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// =====================================================================
// 1) 서버 (자식 프로세스)
// =====================================================================

/** 서버를 띄우고 출력에서 실제 포트를 읽는다 */
function startServer(dataDir, extraEnv = {}) {
  const env = { ...BASE_ENV, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', CRAWL_INTERVAL_MIN: '0', ...extraEnv };
  for (const k of ['ADULT_PASSWORD', 'ADMIN_PASSWORD', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SESSION_SECRET', 'TRUST_PROXY', 'COOKIE_SECURE']) {
    if (!(k in extraEnv)) delete env[k];
  }
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버 시작 시간 초과\n${out}`)), 20000);
    const onData = (b) => {
      out += b;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m && /Claude 검수/.test(out)) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${m[1]}`, output: () => out, stop: () => child.kill() });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => (out += b));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`서버가 종료됨 (${code})\n${out}`));
    });
  });
}

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
function seedPost(id, title, extra = {}) {
  const [source, postId] = id.split(':');
  return {
    id,
    source,
    postId,
    title,
    url: `https://example.invalid/${source}/${postId}`,
    postedAt: null,
    firstSeenAt: iso(5 * 60e3),
    updatedAt: iso(5 * 60e3),
    commentCount: null,
    views: null,
    likes: null,
    category: null,
    nsfwHint: false,
    thumbnail: null,
    manual: null,
    ai: null,
    aiPending: false,
    dupOf: null,
    titleKey: title.replace(/\s+/g, ''),
    shorts: null,
    auto: { status: 'ok', reasons: [], flags: {} },
    status: extra.manual || 'ok',
    shortsScore: 0,
    ...extra,
  };
}

const SEED = [
  // 대표 글이 숨김(관리자 차단)이고 사본은 관리자가 '게시하기' → 사본이 전체 게시판에 대신 보여야 함
  seedPost('dcinside:1', '지원금 받으러 갔다가 생긴 일', { manual: 'blocked' }),
  seedPost('humoruniv:9', '지원금 받으러 갔다가 생긴 일', { manual: 'ok', dupOf: 'dcinside:1' }),
  // 대표 글·사본 모두 공개 → 대표만 보이고 사본은 alsoOn 으로
  seedPost('todayhumor:5', '고양이가 상자에 들어가는 방법', { manual: 'ok' }),
  seedPost('dogdrip:6', '고양이가 상자에 들어가는 방법', { manual: 'ok', dupOf: 'todayhumor:5' }),
  // 대표 글이 므흣, 사본은 공개 → 사본은 각자 상태대로 공개 목록에 보임
  seedPost('dcinside:2', '헬스장 레전드 장면 모음집', { manual: 'adult' }),
  seedPost('humoruniv:2', '헬스장 레전드 장면 모음집', { manual: 'ok', dupOf: 'dcinside:2' }),
  // Claude 검수 대기 중인 새 글
  seedPost('ppomppu:10', '편의점 알바하다 겪은 썰', { aiPending: true, firstSeenAt: iso(60e3) }),
  // 걸러진 글 (쇼츠 점수 10 이하로 묶여 있음)
  seedPost('inven:8', '작가와 독자의 기싸움 레전드썰', { manual: 'blocked', shortsScore: 3 }),
  // 본문 검사로 차단된 글 (2번째 실행에서 본문 판정을 넣는다)
  seedPost('fmkorea:7', '평범한 고양이 이야기', {}),
];

let dataDir;
let srv;
let secrets;
const api = async (p, { headers = {}, body, method } = {}) => {
  const r = await fetch(srv.base + p, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const adminH = () => ({ 'x-admin-key': secrets.adminPassword });
const ids = (r) => r.json.items.map((p) => p.id);

before(async () => {
  dataDir = mkTmp('srv');
  writeFileSync(
    path.join(dataDir, 'posts.json'),
    JSON.stringify({ posts: Object.fromEntries(SEED.map((p) => [p.id, p])), sources: {}, lastCrawlAt: null, settings: {} }),
  );
  srv = await startServer(dataDir, { AI_MODERATION: '1', IMG_RATE_PER_MIN: '5', IMG_MAX_CONCURRENT_PER_IP: '1' });
  secrets = JSON.parse(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
});
after(() => srv?.stop());

test('첫 실행에는 새로 만든 비밀번호를 콘솔에 보여준다', () => {
  assert.ok(srv.output().includes(secrets.adminPassword), srv.output());
  assert.ok(srv.output().includes(secrets.adultPassword), srv.output());
});

test('잘못된 %-인코딩 쿠키로 서버가 죽거나 스택을 내보내지 않는다', async () => {
  const a = await api('/api/meta', { headers: { cookie: 'x=%; hg_admin=%E0%A4%A' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.admin, false);
  const b = await api('/api/posts', { headers: { cookie: 'x=%' } });
  assert.equal(b.status, 200);
  const c = await api('/api/meta');
  assert.equal(c.status, 200, '서버가 계속 살아 있어야 함');
});

test('정적 파일: Cloudflare 설정 파일(public/_headers)은 내려가지 않고 화면은 그대로', async () => {
  const h = await api('/_headers');
  assert.equal(h.status, 404);
  assert.ok(!/Content-Security-Policy/.test(h.text));
  const page = await api('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/app\.js"/);
  // 공개 사이트의 화면 파일도 이 서버와 같은 CSP 를 받는다 (public/_headers)
  const rules = readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
  assert.equal(/^\s+Content-Security-Policy:\s*(.+)$/m.exec(rules)?.[1].trim(), page.headers.get('content-security-policy'));
});

test('오류 응답은 JSON 이고 스택·경로가 없다', async () => {
  const r = await api('/api/lock', { body: '{' });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.json), ['error']);
  assert.ok(!/at |node_modules|\\|SyntaxError/.test(r.text), r.text);
});

test('공용 API(src/api.js)를 쓰는 로컬 서버: mode 없음·비밀 파일·공개 사이트 상태는 관리자에게, 클라우드 전용 경로(옮기기)는 404', async () => {
  const anon = await api('/api/meta');
  assert.ok(!('mode' in anon.json), '로컬 서버는 mode 를 보내지 않는다 (화면이 SSE 를 쓴다)');
  const adm = await api('/api/meta', { headers: adminH() });
  assert.ok(adm.json.secretsFile.endsWith('secrets.json'));
  assert.equal(typeof adm.json.publish?.enabled, 'boolean');
  const imp = await api('/api/admin/import', { headers: adminH(), body: { posts: [] } });
  assert.equal(imp.status, 404);
  assert.deepEqual(imp.json, { error: 'not found' });
  // 관리자 POST 는 JSON 만, 관리자 아니면 401 (순서도 예전과 같게)
  assert.equal((await api('/api/admin/live', { headers: { ...adminH(), 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await api('/api/admin/live', { body: {} })).status, 401);
  assert.equal((await api('/api/admin/posts/%E0%A4%A', { headers: adminH(), body: {} })).status, 400);
});

test('중복 묶음: 대표 글이 안 보이면 공개 사본이 전체 게시판에 대신 나온다', async () => {
  const all = await api('/api/posts?board=all&size=100');
  const got = ids(all);
  assert.ok(got.includes('humoruniv:9'), `대표가 차단된 사본이 보여야 함: ${got}`);
  assert.ok(!got.includes('dcinside:1'));
  assert.ok(got.includes('todayhumor:5'));
  assert.ok(!got.includes('dogdrip:6'), '대표가 공개면 사본은 합쳐짐');
  assert.deepEqual(
    all.json.items.find((p) => p.id === 'todayhumor:5').alsoOn.map((a) => a.source),
    ['dogdrip'],
  );
  assert.ok(got.includes('humoruniv:2'), '대표가 므흣이어도 사본은 자기 상태(공개)로 판단');
  assert.ok(!got.includes('ppomppu:10'), 'Claude 검수 대기 글은 숨김');
  // 검색도 같은 기준
  const q = await api(`/api/posts?board=all&q=${encodeURIComponent('지원금')}`);
  assert.deepEqual(ids(q), ['humoruniv:9']);
  // 출처별 게시판은 각 글의 상태로만
  const hu = await api('/api/posts?board=humoruniv&size=100');
  assert.ok(ids(hu).includes('humoruniv:9') && ids(hu).includes('humoruniv:2'));
});

test('/api/meta boardCounts·sources[].count 는 각 게시판 목록 total 과 같다', async () => {
  const anon = await api('/api/meta');
  assert.deepEqual(Object.keys(anon.json.boardCounts).sort(), ['all', 'pick', 'story']);
  for (const b of ['all', 'pick', 'story']) {
    assert.equal(anon.json.boardCounts[b], (await api(`/api/posts?board=${b}`)).json.total, b);
  }
  for (const s of anon.json.sources) {
    assert.equal(s.count, (await api(`/api/posts?board=${s.id}`)).json.total, s.id);
  }
  assert.equal(anon.json.pickCount, anon.json.boardCounts.pick);

  const adm = await api('/api/meta', { headers: adminH() });
  assert.equal(adm.json.admin, true);
  assert.deepEqual(Object.keys(adm.json.boardCounts).sort(), ['adult', 'all', 'filtered', 'pick', 'shorts', 'story']);
  for (const b of Object.keys(adm.json.boardCounts)) {
    assert.equal(adm.json.boardCounts[b], (await api(`/api/posts?board=${b}`, { headers: adminH() })).json.total, b);
  }
  for (const s of adm.json.sources) {
    assert.equal(s.count, (await api(`/api/posts?board=${s.id}`, { headers: adminH() })).json.total, s.id);
  }
});

test('므흣 게시판: 잠금 해제한 사람만 boardCounts.adult 를 받는다', async () => {
  assert.equal((await api('/api/posts?board=adult')).status, 403);
  const u = await api('/api/unlock', { body: { password: secrets.adultPassword } });
  assert.equal(u.status, 200);
  const cookie = u.headers.get('set-cookie').split(';')[0];
  const m = await api('/api/meta', { headers: { cookie } });
  assert.equal(m.json.adult, true);
  const list = await api('/api/posts?board=adult', { headers: { cookie } });
  assert.equal(m.json.boardCounts.adult, list.json.total);
  assert.ok(ids(list).includes('dcinside:2'));
});

test("관리자 지정을 '자동 판정으로' 되돌리면 Claude 검수 대기로 돌아간다", async () => {
  const id = encodeURIComponent('ppomppu:10');
  let r = await api(`/api/admin/posts/${id}`, { headers: adminH(), body: { manual: 'ok' } });
  assert.equal(r.json.post.aiPending, false, '관리자 지정 중에는 대기로 보이지 않음');
  assert.ok(ids(await api('/api/posts?board=all&size=100')).includes('ppomppu:10'));
  r = await api(`/api/admin/posts/${id}`, { headers: adminH(), body: { manual: null } });
  assert.equal(r.json.post.aiPending, true);
  assert.ok(!ids(await api('/api/posts?board=all&size=100')).includes('ppomppu:10'), '검수 없이 공개되면 안 됨');
});

test('관리자가 상태를 바꾸면 쇼츠 점수도 바로 다시 계산된다', async () => {
  const r = await api(`/api/admin/posts/${encodeURIComponent('inven:8')}`, { headers: adminH(), body: { manual: 'ok' } });
  assert.equal(r.json.post.status, 'ok');
  assert.ok(r.json.post.shortsScore > 10, `shortsScore=${r.json.post.shortsScore}`);
  // 바로 저장됐는지 (debounce 기다리지 않음)
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'posts.json'), 'utf8')).posts['inven:8'];
  assert.equal(saved.manual, 'ok');
});

test('인증 쿠키: Secure 는 HTTPS 일 때만, 비밀번호 꼬리표가 다르거나 옛 형식이면 거부', async () => {
  const plain = await api('/api/admin/login', { body: { password: secrets.adminPassword } });
  assert.equal(plain.status, 200);
  const sc = plain.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.doesNotMatch(sc, /Secure/);
  const viaHttps = await api('/api/admin/login', { body: { password: secrets.adminPassword }, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(viaHttps.headers.get('set-cookie'), /; Secure/);
  const cookie = sc.split(';')[0];
  assert.equal((await api('/api/meta', { headers: { cookie } })).json.admin, true);

  const signTok = (v) => `${v}.${createHmac('sha256', secrets.sessionSecret).update(v).digest('base64url')}`;
  const tag = (pw) => createHmac('sha256', secrets.sessionSecret).update(`pw|admin|${pw}`).digest('base64url').slice(0, 16);
  const exp = Date.now() + 3600e3;
  const asCookie = (tok) => ({ cookie: `hg_admin=${encodeURIComponent(tok)}` });
  assert.equal((await api('/api/meta', { headers: asCookie(signTok(`admin:${exp}:${tag(secrets.adminPassword)}`)) })).json.admin, true);
  assert.equal((await api('/api/meta', { headers: asCookie(signTok(`admin:${exp}:${tag('old-password')}`)) })).json.admin, false, '비밀번호가 바뀌면 무효');
  assert.equal((await api('/api/meta', { headers: asCookie(signTok(`admin:${exp}`)) })).json.admin, false, '꼬리표 없는 옛 쿠키는 무효');
});

test('비밀번호 시도 제한: 틀린 시도만 세고, 잠금 해제와 관리자 로그인은 따로 센다', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await api('/api/unlock', { body: { password: 'wrong' } })).status, 401);
  assert.equal((await api('/api/unlock', { body: { password: 'wrong' } })).status, 429);
  assert.equal((await api('/api/unlock', { body: { password: secrets.adultPassword } })).status, 429);
  // 잠금 해제 시도가 막혀도 관리자 로그인은 된다
  assert.equal((await api('/api/admin/login', { body: { password: secrets.adminPassword } })).status, 200);
  // 성공한 로그인은 세지 않는다
  for (let i = 0; i < 12; i++) assert.equal((await api('/api/admin/login', { body: { password: secrets.adminPassword } })).status, 200);
});

test('이미지 프록시: 접속자당 분당 요청 수 제한 (끝난 요청은 동시 연결 자리를 돌려준다)', async () => {
  // 동시 연결 1개로 띄웠으므로, 앞 요청이 자리를 돌려주지 않으면 두 번째부터 429 가 된다
  for (let i = 0; i < 5; i++) assert.equal((await api('/api/img?s=nope&u=https%3A%2F%2Fexample.invalid%2Fa.png')).status, 403);
  const r = await api('/api/img?s=nope&u=https%3A%2F%2Fexample.invalid%2Fa.png');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
});

test('재시작: 비밀번호는 다시 보여주지 않고, 규칙 저장 시 본문 판정을 지우고 제목으로 다시 판정', async () => {
  srv.stop();
  await new Promise((r) => srv.child.once('exit', r));
  const file = path.join(dataDir, 'posts.json');
  const db = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(db.settings.rulesHash, '시작할 때 규칙 지문을 저장');
  Object.assign(db.posts['fmkorea:7'], {
    auto: { status: 'blocked', reasons: ['본문 사건사고: 사망'], flags: {} },
    status: 'blocked',
    bodyChecked: true,
  });
  writeFileSync(file, JSON.stringify(db));

  srv = await startServer(dataDir, { AI_MODERATION: '1' });
  assert.ok(!srv.output().includes(secrets.adminPassword), srv.output());
  assert.ok(!srv.output().includes(secrets.adultPassword), srv.output());
  assert.ok(srv.output().includes('secrets.json'), srv.output());

  // 규칙이 그대로면 시작할 때 다시 판정하지 않는다 → 본문 판정 유지
  const filtered = await api('/api/posts?board=filtered&size=100', { headers: adminH() });
  assert.ok(ids(filtered).includes('fmkorea:7'));

  const rules = (await api('/api/admin/rules', { headers: adminH() })).json;
  const saved = await api('/api/admin/rules', { headers: adminH(), body: rules });
  assert.equal(saved.status, 200);
  const p = JSON.parse(readFileSync(file, 'utf8')).posts['fmkorea:7'];
  assert.equal(p.bodyChecked, false, '다음 미리보기 때 본문을 다시 검사하도록');
  assert.ok(!p.auto.reasons.some((r) => r.startsWith('본문 ')), JSON.stringify(p.auto));
});

test("SSE: '지금 수집' 한 번에 crawl 이벤트 한 번, addedPublic·게시판별 counts 포함 (가짜 소스, 외부 요청 없음)", async () => {
  const dir = mkTmp('sse');
  const hook = path.join(dir, 'mock-sources.mjs');
  const mockSource = `
    const mk = (id, items) => ({ id, name: id, short: id, color: '#333', homepage: 'https://example.invalid/', strictness: 'normal',
      imageHosts: [], referer: '', async list(page) { return page === 1 ? items : []; }, async read() { throw new Error('no'); } });
    const list = [
      mk('humoruniv', [{ postId: '1', title: '편의점 알바하다 겪은 웃긴 썰', url: 'https://example.invalid/h1' },
                       { postId: '2', title: '고양이가 상자에 들어가는 방법', url: 'https://example.invalid/h2' }]),
      mk('dogdrip', [{ postId: '7', title: '고양이가 상자에 들어가는 방법', url: 'https://example.invalid/d7' }]),
    ];
    export const loadErrors = {};
    export async function loadSources() { return list; }
    export async function getSource(id) { return list.find((s) => s.id === id) || null; }`;
  writeFileSync(
    hook,
    `import { registerHooks } from 'node:module';
     registerHooks({ load(url, ctx, next) {
       if (url.endsWith('/src/sources/index.js')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(mockSource)} };
       return next(url, ctx);
     } });`,
  );
  const env = { ...BASE_ENV, DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', CRAWL_INTERVAL_MIN: '0', AI_MODERATION: '0', ADMIN_PASSWORD: 'sse-admin' };
  const child = spawn(process.execPath, ['--import', new URL(`file:///${hook.replace(/\\/g, '/')}`).href, 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(out)), 20000);
      child.stdout.on('data', (b) => {
        out += b;
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m && /Claude 검수/.test(out)) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${m[1]}`);
        }
      });
      child.stderr.on('data', (b) => (out += b));
    });
    const H = { 'x-admin-key': 'sse-admin' };
    const ac = new AbortController();
    const es = await fetch(`${base}/api/events`, { headers: H, signal: ac.signal });
    const reader = es.body.getReader();
    const events = [];
    let buf = '';
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push([ev, JSON.parse(data)]);
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${base}/api/admin/crawl`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 202);
    for (let i = 0; i < 100 && !events.some(([e]) => e === 'crawl'); i++) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 300)); // 혹시 두 번째 crawl 이벤트가 오는지 잠깐 더 본다
    ac.abort();
    await pump;
    const crawls = events.filter(([e]) => e === 'crawl').map(([, d]) => d);
    assert.equal(crawls.length, 1, JSON.stringify(events));
    const d = crawls[0];
    assert.equal(d.added, 3);
    assert.equal(d.addedPublic, 2, '같은 글 사본은 전체 게시판에서 합쳐진다');
    assert.equal(d.counts.all, 2);
    assert.deepEqual(d.counts.bySource, { humoruniv: 2, dogdrip: 1 });
    assert.equal(typeof d.counts.pick, 'number');
    assert.ok(!('freshIds' in d), '내부용 목록은 내보내지 않음');
    assert.ok(events.some(([e, s]) => e === 'state' && s.running === true), '관리자 연결은 수집 시작 state 를 받는다');
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.boardCounts.all, 2);
  } finally {
    child.kill();
  }
});

test('Ctrl+C(SIGINT)·SIGTERM 으로 끌 때 밀린 변경을 저장하고 끝낸다', async () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const dir = mkTmp('sig');
    // Windows 에서는 다른 프로세스에 신호를 보낼 수 없으므로(강제 종료됨), 자식 프로세스 안에서 신호 이벤트를 낸다
    const code = `
      const store = await import(${JSON.stringify(new URL('../src/store.js', import.meta.url).href)});
      store.upsertPost({ id: 'x:1', title: 't' }); // 1.5초 뒤 저장 예약
      process.emit(${JSON.stringify(sig)});
      setTimeout(() => process.exit(3), 5000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...BASE_ENV, DATA_DIR: dir }, stdio: 'ignore' });
    const exitCode = await new Promise((r) => child.on('exit', r));
    assert.equal(exitCode, 0, sig);
    const saved = JSON.parse(readFileSync(path.join(dir, 'posts.json'), 'utf8'));
    assert.ok(saved.posts['x:1'], `${sig} 때 저장돼야 함`);
  }
});

// =====================================================================
// 2) 수집기 (이 프로세스: 가짜 소스 + 가짜 Claude API)
// =====================================================================

// 가짜 Claude API
let apiMode = 'ok';
let apiCalls = 0;
const fakeApi = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    apiCalls++;
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (apiMode === '429') return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after-ms': '10' });
    if (apiMode === '400') return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } });
    const j = JSON.parse(body);
    const content = String(j.messages?.[0]?.content || '');
    const lines = content.split('\n').filter((l) => /^\d+\. /.test(l));
    const base = { id: 'msg_test', type: 'message', role: 'assistant', model: j.model, usage: { input_tokens: 1, output_tokens: 1 } };
    if (lines.some((l) => l.includes('POISON'))) return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { category: 'test' } });
    const items = lines.map((l) => ({ i: Number(l.split('.')[0]), verdict: 'ok', shortsScore: 70, reason: '웃김' }));
    send(200, { ...base, content: [{ type: 'text', text: JSON.stringify({ items }) }], stop_reason: 'end_turn' });
  });
});

// 가짜 소스 레지스트리 (src/sources/index.js 대신)
globalThis.__beItems = {};
const mkSrc = (id) => ({
  id,
  name: `${id} 테스트`,
  short: id,
  strictness: 'normal',
  imageHosts: [],
  async list(page) {
    return page === 1 ? (globalThis.__beItems[id] || []).map((x) => ({ ...x })) : [];
  },
  async read() {
    throw new Error('테스트에서는 본문을 읽지 않음');
  },
});
globalThis.__beSources = [mkSrc('humoruniv'), mkSrc('dcinside')];
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/sources/index.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const loadErrors = {};' +
          'export async function loadSources() { return globalThis.__beSources; }' +
          'export async function getSource(id) { return globalThis.__beSources.find((s) => s.id === id) || null; }',
      };
    }
    return nextLoad(url, context);
  },
});

let crawler;
let store;
const item = (postId, title) => ({ postId, title, url: `https://example.invalid/${postId}` });

before(async () => {
  await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DATA_DIR: mkTmp('crawl'),
    CRAWL_INTERVAL_MIN: '0',
    AI_MODERATION: '1',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeApi.address().port}`,
    AI_MODEL: 'claude-test',
    AI_BATCH_SIZE: '2',
  });
  crawler = await import('../src/crawler.js');
  store = await import('../src/store.js');
});
after(() => fakeApi.close());

test('수집 1회당 state(running) 와 crawl 이벤트는 한 번씩, addedPublic 은 합쳐진 사본을 빼고 센다', async () => {
  globalThis.__beItems = {
    humoruniv: [item('10', '편의점 알바하다 겪은 웃긴 썰'), item('11', '고양이가 상자에 들어가는 방법')],
    dcinside: [item('1', '고양이가 상자에 들어가는 방법')],
  };
  const seen = [];
  const onState = (s) => seen.push(['state', s.running]);
  const onCrawl = (d) => seen.push(['crawl', d]);
  crawler.events.on('state', onState);
  crawler.events.on('crawl', onCrawl);
  try {
    const [a, b] = await Promise.all([crawler.crawlNow(), crawler.crawlAll()]);
    assert.equal(a, b, '겹친 호출은 같은 수집을 기다린다');
    for (const id of ['humoruniv:10', 'humoruniv:11', 'dcinside:1']) assert.equal(store.getPost(id).status, 'ok', id);
    assert.equal(store.getPost('humoruniv:11').dupOf, 'dcinside:1');
    assert.equal(a.added, 3);
    assert.equal(a.addedPublic, 2);
    const crawls = seen.filter(([k]) => k === 'crawl');
    assert.equal(crawls.length, 1, JSON.stringify(seen));
    assert.equal(crawls[0][1].addedPublic, 2);
    assert.equal(seen.filter(([k, v]) => k === 'state' && v === true).length, 1, JSON.stringify(seen));
    assert.deepEqual(seen[0], ['state', true], '시작할 때 running:true');
    assert.equal(crawler.isRunning(), false);
  } finally {
    crawler.events.off('state', onState);
    crawler.events.off('crawl', onCrawl);
  }
});

test('제목이 바뀌어도 본문 검사로 올라간 판정은 유지하고, 본문은 다시 검사하게 표시', async () => {
  const p = store.getPost('humoruniv:10');
  p.auto = { status: 'adult', reasons: ['본문 성인: 후방'], flags: {} };
  p.bodyChecked = true;
  p.status = store.resolveStatus(p);
  store.upsertPost(p);
  globalThis.__beItems.humoruniv[0].title = '편의점 알바하다 겪은 웃긴 썰 (수정)';
  await crawler.crawlAll();
  const q = store.getPost('humoruniv:10');
  assert.equal(q.status, 'adult');
  assert.ok(q.auto.reasons.includes('본문 성인: 후방'), JSON.stringify(q.auto));
  assert.equal(q.bodyChecked, false);
});

test('Claude 검수: 거절된 묶음은 반으로 나눠 문제 글만 실패로 남긴다', async () => {
  globalThis.__beItems.humoruniv.push(item('20', 'POISON 이상한 글'), item('21', '평범한 웃긴 글 하나'), item('22', '평범한 웃긴 글 둘'));
  apiMode = 'ok';
  apiCalls = 0;
  await crawler.crawlAll();
  const poison = store.getPost('humoruniv:20');
  assert.equal(poison.aiTries, 1);
  assert.equal(poison.aiPending, true);
  assert.ok(Date.parse(poison.aiNextAt) > Date.now(), '다음 시도는 나중에');
  for (const id of ['humoruniv:21', 'humoruniv:22']) assert.equal(store.getPost(id).ai?.verdict, 'ok', id);
  assert.equal(apiCalls, 4); // [20,21] 거절 → [20] 거절, [21] 성공, [22] 성공
});

test('Claude 검수: 429 면 남은 묶음을 보내지 않고 실패로 세지도 않는다', async () => {
  globalThis.__beItems.humoruniv.push(item('30', '웃긴 글 셋'), item('31', '웃긴 글 넷'), item('32', '웃긴 글 다섯'));
  apiMode = '429';
  apiCalls = 0;
  await crawler.crawlAll();
  assert.equal(apiCalls, 2, '첫 묶음 1회 + SDK 재시도 1회, 다음 묶음은 안 보냄');
  for (const id of ['humoruniv:30', 'humoruniv:31', 'humoruniv:32']) {
    const p = store.getPost(id);
    assert.equal(p.aiPending, true, id);
    assert.ok(!p.aiTries, id);
  }
  assert.equal(store.getPost('humoruniv:20').aiTries, 1, '다시 보낼 때가 안 된 글은 보내지 않음');
});

test('Claude 검수: 400(크레딧 부족 등)이면 보낸 묶음만 실패로 세고 멈춘다', async () => {
  apiMode = '400';
  apiCalls = 0;
  await crawler.crawlAll();
  assert.equal(apiCalls, 1);
  const tries = ['humoruniv:30', 'humoruniv:31', 'humoruniv:32'].map((id) => store.getPost(id).aiTries || 0);
  assert.deepEqual(tries, [1, 1, 0]);
  apiMode = 'ok';
});
