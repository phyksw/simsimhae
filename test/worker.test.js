// 공개 사이트(Cloudflare Worker) 단위 테스트: worker/index.js 의 fetch 핸들러를 가짜 env 로 직접 부른다.
// D1 은 node:sqlite 로 흉내 내고(같은 SQLite), ASSETS·원본 이미지 서버도 가짜다. 외부로는 요청을 보내지 않는다.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import workerEntry from '../worker/index.js';
import { createWorker } from '../worker/app.js';
import { PAGE_CSP } from '../worker/http.js';
import { safeEqual, verifyAdult, signAdult, parseCookies, clientKey } from '../worker/auth.js';
import { sniffMedia, hostMatches } from '../worker/img.js';
import { CHUNK_CHARS } from '../worker/store.js';

// node:sqlite 는 Node 22.5 이상에만 있다. 없으면 D1 흉내가 필요한 시험은 건너뛴다.
const { DatabaseSync } = (await import('node:sqlite').catch(() => null)) ?? {};
const test = (name, fn) => nodeTest(name, { skip: DatabaseSync ? false : 'node:sqlite 가 없어요 (Node 22.5 이상)' }, fn);

// ---------------------------------------------------------------------
// 가짜 바인딩
// ---------------------------------------------------------------------

/** D1 흉내: prepare/bind/first/all/run/batch. 실행한 SQL 은 log 에 남는다. hook 은 all() 직전에 불린다. */
class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.log = [];
    this.hook = null;
    this.fail = false;
  }
  prepare(sql) {
    return new FakeStmt(this, sql, []);
  }
  async batch(stmts) {
    if (this.fail) throw new Error('D1 down');
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** 시험용: 직접 조회 */
  rows(sql, ...args) {
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r }));
  }
  count(re) {
    return this.log.filter((s) => re.test(s)).length;
  }
}
class FakeStmt {
  constructor(d1, sql, args) {
    this.d1 = d1;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    for (const a of args) if (a === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
    return new FakeStmt(this.d1, this.sql, args);
  }
  _exec() {
    this.d1.log.push(this.sql);
    const st = this.d1.db.prepare(this.sql);
    if (/^\s*select/i.test(this.sql)) return { success: true, results: st.all(...this.args).map((r) => ({ ...r })), meta: { changes: 0 } };
    const r = st.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
  async first(col) {
    if (this.d1.fail) throw new Error('D1 down');
    const row = this._exec().results[0] ?? null;
    return col ? (row?.[col] ?? null) : row;
  }
  async all() {
    if (this.d1.fail) throw new Error('D1 down');
    await this.d1.hook?.(this.sql, this.args);
    return this._exec();
  }
  async run() {
    if (this.d1.fail) throw new Error('D1 down');
    return this._exec();
  }
}

const fakeAssets = {
  calls: 0,
  async fetch(req) {
    this.calls++;
    return new Response(`<!doctype html><title>${new URL(req.url).pathname}</title>`, { headers: { 'content-type': 'text/html' } });
  },
};

const TOKEN = 'test-publish-token-0123456789abcdef';
const ADULT_PW = 'adult-pw-1234';
const SECRET = 'session-secret-for-tests';
const NOW = Date.parse('2026-10-17T03:00:00.000Z');

function makeEnv(over = {}) {
  return { DB: new FakeD1(), ASSETS: fakeAssets, PUBLISH_TOKEN: TOKEN, ADULT_PASSWORD: ADULT_PW, SESSION_SECRET: SECRET, ...over };
}

/** 요청 하나 보내기. body 가 객체면 JSON 으로. */
async function call(worker, env, path, { method = 'GET', headers = {}, body, token, ip } = {}) {
  const h = new Headers(headers);
  if (token) h.set('authorization', `Bearer ${token}`);
  if (ip) h.set('cf-connecting-ip', ip);
  let b = body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    b = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
  const res = await worker.fetch(new Request(`https://simsimhae.test.workers.dev${path}`, { method, headers: h, body: b }), env, ctx);
  res.ctx = ctx;
  return res;
}
const getJson = async (res) => JSON.parse(await res.text());

// ---------------------------------------------------------------------
// 시험 데이터
// ---------------------------------------------------------------------

const SOURCES = [
  { id: 'dogdrip', name: '개드립 인기글', short: '개드립', color: '#2b3a55', homepage: 'https://www.dogdrip.net/', active: true, imageHosts: ['dogdrip.net'], referer: 'https://www.dogdrip.net/' },
  { id: 'humoruniv', name: '웃대 웃긴자료', short: '웃대', color: '#c33', homepage: 'https://web.humoruniv.com/', active: false, imageHosts: ['.humoruniv.com'], referer: null },
];

/** 글 하나 (n 이 클수록 오래된 글, hot 은 n 순서와 반대가 되게) */
function mkPost(n, o = {}) {
  const at = new Date(NOW - n * 60e3).toISOString();
  return {
    id: `dogdrip:${n}`,
    source: 'dogdrip',
    title: `웃긴 글 ${n}`,
    url: `https://www.dogdrip.net/${n}`,
    postedAt: at,
    firstSeenAt: at,
    commentCount: n,
    views: null,
    likes: 10 * n,
    category: null,
    status: 'ok',
    alsoOn: [],
    boards: ['all', 'dogdrip'],
    hot: n / 100,
    hasRead: false,
    ...o,
  };
}

function baseSnapshot(version = 'v1') {
  return {
    version,
    siteName: '심심풀이',
    lastCrawlAt: '2026-10-17T02:59:40.000Z',
    sources: SOURCES,
    posts: [
      mkPost(1, { boards: ['story', 'pick', 'all', 'dogdrip'], hasRead: true, alsoOn: [{ source: 'humoruniv', url: 'https://web.humoruniv.com/x' }] }),
      mkPost(2, { boards: ['pick', 'all', 'dogdrip'], title: 'Hello 대소문자 글' }),
      mkPost(3),
      mkPost(4, { id: 'humoruniv:4', source: 'humoruniv', url: 'https://web.humoruniv.com/4', boards: ['all', 'humoruniv'] }),
      // 올린 쪽 실수로 공개 게시판이 섞여 있어도 므흣 글은 잠금 게시판에만
      mkPost(5, { status: 'adult', boards: ['adult', 'all', 'pick'], hasRead: true }),
      // 화면에 보이면 안 되는 필드가 섞여 와도 내보내지 않는다
      mkPost(6, { shortsScore: 88, ai: { verdict: 'ok', reason: '운영 메모' }, shorts: { note: '쇼츠 메모' }, manual: 'ok', boards: ['all', 'dogdrip', 'adult', 'filtered'] }),
    ],
  };
}

async function upload(worker, env, snap = baseSnapshot()) {
  const res = await call(worker, env, '/api/sync/snapshot', { method: 'PUT', token: TOKEN, body: snap });
  assert.equal(res.status, 200, await res.clone().text());
  return getJson(res);
}

const READ_DOC = {
  title: '웃긴 글 1 (원문 제목)',
  html: '<p>본문</p><img src="/api/img?s=dogdrip&amp;u=https%3A%2F%2Fimg.dogdrip.net%2Fa.png" loading="lazy">',
  text: '본문\n[이미지]',
  mediaCount: 1,
  comments: [{ author: 'a', text: '댓글', likes: 3, dislikes: null, best: true, reply: false, postedAt: null, images: [] }],
  commentTotal: 42,
  updatedAt: '2026-10-17T03:00:01.000Z',
};

async function putRead(worker, env, id, doc = READ_DOC) {
  return call(worker, env, `/api/sync/read/${encodeURIComponent(id)}`, { method: 'PUT', token: TOKEN, body: doc });
}

async function unlockCookie(worker, env, ip) {
  const res = await call(worker, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW }, ip });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const PUBLIC_ITEM_KEYS = ['alsoOn', 'category', 'commentCount', 'firstSeenAt', 'id', 'likes', 'postedAt', 'source', 'status', 'title', 'url', 'views'];

// ---------------------------------------------------------------------
// 업로드 API
// ---------------------------------------------------------------------

test('업로드: Bearer 토큰이 없거나 틀리면 401, 토큰 설정이 없으면 503', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  for (const [opts, status] of [
    [{}, 401],
    [{ token: 'wrong-token' }, 401],
    [{ headers: { authorization: `Basic ${TOKEN}` } }, 401],
    [{ headers: { authorization: `Bearer ${TOKEN}x` } }, 401],
    [{ token: TOKEN }, 200],
  ]) {
    const res = await call(w, env, '/api/sync/status', opts);
    assert.equal(res.status, status, JSON.stringify(opts));
  }
  const res = await call(w, makeEnv({ PUBLISH_TOKEN: '' }), '/api/sync/status', { token: TOKEN });
  assert.equal(res.status, 503);
  const put = await call(w, env, '/api/sync/snapshot', { method: 'PUT', token: 'nope', body: baseSnapshot() });
  assert.equal(put.status, 401);
  assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM snapshot")[0].n, 0, '인증 실패면 아무것도 쓰지 않는다');
});

test('업로드: 스냅샷 저장 → 상태 확인, 같은 버전은 무시, 형식이 틀리면 400', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  assert.deepEqual(await getJson(await call(w, env, '/api/sync/status', { token: TOKEN })), { version: null, posts: 0, reads: 0, updatedAt: null });

  const r = await upload(w, env);
  assert.deepEqual(r, { ok: true, posts: 6, pruned: 0, skipped: 0 });
  const st = await getJson(await call(w, env, '/api/sync/status', { token: TOKEN }));
  assert.deepEqual(st, { version: 'v1', posts: 6, reads: 0, updatedAt: new Date(NOW).toISOString() });

  const writesBefore = env.DB.count(/^\s*(INSERT|DELETE)/i);
  const again = await upload(w, env);
  assert.equal(again.unchanged, true);
  assert.equal(again.posts, 6);
  assert.equal(env.DB.count(/^\s*(INSERT|DELETE)/i), writesBefore, '같은 버전이면 쓰지 않는다');

  for (const bad of [[], { version: 'x' }, { version: '', sources: [], posts: [] }, { version: 'x', sources: {}, posts: [] }]) {
    const res = await call(w, env, '/api/sync/snapshot', { method: 'PUT', token: TOKEN, body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const res = await call(w, env, '/api/sync/snapshot', { method: 'PUT', token: TOKEN, body: '{"version":', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal((await getJson(res)).error, '잘못된 요청이에요');
});

test('업로드: 잘못된 글은 그 글만 건너뛴다 (주소·상태·id·중복)', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const snap = baseSnapshot('v-bad');
  snap.posts.push(
    mkPost(7, { url: 'javascript:alert(1)' }),
    mkPost(8, { status: 'blocked' }),
    mkPost(9, { id: '' }),
    mkPost(1), // 중복 id
    null,
    mkPost(10, { title: 123 }),
  );
  const r = await upload(w, env, snap);
  assert.equal(r.posts, 6);
  assert.equal(r.skipped, 6);
  const all = await getJson(await call(w, env, '/api/posts?board=all&size=100'));
  assert.ok(!all.items.some((p) => /javascript:/.test(p.url)));
});

test('업로드: 미리보기 저장·크기 제한·형식 확인, 스냅샷에서 빠진 글의 미리보기는 지운다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);
  assert.deepEqual(await getJson(await putRead(w, env, 'dogdrip:1')), { ok: true });
  assert.equal((await putRead(w, env, 'dogdrip:2')).status, 200);
  assert.equal((await putRead(w, env, 'dogdrip:3', { title: 'x' })).status, 400, 'html 이 없으면 400');
  const big = { ...READ_DOC, html: 'x'.repeat(1.5 * 1024 * 1024 + 10) };
  assert.equal((await putRead(w, env, 'dogdrip:3', big)).status, 413);
  assert.equal((await getJson(await call(w, env, '/api/sync/status', { token: TOKEN }))).reads, 2);

  // 저장 형식: 규약의 필드만
  const stored = JSON.parse(env.DB.rows('SELECT json FROM reads WHERE id = ?', 'dogdrip:1')[0].json);
  assert.deepEqual(Object.keys(stored).sort(), ['commentTotal', 'comments', 'html', 'mediaCount', 'text', 'title']);
  assert.equal(env.DB.rows('SELECT updated_at FROM reads WHERE id = ?', 'dogdrip:1')[0].updated_at, READ_DOC.updatedAt);

  const snap2 = baseSnapshot('v2');
  snap2.posts = snap2.posts.filter((p) => p.id !== 'dogdrip:2');
  const r = await upload(w, env, snap2);
  assert.equal(r.pruned, 1);
  assert.deepEqual(env.DB.rows('SELECT id FROM reads').map((x) => x.id), ['dogdrip:1']);
});

test('업로드: 큰 스냅샷은 D1 한 행 상한 아래로 나눠 저장하고 그대로 다시 읽는다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const snap = baseSnapshot('big');
  snap.posts = Array.from({ length: 2500 }, (_, i) => mkPost(i + 1, { title: `${'가'.repeat(300)} ${i + 1}` }));
  const r = await upload(w, env, snap);
  assert.equal(r.posts, 2500);
  const rows = env.DB.rows("SELECT k, length(CAST(json AS BLOB)) AS bytes, length(json) AS chars FROM snapshot WHERE k <> 'main'");
  assert.ok(rows.length >= 3, `묶음 ${rows.length}개`);
  for (const x of rows) {
    assert.ok(x.chars <= CHUNK_CHARS);
    assert.ok(x.bytes < 2_000_000, `${x.k} ${x.bytes} bytes`);
  }
  const seen = new Set();
  for (let page = 1; ; page++) {
    const d = await getJson(await call(w, env, `/api/posts?board=all&size=100&page=${page}`));
    assert.equal(d.total, 2500);
    d.items.forEach((p) => seen.add(p.id));
    if (!d.hasMore) break;
  }
  assert.equal(seen.size, 2500);
});

// ---------------------------------------------------------------------
// 방문자 API
// ---------------------------------------------------------------------

test('방문자: 업로드 전에도 메타·목록이 빈 상태로 동작한다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const m = await getJson(await call(w, env, '/api/meta'));
  assert.deepEqual(m, {
    siteName: '심심풀이',
    mode: 'public',
    pickCount: 0,
    boardCounts: { story: 0, pick: 0, all: 0 },
    adult: false,
    admin: false,
    live: { live: true, lastCrawlAt: null },
    sources: [],
  });
  const p = await getJson(await call(w, env, '/api/posts?board=story'));
  assert.deepEqual(p, { board: 'story', sort: 'new', page: 1, size: 30, total: 0, hasMore: false, items: [] });
  assert.equal((await call(w, env, '/api/posts/dogdrip%3A1/read')).status, 404);
  assert.equal((await call(w, env, '/api/img?s=dogdrip&u=https%3A%2F%2Fdogdrip.net%2Fa.png')).status, 403);
});

test('방문자: /api/meta 는 로컬 서버와 같은 모양 + mode "public", 게시판 수는 목록 total 과 같다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);
  const m = await getJson(await call(w, env, '/api/meta'));
  assert.equal(m.mode, 'public');
  assert.equal(m.admin, false);
  assert.equal(m.adult, false);
  assert.equal(m.siteName, '심심풀이');
  assert.deepEqual(m.live, { live: true, lastCrawlAt: '2026-10-17T02:59:40.000Z' });
  assert.deepEqual(m.boardCounts, { story: 1, pick: 2, all: 5 });
  assert.equal(m.pickCount, 2);
  assert.deepEqual(m.sources, [
    { id: 'dogdrip', name: '개드립 인기글', short: '개드립', color: '#2b3a55', homepage: 'https://www.dogdrip.net/', active: true, count: 4 },
    { id: 'humoruniv', name: '웃대 웃긴자료', short: '웃대', color: '#c33', homepage: 'https://web.humoruniv.com/', active: false, count: 1 },
  ]);
  for (const board of ['story', 'pick', 'all', 'dogdrip', 'humoruniv']) {
    const d = await getJson(await call(w, env, `/api/posts?board=${board}`));
    const expected = board in m.boardCounts ? m.boardCounts[board] : m.sources.find((s) => s.id === board).count;
    assert.equal(d.total, expected, board);
  }
});

test('방문자: 목록 — 게시판·정렬·쪽·검색, 내보내는 필드는 규약의 것만', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);

  const all = await getJson(await call(w, env, '/api/posts?board=all'));
  assert.equal(all.board, 'all');
  assert.equal(all.sort, 'new');
  assert.deepEqual(all.items.map((p) => p.id), ['dogdrip:1', 'dogdrip:2', 'dogdrip:3', 'humoruniv:4', 'dogdrip:6']);
  for (const p of all.items) assert.deepEqual(Object.keys(p).sort(), PUBLIC_ITEM_KEYS);
  assert.deepEqual(all.items[0].alsoOn, [{ source: 'humoruniv', url: 'https://web.humoruniv.com/x' }]);
  assert.ok(!all.items.some((p) => p.status === 'adult'), '므흣 글은 전체 게시판에 없다');

  const hot = await getJson(await call(w, env, '/api/posts?board=all&sort=hot'));
  assert.equal(hot.sort, 'hot');
  assert.deepEqual(hot.items.map((p) => p.id), ['dogdrip:6', 'humoruniv:4', 'dogdrip:3', 'dogdrip:2', 'dogdrip:1']);
  assert.equal((await getJson(await call(w, env, '/api/posts?board=all&sort=shorts'))).sort, 'new');

  const paged = await getJson(await call(w, env, '/api/posts?board=all&size=1&page=1'));
  assert.equal(paged.size, 5, 'size 는 5~100');
  assert.equal(paged.hasMore, false);
  assert.equal((await getJson(await call(w, env, '/api/posts?board=all&size=1000'))).size, 100);
  const p0 = await getJson(await call(w, env, '/api/posts?board=all&page=0&size=abc'));
  assert.equal(p0.page, 1);
  assert.equal(p0.size, 30);
  const p2 = await getJson(await call(w, env, '/api/posts?board=all&size=5&page=2'));
  assert.equal(p2.items.length, 0);
  assert.equal(p2.total, 5);

  const q = await getJson(await call(w, env, `/api/posts?board=all&q=${encodeURIComponent('  HELLO ')}`));
  assert.deepEqual(q.items.map((p) => p.id), ['dogdrip:2']);
  assert.equal(q.total, 1);

  const none = await getJson(await call(w, env, '/api/posts?board=nosuchsource'));
  assert.equal(none.total, 0);
  const def = await getJson(await call(w, env, '/api/posts'));
  assert.equal(def.board, 'all');
  assert.equal(def.total, 5);
});

test('방문자: 인기순은 게시판별 점수(hotIn)가 있으면 그 게시판에서만 그것으로, 같은 점수는 최신순', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const snap = baseSnapshot('v-hotin');
  const P = (n, o) => mkPost(n, { boards: ['story', 'all', 'dogdrip'], ...o });
  snap.posts = [
    // hot(출처별 게시판 점수)으로는 3 > 2 > 1, 전체 게시판 점수로는 1 > 2 > 3, 썰 게시판 점수는 2 > 1 = 3(같으면 최신순)
    P(1, { hot: 0.1, hotIn: { all: 0.9, story: 0.3 } }),
    P(2, { hot: 0.2, hotIn: { all: 0.5, story: 0.8 } }),
    P(3, { hot: 0.3, hotIn: { all: 0.1, story: 0.3 } }),
    // 점수가 없거나 잘못된 게시판·값은 hot 으로 (이 글이 나오지 않는 게시판 점수는 버린다)
    P(4, { hot: 0.05, hotIn: { all: 'x', pick: 0.99, story: null }, boards: ['story', 'all', 'dogdrip'] }),
    P(5, { hot: 0.4, hotIn: [0.9] }),
    // 므흣 글은 hotIn 이 와도 잠금 게시판 하나뿐이다
    P(6, { status: 'adult', hot: 0.7, hotIn: { all: 1 } }),
  ];
  await upload(w, env, snap);
  const ids = async (q) => (await getJson(await call(w, env, `/api/posts?${q}`))).items.map((p) => p.id);
  assert.deepEqual(await ids('board=dogdrip&sort=hot'), ['dogdrip:5', 'dogdrip:3', 'dogdrip:2', 'dogdrip:1', 'dogdrip:4']);
  assert.deepEqual(await ids('board=all&sort=hot'), ['dogdrip:1', 'dogdrip:2', 'dogdrip:5', 'dogdrip:3', 'dogdrip:4']);
  assert.deepEqual(await ids('board=story&sort=hot'), ['dogdrip:2', 'dogdrip:5', 'dogdrip:1', 'dogdrip:3', 'dogdrip:4']);
  assert.deepEqual(await ids('board=pick&sort=hot'), [], 'pick 점수만 있다고 그 게시판에 들어가지는 않는다');
  assert.deepEqual(await ids('board=all'), ['dogdrip:1', 'dogdrip:2', 'dogdrip:3', 'dogdrip:4', 'dogdrip:5'], '최신순은 그대로');

  // 저장 형식: hotIn 은 이 글의 게시판 것 중 숫자만, 하나도 없으면 넣지 않는다 (예전 형식과 같은 5칸)
  const recs = env.DB.rows("SELECT json FROM snapshot WHERE k <> 'main'").flatMap((r) => JSON.parse(r.json));
  const rec = (id) => recs.find((r) => r[0].id === id);
  assert.deepEqual(rec('dogdrip:1')[5], { story: 0.3, all: 0.9 });
  assert.equal(rec('dogdrip:4').length, 5);
  assert.equal(rec('dogdrip:5').length, 5);
  assert.equal(rec('dogdrip:6').length, 5);
  assert.deepEqual(rec('dogdrip:6')[1], ['adult']);
  // 방문자에게는 점수를 내보내지 않는다
  const items = (await getJson(await call(w, env, '/api/posts?board=all&sort=hot'))).items;
  for (const p of items) assert.deepEqual(Object.keys(p).sort(), PUBLIC_ITEM_KEYS);
});

test('방문자: 관리자 게시판은 401, 잠금 게시판은 잠금 해제 전 403', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);
  for (const board of ['filtered', 'shorts']) {
    const res = await call(w, env, `/api/posts?board=${board}`);
    assert.equal(res.status, 401);
    assert.equal((await getJson(res)).error, '관리자 전용');
  }
  const res = await call(w, env, '/api/posts?board=adult');
  assert.equal(res.status, 403);
  assert.deepEqual(await getJson(res), { error: 'locked' });
});

test('방문자: 미리보기 — 모양, 준비 안 된 글, 없는 글, 잠긴 글', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);
  await putRead(w, env, 'dogdrip:1');
  await putRead(w, env, 'dogdrip:5');

  const res = await call(w, env, `/api/posts/${encodeURIComponent('dogdrip:1')}/read`);
  assert.equal(res.status, 200);
  const d = await getJson(res);
  assert.deepEqual(Object.keys(d).sort(), ['commentTotal', 'comments', 'html', 'mediaCount', 'post', 'statusChanged', 'text', 'title']);
  assert.equal(d.statusChanged, false);
  assert.equal(d.title, READ_DOC.title);
  assert.equal(d.html, READ_DOC.html);
  assert.equal(d.text, READ_DOC.text);
  assert.equal(d.mediaCount, 1);
  assert.equal(d.commentTotal, 42);
  assert.deepEqual(d.comments, READ_DOC.comments);
  assert.equal(d.post.id, 'dogdrip:1');
  assert.deepEqual(Object.keys(d.post).sort(), PUBLIC_ITEM_KEYS);

  const notReady = await call(w, env, '/api/posts/dogdrip%3A2/read');
  assert.equal(notReady.status, 404);
  assert.deepEqual(await getJson(notReady), { error: '미리보기를 준비 중이에요', url: 'https://www.dogdrip.net/2' });

  const missing = await call(w, env, '/api/posts/dogdrip%3A999/read');
  assert.equal(missing.status, 404);
  assert.match((await getJson(missing)).error, /찾을 수 없어요/);

  assert.equal((await call(w, env, '/api/posts/%E0%A4%A/read')).status, 400, '깨진 %-인코딩');

  const locked = await call(w, env, '/api/posts/dogdrip%3A5/read');
  assert.equal(locked.status, 403);
  assert.deepEqual(await getJson(locked), { error: 'locked' });
  const cookie = await unlockCookie(w, env);
  const opened = await call(w, env, '/api/posts/dogdrip%3A5/read', { headers: { cookie } });
  assert.equal(opened.status, 200);
  assert.equal((await getJson(opened)).post.status, 'adult');
});

test('방문자: 특수문자가 든 id 도 업로드·미리보기가 맞물린다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const id = 'dcinside:hit/12?x=1&y=가#z';
  const snap = baseSnapshot('v-id');
  snap.posts.push(mkPost(11, { id, hasRead: true }));
  await upload(w, env, snap);
  assert.equal((await putRead(w, env, id)).status, 200);
  const d = await getJson(await call(w, env, `/api/posts/${encodeURIComponent(id)}/read`));
  assert.equal(d.post.id, id);
});

// ---------------------------------------------------------------------
// 잠금 (므흣)
// ---------------------------------------------------------------------

test('잠금: JSON 만 받고, 맞으면 규약대로 서명한 쿠키를 준다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);

  const form = await call(w, env, '/api/unlock', { method: 'POST', body: `password=${ADULT_PW}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const broken = await call(w, env, '/api/unlock', { method: 'POST', body: '{"password":', headers: { 'content-type': 'application/json' } });
  assert.equal(broken.status, 400);
  const wrong = await call(w, env, '/api/unlock', { method: 'POST', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await getJson(wrong), { error: '비밀번호가 달라요' });
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal((await call(w, env, '/api/unlock', { method: 'POST', body: { password: 12345 } })).status, 401);

  const ok = await call(w, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await getJson(ok), { ok: true });
  const sc = ok.headers.get('set-cookie');
  const m = /^hg_adult=adult:(\d+)\.([A-Za-z0-9_-]{43}); Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200$/.exec(sc);
  assert.ok(m, sc);
  assert.equal(Number(m[1]), NOW + 12 * 3600e3);
  assert.equal(m[2], createHmac('sha256', SECRET).update(`adult:${m[1]}`).digest('base64url'), '규약: HMAC-SHA256(SESSION_SECRET, "adult:<만료ms>")');

  const cookie = sc.split(';')[0];
  const meta = await getJson(await call(w, env, '/api/meta', { headers: { cookie } }));
  assert.equal(meta.adult, true);
  assert.deepEqual(meta.boardCounts, { story: 1, pick: 2, all: 5, adult: 1 });
  const adult = await getJson(await call(w, env, '/api/posts?board=adult', { headers: { cookie } }));
  assert.deepEqual(adult.items.map((p) => p.id), ['dogdrip:5']);

  const lock = await call(w, env, '/api/lock', { method: 'POST', body: {} });
  assert.equal(lock.status, 200);
  assert.equal(lock.headers.get('set-cookie'), 'hg_adult=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0');
  assert.equal((await call(w, env, '/api/lock', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('잠금: 위조·만료·다른 비밀로 서명한 쿠키는 통하지 않는다', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(w, env);
  const exp = NOW + 3600e3;
  const sig = (secret, v) => createHmac('sha256', secret).update(v).digest('base64url');
  const cases = {
    good: `adult:${exp}.${sig(SECRET, `adult:${exp}`)}`,
    otherSecret: `adult:${exp}.${sig('other', `adult:${exp}`)}`,
    tampered: `adult:${exp + 1}.${sig(SECRET, `adult:${exp}`)}`,
    expired: `adult:${NOW - 1}.${sig(SECRET, `adult:${NOW - 1}`)}`,
    tooFar: `adult:${NOW + 48 * 3600e3}.${sig(SECRET, `adult:${NOW + 48 * 3600e3}`)}`,
    adminKind: `admin:${exp}.${sig(SECRET, `admin:${exp}`)}`,
    junk: 'adult:abc.def',
  };
  for (const [name, token] of Object.entries(cases)) {
    const m = await getJson(await call(w, env, '/api/meta', { headers: { cookie: `x=1; hg_adult=${token}` } }));
    assert.equal(m.adult, name === 'good', name);
  }
  // 퍼센트 인코딩된 값도 받는다 (로컬 서버처럼)
  const enc = await getJson(await call(w, env, '/api/meta', { headers: { cookie: `hg_adult=${encodeURIComponent(cases.good)}` } }));
  assert.equal(enc.adult, true);
  // SESSION_SECRET 이 없으면 아무것도 통하지 않는다
  const noSecret = await getJson(await call(createWorker({ now: () => NOW }), makeEnv({ SESSION_SECRET: '' }), '/api/meta', { headers: { cookie: `hg_adult=${cases.good}` } }));
  assert.equal(noSecret.adult, false);
});

test('잠금: 접속자당 10번 틀리면 10분 동안 막고, 비밀번호 설정이 없으면 503', async () => {
  let now = NOW;
  const w = createWorker({ now: () => now });
  const env = makeEnv();
  for (let i = 0; i < 10; i++) assert.equal((await call(w, env, '/api/unlock', { method: 'POST', body: { password: 'x' }, ip: '203.0.113.7' })).status, 401);
  const blocked = await call(w, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW }, ip: '203.0.113.7' });
  assert.equal(blocked.status, 429);
  assert.equal((await call(w, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW }, ip: '198.51.100.1' })).status, 200, '다른 접속자는 괜찮다');
  // IPv6 는 /64 로 묶는다
  for (let i = 0; i < 10; i++) await call(w, env, '/api/unlock', { method: 'POST', body: { password: 'x' }, ip: `2001:db8:1:2::${i + 1}` });
  assert.equal((await call(w, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW }, ip: '2001:db8:1:2:ffff::1' })).status, 429);
  now += 10 * 60e3 + 1;
  assert.equal((await call(w, env, '/api/unlock', { method: 'POST', body: { password: ADULT_PW }, ip: '203.0.113.7' })).status, 200, '10분 뒤엔 풀린다');

  assert.equal((await call(w, makeEnv({ ADULT_PASSWORD: '' }), '/api/unlock', { method: 'POST', body: { password: '' } })).status, 503);
  assert.equal((await call(w, makeEnv({ SESSION_SECRET: undefined }), '/api/unlock', { method: 'POST', body: { password: ADULT_PW } })).status, 503);
});

// ---------------------------------------------------------------------
// 캐시 (isolate 메모리)
// ---------------------------------------------------------------------

test('캐시: 요청마다 버전만 확인하고, 글 목록은 버전이 바뀔 때만 다시 읽는다', async () => {
  const uploader = createWorker({ now: () => NOW });
  const visitor = createWorker({ now: () => NOW }); // 다른 isolate
  const env = makeEnv();
  await upload(uploader, env);
  const chunkQ = /k <> 'main'/;
  const versionQ = /CASE WHEN version = \?/;
  const metaQ = () => env.DB.log.filter((s) => versionQ.test(s)).length;

  await call(visitor, env, '/api/posts?board=all');
  await call(visitor, env, '/api/posts?board=pick&sort=hot');
  await call(visitor, env, '/api/meta');
  await call(visitor, env, '/api/posts/dogdrip%3A1/read');
  assert.equal(env.DB.rows("SELECT 1 FROM snapshot").length > 0, true);
  assert.equal(env.DB.log.filter((s) => chunkQ.test(s) && /SELECT/.test(s)).length, 1, '글 묶음은 한 번만 읽는다');
  assert.equal(metaQ(), 4, '요청마다 버전 확인 한 번');

  const snap = baseSnapshot('v2');
  snap.posts[0].title = '바뀐 제목';
  await upload(uploader, env, snap);
  const d = await getJson(await call(visitor, env, '/api/posts?board=all'));
  assert.equal(d.items[0].title, '바뀐 제목');
  assert.equal(env.DB.log.filter((s) => chunkQ.test(s) && /SELECT/.test(s)).length, 2);
  // 스키마는 isolate 마다 한 번
  assert.equal(env.DB.count(/CREATE TABLE IF NOT EXISTS snapshot/), 2, '업로드용·방문자용 isolate 각 한 번');
});

test('캐시: 머리를 읽은 뒤 새 업로드가 끼어들면 다시 읽어 새 버전을 보여준다', async () => {
  const uploader = createWorker({ now: () => NOW });
  const visitor = createWorker({ now: () => NOW });
  const env = makeEnv();
  await upload(uploader, env);
  let raced = false;
  env.DB.hook = async (sql, args) => {
    if (!raced && /k <> 'main'/.test(sql) && args[0] === 'v1') {
      raced = true;
      env.DB.hook = null;
      const snap = baseSnapshot('v2');
      snap.posts[0].title = '끼어든 업로드';
      await upload(uploader, env, snap);
    }
  };
  const d = await getJson(await call(visitor, env, '/api/posts?board=all'));
  assert.ok(raced);
  assert.equal(d.items[0].title, '끼어든 업로드');
});

// ---------------------------------------------------------------------
// 이미지 프록시
// ---------------------------------------------------------------------

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 56 }, (_, i) => i)]);
const REST = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);

/** 두 조각으로 오는 본문 (앞부분만 읽고 나머지는 흘려보내는지 보려고) */
function chunked(...parts) {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

/** 가짜 원본 서버: routes[url] = () => Response. 받은 요청은 calls 에 */
function fakeUpstream(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    return r(init);
  };
  fn.calls = calls;
  return fn;
}

async function imgWorker(routes) {
  const upstream = fakeUpstream(routes);
  const w = createWorker({ now: () => NOW, fetch: upstream });
  const env = makeEnv();
  await upload(w, env);
  const get = (s, u, opts) => call(w, env, `/api/img?s=${encodeURIComponent(s)}&u=${encodeURIComponent(u)}`, opts);
  return { w, env, upstream, get };
}

test('이미지: 허용 호스트만, 앞부분으로 형식 판별 후 나머지는 그대로 흘린다', async () => {
  const total = PNG.length + REST.length;
  const { upstream, get } = await imgWorker({
    'https://img.dogdrip.net/a.png': () => new Response(chunked(PNG, REST), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total), etag: '"e1"' } }),
  });
  const res = await get('dogdrip', 'https://img.dogdrip.net/a.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), String(total));
  assert.equal(res.headers.get('etag'), '"e1"');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, total);
  assert.deepEqual(body.subarray(0, PNG.length), PNG);
  assert.deepEqual(body.subarray(PNG.length), REST);
  await Promise.all(res.ctx.pending);
  // 원본에는 출처의 Referer·브라우저 UA 로, 리다이렉트는 직접 따라가게
  const init = upstream.calls[0].init;
  assert.equal(init.headers.referer, 'https://www.dogdrip.net/');
  assert.match(init.headers['user-agent'], /Mozilla/);
  assert.equal(init.redirect, 'manual');
});

test('이미지: 허용 안 된 호스트·이상한 주소는 원본에 요청하지 않고 403/400', async () => {
  const { upstream, get } = await imgWorker({});
  for (const [s, u, status] of [
    ['dogdrip', 'https://evil.example.com/a.png', 403],
    ['dogdrip', 'https://evil-dogdrip.net/a.png', 403],
    ['dogdrip', 'https://dogdrip.net.evil.com/a.png', 403],
    ['dogdrip', 'https://user:pw@dogdrip.net/a.png', 403],
    ['dogdrip', 'ftp://dogdrip.net/a.png', 403],
    ['dogdrip', 'javascript:alert(1)', 403],
    ['nosuch', 'https://dogdrip.net/a.png', 403],
    ['', 'https://dogdrip.net/a.png', 403],
    ['dogdrip', 'not a url', 400],
    ['dogdrip', '', 400],
  ]) {
    const res = await get(s, u);
    assert.equal(res.status, status, `${s} ${u}`);
  }
  assert.equal(upstream.calls.length, 0);
});

test('이미지: 리다이렉트는 매번 허용 호스트인지 확인하고 최대 3번만 따라간다', async () => {
  const redirect = (to) => () => new Response(null, { status: 302, headers: { location: to } });
  const { upstream, get } = await imgWorker({
    'https://dogdrip.net/r1': redirect('https://img.dogdrip.net/r2'),
    'https://img.dogdrip.net/r2': redirect('/final.png'),
    'https://img.dogdrip.net/final.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    'https://dogdrip.net/ssrf': redirect('http://169.254.169.254/latest/meta-data'),
    'https://dogdrip.net/l0': redirect('https://dogdrip.net/l1'),
    'https://dogdrip.net/l1': redirect('https://dogdrip.net/l2'),
    'https://dogdrip.net/l2': redirect('https://dogdrip.net/l3'),
    'https://dogdrip.net/l3': redirect('https://dogdrip.net/l4'),
  });
  const ok = await get('dogdrip', 'https://dogdrip.net/r1');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), PNG);

  upstream.calls.length = 0;
  const ssrf = await get('dogdrip', 'https://dogdrip.net/ssrf');
  assert.equal(ssrf.status, 403);
  assert.deepEqual(upstream.calls.map((c) => c.url), ['https://dogdrip.net/ssrf']);

  upstream.calls.length = 0;
  const loop = await get('dogdrip', 'https://dogdrip.net/l0');
  assert.equal(loop.status, 508);
  assert.equal(upstream.calls.length, 4);
});

test('이미지: SVG·HTML 은 거부, 원본 오류는 404/502, 너무 크면 413', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = new TextEncoder().encode('<!doctype html><html><script>alert(1)</script></html>');
  const { get } = await imgWorker({
    'https://dogdrip.net/a.svg': () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } }),
    'https://dogdrip.net/fake.png': () => new Response(html, { headers: { 'content-type': 'image/png' } }),
    'https://dogdrip.net/page': () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    'https://dogdrip.net/err': () => new Response('x', { status: 500, headers: { 'content-type': 'image/png' } }),
    'https://dogdrip.net/huge.mp4': () => new Response(PNG, { headers: { 'content-type': 'video/mp4', 'content-length': String(81 * 1024 * 1024) } }),
    'https://dogdrip.net/throws': () => {
      throw new Error('network');
    },
  });
  assert.equal((await get('dogdrip', 'https://dogdrip.net/a.svg')).status, 415);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/fake.png')).status, 415);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/page')).status, 415);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/missing')).status, 404);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/err')).status, 502);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/huge.mp4')).status, 413);
  assert.equal((await get('dogdrip', 'https://dogdrip.net/throws')).status, 504);
});

test('이미지: Range 요청을 넘기고, 중간 구간은 원래 영상 형식으로', async () => {
  const mid = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
  const { upstream, get } = await imgWorker({
    'https://dogdrip.net/v.mp4': (init) =>
      new Response(mid, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 1000-1999/5000`, 'content-length': '1000', 'accept-ranges': 'bytes', 'x-range': init.headers.range } }),
  });
  const res = await get('dogdrip', 'https://dogdrip.net/v.mp4', { headers: { range: 'bytes=1000-1999' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-range'), 'bytes 1000-1999/5000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), mid);
  assert.equal(upstream.calls[0].init.headers.range, 'bytes=1000-1999');
  // 이상한 Range 는 넘기지 않는다
  await get('dogdrip', 'https://dogdrip.net/v.mp4', { headers: { range: 'bytes=0-1\r\nx: y' } }).catch(() => {});
  await get('dogdrip', 'https://dogdrip.net/v.mp4', { headers: { range: 'items=1-2' } });
  assert.equal(upstream.calls.at(-1).init.headers.range, undefined);
});

test('이미지: 접속자당 분당 600번을 넘으면 429', async () => {
  const { get } = await imgWorker({});
  for (let i = 0; i < 600; i++) assert.equal((await get('dogdrip', 'https://evil.example.com/x', { ip: '203.0.113.9' })).status, 403);
  const res = await get('dogdrip', 'https://evil.example.com/x', { ip: '203.0.113.9' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.equal((await get('dogdrip', 'https://evil.example.com/x', { ip: '203.0.113.10' })).status, 403);
});

test('이미지: Cache API 가 있으면 전체 응답을 넣어 두고 다음엔 원본에 가지 않는다', async () => {
  const store = new Map();
  const prev = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(req) {
        const r = store.get(req.url);
        return r ? r.clone() : undefined;
      },
      async put(req, res) {
        store.set(req.url, new Response(await res.arrayBuffer(), res));
      },
    },
  };
  try {
    const { upstream, get } = await imgWorker({
      'https://dogdrip.net/c.png': () => new Response(chunked(PNG, REST), { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length + REST.length) } }),
    });
    const first = await get('dogdrip', 'https://dogdrip.net/c.png');
    const a = new Uint8Array(await first.arrayBuffer());
    await Promise.all(first.ctx.pending);
    assert.equal(store.size, 1);
    const second = await get('dogdrip', 'https://dogdrip.net/c.png');
    assert.equal(second.status, 200);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), a);
    assert.equal(second.headers.get('content-type'), 'image/png');
    assert.equal(upstream.calls.length, 1);
    // 범위 요청은 캐시를 쓰지 않는다
    await get('dogdrip', 'https://dogdrip.net/c.png', { headers: { range: 'bytes=0-10' } });
    assert.equal(upstream.calls.length, 2);
  } finally {
    globalThis.caches = prev;
  }
});

// ---------------------------------------------------------------------
// 그 밖의 경로·보안 헤더·오류
// ---------------------------------------------------------------------

test('경로: 실시간 연결·관리자 API 는 없고(404 JSON), 화면 파일은 ASSETS 로', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  for (const [method, path] of [
    ['GET', '/api/events'],
    ['POST', '/api/admin/login'],
    ['GET', '/api/admin/review-queue'],
    ['GET', '/api/nope'],
    ['GET', '/api/unlock'],
    ['DELETE', '/api/posts'],
  ]) {
    const res = await call(w, env, path, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(await getJson(res), { error: 'not found' });
  }
  const sync404 = await call(w, env, '/api/sync/nope', { token: TOKEN });
  assert.equal(sync404.status, 404);

  const before = fakeAssets.calls;
  const page = await call(w, env, '/index.html');
  assert.equal(page.status, 200);
  assert.equal(fakeAssets.calls, before + 1);
  assert.equal(page.headers.get('content-security-policy'), PAGE_CSP);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('보안 헤더: JSON 응답에도 로컬 서버와 같은 CSP·Referrer-Policy·nosniff', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  const res = await call(w, env, '/api/meta');
  assert.equal(res.headers.get('content-security-policy'), PAGE_CSP);
  assert.match(PAGE_CSP, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  // 바꿀 수 없는 헤더(fetch·캐시 응답)도 감싸서 붙인다
  const frozen = createWorker({ now: () => NOW });
  const immutableAssets = { fetch: async () => Response.redirect('https://simsimhae.test.workers.dev/', 302) };
  const r2 = await call(frozen, makeEnv({ ASSETS: immutableAssets }), '/old');
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('x-content-type-options'), 'nosniff');
});

test('보안 헤더: 화면 파일(public/)은 Worker 를 거치지 않으므로 public/_headers 가 같은 헤더를 모든 경로에 붙인다', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  // _headers 형식: 경로 줄 다음에 들여쓴 "이름: 값" 줄들
  const blocks = new Map();
  let cur = null;
  for (const line of rules.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) blocks.set(line.trim(), (cur = new Map()));
    else {
      const i = line.indexOf(':');
      cur.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  const all = blocks.get('/*');
  assert.ok(all, '/* 규칙');
  assert.equal(all.get('content-security-policy'), PAGE_CSP);
  assert.equal(all.get('referrer-policy'), 'no-referrer');
  assert.equal(all.get('x-content-type-options'), 'nosniff');
});

test('배포 설정(wrangler.jsonc): 진입점·화면 파일·D1 바인딩이 코드와 맞고, 자리표시 id 가 없다', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')); // 줄 전체 주석만 쓴다
  assert.equal(cfg.name, 'simsimhae');
  assert.equal(cfg.main, 'worker/index.js');
  assert.equal(cfg.workers_dev, true);
  assert.equal(cfg.assets.directory, './public');
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*']);
  assert.equal(cfg.d1_databases.length, 1);
  const d1 = cfg.d1_databases[0];
  assert.equal(d1.binding, 'DB');
  assert.equal(d1.database_name, 'simsimhae');
  // 비워 두면 배포 때 wrangler 가 찾아 연결하거나 만든다. 적는다면 진짜 id(UUID)여야 GitHub 자동 배포가 깨지지 않는다.
  if ('database_id' in d1) assert.match(d1.database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(!/"(PUBLISH_TOKEN|ADULT_PASSWORD|SESSION_SECRET)"\s*:/.test(raw), '비밀은 설정 파일에 쓰지 않는다');
});

test('오류: D1 이 실패하면 내부 정보 없이 500 JSON', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  env.DB.fail = true;
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await call(w, env, '/api/meta');
    assert.equal(res.status, 500);
    assert.deepEqual(await getJson(res), { error: '서버 오류가 났어요' });
  } finally {
    console.error = orig;
  }
  // 실패한 스키마 준비는 다음 요청에서 다시 한다
  env.DB.fail = false;
  assert.equal((await call(w, env, '/api/meta')).status, 200);
});

test('진입점: worker/index.js 의 기본 내보내기로 업로드·목록이 돈다', async () => {
  const env = makeEnv();
  const r = await call(workerEntry, env, '/api/sync/snapshot', { method: 'PUT', token: TOKEN, body: baseSnapshot('entry') });
  assert.equal(r.status, 200);
  const d = await getJson(await call(workerEntry, env, '/api/posts?board=story'));
  assert.deepEqual(d.items.map((p) => p.id), ['dogdrip:1']);
});

// ---------------------------------------------------------------------
// 도우미 단위
// ---------------------------------------------------------------------

nodeTest('도우미: 상수 시간 비교·쿠키 서명·쿠키 해석·접속자 키', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', 'abcd'), false);
  assert.equal(await safeEqual('', ''), true);
  const token = await signAdult('s3cret', NOW);
  assert.equal(await verifyAdult('s3cret', token, NOW + 1000), true);
  assert.equal(await verifyAdult('s3cret', token, NOW + 12 * 3600e3 + 1), false);
  assert.equal(await verifyAdult('other', token, NOW), false);
  assert.equal(await verifyAdult('', token, NOW), false);
  assert.equal(await verifyAdult('s3cret', `${token}x`, NOW), false);
  const c = parseCookies('a=1; hg_adult=%E0%A4%A; a=2; b=x%20y');
  assert.equal(c.get('a'), '1');
  assert.equal(c.get('hg_adult'), '%E0%A4%A');
  assert.equal(c.get('b'), 'x y');
  const req = (ip) => new Request('https://x/', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
  assert.equal(clientKey(req('203.0.113.5')), '203.0.113.5');
  assert.equal(clientKey(req('2001:DB8:1:2:3:4:5:6')), '2001:0db8:0001:0002::/64');
  assert.equal(clientKey(req('::ffff:192.0.2.1')), '192.0.2.1');
  assert.equal(clientKey(req()), 'unknown');
});

nodeTest('도우미: 형식 판별·호스트 일치 (로컬 서버와 같은 규칙)', () => {
  const b = (...xs) => Uint8Array.from([...xs, ...Array(16).fill(0)]);
  const s = (str) => b(...[...str].map((ch) => ch.charCodeAt(0)));
  assert.equal(sniffMedia(b(0xff, 0xd8, 0xff)), 'image/jpeg');
  assert.equal(sniffMedia(PNG), 'image/png');
  assert.equal(sniffMedia(s('GIF89a')), 'image/gif');
  assert.equal(sniffMedia(s('RIFF\0\0\0\0WEBP')), 'image/webp');
  assert.equal(sniffMedia(s('\0\0\0\x20ftypavif')), 'image/avif');
  assert.equal(sniffMedia(s('\0\0\0\x20ftypisom')), 'video/mp4');
  assert.equal(sniffMedia(s('\0\0\0\x20ftypqt  ')), 'video/quicktime');
  assert.equal(sniffMedia(b(0x1a, 0x45, 0xdf, 0xa3)), 'video/webm');
  assert.equal(sniffMedia(s('<svg xmlns=')), null);
  assert.equal(sniffMedia(s('<!doctype html>')), null);
  assert.equal(sniffMedia(Uint8Array.from([0xff, 0xd8])), null, '너무 짧으면 판별하지 않는다');
  assert.equal(hostMatches('img.dogdrip.net', ['dogdrip.net']), true);
  assert.equal(hostMatches('DOGDRIP.NET', ['.dogdrip.net']), true);
  assert.equal(hostMatches('evildogdrip.net', ['dogdrip.net']), false);
  assert.equal(hostMatches('dogdrip.net.evil.com', ['dogdrip.net']), false);
});
