// 클라우드(Durable Object SiteDO) 단위 테스트: worker/site.js 를 가짜 DO 저장소(node:sqlite)로 직접 돌린다.
// 출처는 가짜(외부 요청 없음), Claude API 도 이 컴퓨터 안의 가짜 서버만 쓴다.
//  - 수집 루프(알람·지금 수집·실시간 ON/OFF·겹침 방지·실패해도 다음 알람), 판정·게시판 수, 관리자 동작, 미리보기 캐시·미리 준비,
//    클라우드로 옮기기(/api/admin/import + scripts/push-to-cloud.js), Worker 진입점과의 연결
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : os.tmpdir();
mkdirSync(tmpBase, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpBase, 'cloud-'));
// 로컬 쪽 모듈(src/platform/node.js)이 비밀 파일을 만들 곳 — 클라우드 시험은 쓰지 않지만 data/ 를 건드리지 않게
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { DatabaseSync } = await import('node:sqlite');

// ---------- 가짜 모듈: cloudflare:workers, 출처 레지스트리 ----------
globalThis.__cl = { items: {}, articles: {}, readCalls: [], listCalls: 0, boom: false };
const mkSrc = (id, extra = {}) => ({
  id,
  name: `${id} 이름`,
  short: id.slice(0, 3),
  color: '#123456',
  homepage: `https://${id}.example.invalid/`,
  strictness: 'normal',
  imageHosts: [`img.${id}.example.invalid`],
  referer: `https://${id}.example.invalid/`,
  async list(page) {
    globalThis.__cl.listCalls++;
    if (globalThis.__cl.gate) await globalThis.__cl.gate;
    if (globalThis.__cl.failList?.[id]) throw new Error('목록 실패');
    return page === 1 ? (globalThis.__cl.items[id] || []).map((x) => ({ ...x })) : [];
  },
  async read(url) {
    globalThis.__cl.readCalls.push(url);
    if (globalThis.__cl.onRead) await globalThis.__cl.onRead(url);
    const a = globalThis.__cl.articles[url];
    if (!a) throw Object.assign(new Error('없는 글'), { status: 404 });
    return { title: '', comments: [], ...a };
  },
  ...extra,
});
globalThis.__clSources = [mkSrc('humoruniv'), mkSrc('dogdrip'), mkSrc('etoland', { disabled: true, disabledReason: '테스트' })];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      const src = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/src/sources/index.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const loadErrors = {};' +
          'export async function loadSources() { if (globalThis.__cl.boom) throw new Error("레지스트리 고장"); return globalThis.__clSources; }' +
          'export async function getSource(id) { return globalThis.__clSources.find((s) => s.id === id) || null; }',
      };
    }
    return next(url, context);
  },
});

const { SiteDO, IMPORT_MAX_BYTES, CRAWL_RETRY_MAX } = await import('../worker/site.js');
const { createWorker } = await import('../worker/index.js');
const { pushToCloud, adminSession, CHUNK_MB_MAX } = await import('../scripts/push-to-cloud.js');
const crawler = await import('../src/crawler.js');
const { fetchHtml, requestCount } = await import('../src/lib/http.js');
const { fetchQueue, applyVerdicts } = await import('../scripts/cloud-review.js');

// ---------- 가짜 DO 저장소 (SQLite 는 같은 엔진) ----------
function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const cursor = (rows) => ({ toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  const self = {
    db,
    failPosts: false, // true 면 posts 표 쓰기가 실패한다 (저장소 오류 흉내)
    sql: {
      exec(q, ...args) {
        if (self.failPosts && !/^\s*select/i.test(q) && /\bposts\b/.test(q)) throw new Error('SQLITE_FULL: database or disk is full');
        const st = db.prepare(q);
        if (/^\s*select/i.test(q)) return cursor(st.all(...args).map((r) => ({ ...r })));
        st.run(...args);
        return cursor([]);
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t) {
      alarm = typeof t === 'number' ? t : t.getTime();
    },
    async deleteAlarm() {
      alarm = null;
    },
    get alarm() {
      return alarm;
    },
    count: (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),
    kv: (k) => {
      const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
      return r ? JSON.parse(r.v) : undefined;
    },
    row: (id) => {
      const r = db.prepare('SELECT json FROM posts WHERE id = ?').get(id);
      return r ? JSON.parse(r.json) : null;
    },
  };
  return self;
}

const ENV = { ADMIN_PASSWORD: 'admin-pw-for-tests-1', ADULT_PASSWORD: 'adult-pw-tests', SESSION_SECRET: 'session-secret-for-tests', CRAWL_INTERVAL_MIN: '0', PREFETCH_PER_RUN: '0' };

/** DO 하나 켜기 (같은 저장소로 다시 켜면 '재시작') */
async function boot(storage = fakeStorage(), env = ENV) {
  const ctx = { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} };
  const d = new SiteDO(ctx, env);
  await d.ready;
  d.storage = storage;
  return d;
}

/** 요청 하나. body 가 객체면 JSON 으로. */
async function call(d, p, { method, body, cookie, headers = {}, ip = '203.0.113.7' } = {}) {
  const h = new Headers(headers);
  h.set('cf-connecting-ip', ip);
  if (cookie) h.set('cookie', cookie);
  let b = body;
  if (body !== undefined && typeof body !== 'string') {
    b = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  const res = await d.fetch(new Request(`https://simsimhae.test.workers.dev${p}`, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: b }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}
async function login(d, ip) {
  const r = await call(d, '/api/admin/login', { body: { password: ENV.ADMIN_PASSWORD }, ip });
  assert.equal(r.status, 200, r.text);
  return r.headers.getSetCookie()[0].split(';')[0];
}
const ids = (r) => r.json.items.map((p) => p.id);
const item = (postId, title, extra = {}) => ({ postId, title, url: `https://example.invalid/${postId}`, ...extra });
const near = (a, b, tol = 5000) => Math.abs(a - b) <= tol;
const quiet = async (fn) => {
  const [log, warn, error] = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
};

function setItems() {
  globalThis.__cl.items = {
    humoruniv: [
      item('1', '편의점 알바하다 겪은 웃긴 썰'),
      item('2', '고양이가 상자에 들어가는 방법'),
      item('3', '이재명 윤석열 토론 근황'), // 정치 → 차단
      item('4', '오늘의 짤 모음', { nsfwHint: true }), // 후방 표시 → 므흣
    ],
    dogdrip: [item('7', '고양이가 상자에 들어가는 방법')], // 같은 글 → 묶음
    etoland: [item('9', '수집을 끈 출처의 글')],
  };
}

// =====================================================================

test('처음 켜면 빈 상태: /api/meta 는 mode "cloud", 로컬 전용 필드(비밀 파일·공개 사이트 업로드) 없음', async () => {
  const d = await boot();
  const r = await call(d, '/api/meta');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.json.mode, 'cloud');
  assert.equal(r.json.admin, false);
  assert.deepEqual(r.json.boardCounts, { story: 0, pick: 0, all: 0 });
  assert.deepEqual(r.json.live, { live: false, lastCrawlAt: null });
  assert.deepEqual(r.json.sources.map((s) => s.id), ['humoruniv', 'dogdrip'], '수집을 끈 출처는 글이 없으면 숨김');
  const cookie = await login(d);
  const a = await call(d, '/api/meta', { cookie });
  assert.equal(a.json.admin, true);
  assert.ok(!('secretsFile' in a.json) && !('publish' in a.json), Object.keys(a.json).join());
  assert.deepEqual(Object.keys(a.json.live).sort(), ['intervalMin', 'lastCrawlAt', 'live', 'nextRunAt', 'running']);
  assert.equal(a.json.ai.enabled, false);
});

test('비밀이 없으면 로그인·잠금 해제는 503 (빈 비밀번호로 들어갈 수 없다), 방문자 화면은 그대로', async () => {
  const d = await boot(fakeStorage(), { CRAWL_INTERVAL_MIN: '0' });
  assert.equal((await call(d, '/api/admin/login', { body: { password: '' } })).status, 503);
  assert.equal((await call(d, '/api/unlock', { body: { password: '' } })).status, 503);
  const m = await call(d, '/api/meta', { headers: { 'x-admin-key': '' } });
  assert.equal(m.status, 200);
  assert.equal(m.json.admin, false);
});

test('관리자 비밀번호(ADMIN_PASSWORD)가 없으면 기본값·저장된 설정이 실시간 ON 이어도 자동 수집하지 않는다 (끌 방법이 없으니)', async () => {
  setItems();
  const noAdmin = { ADULT_PASSWORD: ENV.ADULT_PASSWORD, SESSION_SECRET: ENV.SESSION_SECRET, CRAWL_INTERVAL_MIN: '15', PREFETCH_PER_RUN: '0' };
  const storage = fakeStorage();
  const calls = globalThis.__cl.listCalls;
  const d = await quiet(() => boot(storage, noAdmin));
  assert.equal((await call(d, '/api/meta')).json.live.live, false);
  assert.equal(storage.alarm, null, '처음 켤 때 알람을 걸지 않는다');
  assert.deepEqual(await d.ensureAlarm(), { live: false, nextRunAt: null }, 'cron 도 걸지 않는다');
  await quiet(() => d.alarm()); // 남아 있던 알람이 와도
  assert.equal(globalThis.__cl.listCalls, calls, '출처에 요청하지 않는다');
  assert.equal(storage.alarm, null);

  // 관리자가 켜 둔 상태(저장된 live:true)에서 비밀이 빠져도 멈추고, 비밀을 다시 넣으면 이어진다
  const s2 = fakeStorage();
  const a = await boot(s2, { ...ENV, CRAWL_INTERVAL_MIN: '0' });
  await call(a, '/api/admin/live', { body: { live: true, intervalMin: 5 }, cookie: await login(a) });
  assert.ok(s2.alarm !== null);
  const b = await quiet(() => boot(s2, { ...noAdmin, CRAWL_INTERVAL_MIN: '0' }));
  assert.equal((await call(b, '/api/meta')).json.live.live, false);
  assert.equal(s2.alarm, null, '다시 켜질 때 알람을 지운다');
  const c = await boot(s2, { ...ENV, CRAWL_INTERVAL_MIN: '0' });
  assert.equal((await call(c, '/api/meta')).json.live.live, true);
  assert.ok(s2.alarm !== null, '비밀을 넣으면 다시 건다');
});

test('관리자: 쿠키는 Secure·HttpOnly·SameSite=Strict, x-admin-key 는 받지 않고, 관리자 POST 는 JSON 만', async () => {
  const d = await boot();
  const r = await call(d, '/api/admin/login', { body: { password: ENV.ADMIN_PASSWORD } });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^hg_admin=/);
  assert.match(sc, /; HttpOnly/);
  assert.match(sc, /; SameSite=Strict/);
  assert.match(sc, /; Secure/);
  const cookie = sc.split(';')[0];
  assert.equal((await call(d, '/api/meta', { headers: { 'x-admin-key': ENV.ADMIN_PASSWORD } })).json.admin, false, '클라우드에는 로컬 스크립트용 키가 없다');
  assert.equal((await call(d, '/api/admin/live', { body: 'live=true', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await call(d, '/api/admin/live', { body: { live: true } })).status, 401);
  assert.equal((await call(d, '/api/admin/rules')).status, 401);
  const u = await call(d, '/api/unlock', { body: { password: ENV.ADULT_PASSWORD } });
  assert.match(u.headers.get('set-cookie'), /^hg_adult=.*; Secure/);
  assert.equal((await call(d, '/api/meta', { cookie: u.headers.get('set-cookie').split(';')[0] })).json.adult, true);
  assert.equal((await call(d, '/api/admin/logout', { body: {}, cookie })).headers.get('set-cookie').includes('Max-Age=0'), true);
});

test('시도 제한: 틀린 비밀번호 10번이면 막히고, DO 가 다시 켜져도 이어진다 (접속자별)', async () => {
  const storage = fakeStorage();
  let d = await boot(storage);
  for (let i = 0; i < 10; i++) assert.equal((await call(d, '/api/admin/login', { body: { password: 'wrong' }, ip: '198.51.100.1' })).status, 401);
  assert.equal((await call(d, '/api/admin/login', { body: { password: ENV.ADMIN_PASSWORD }, ip: '198.51.100.1' })).status, 429);
  d = await boot(storage);
  assert.equal((await call(d, '/api/admin/login', { body: { password: ENV.ADMIN_PASSWORD }, ip: '198.51.100.1' })).status, 429, '메모리에서 내려가도 풀리지 않는다');
  assert.equal((await call(d, '/api/admin/login', { body: { password: ENV.ADMIN_PASSWORD }, ip: '198.51.100.2' })).status, 200);
  assert.equal((await call(d, '/api/unlock', { body: { password: ENV.ADULT_PASSWORD }, ip: '198.51.100.1' })).status, 200, '잠금 해제는 따로 센다');
});

test("'지금 수집' → 알람에서 수집·판정, 게시판 수는 목록 total 과 같고, 다시 켜도 저장소에 남는다", async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage);
  const cookie = await login(d);
  const r = await call(d, '/api/admin/crawl', { body: {}, cookie });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { started: true, running: true });
  assert.ok(near(storage.alarm, Date.now()), '바로 알람');
  assert.equal((await call(d, '/api/meta', { cookie })).json.live.running, true, '알람이 돌기 전에도 수집 중으로');
  assert.deepEqual((await call(d, '/api/admin/crawl', { body: {}, cookie })).json, { started: false, running: true });

  await quiet(() => d.alarm());
  const meta = await call(d, '/api/meta', { cookie });
  assert.equal(meta.json.live.running, false);
  assert.ok(meta.json.live.lastCrawlAt);
  assert.equal(storage.alarm, null, '실시간이 꺼져 있으면 다음 알람 없음');
  assert.equal(globalThis.__cl.listCalls > 0, true);

  // 판정·묶음
  // 같은 시각에 들어온 같은 글은 id 순으로 앞선 글이 대표 (로컬과 같은 규칙)
  const all = await call(d, '/api/posts?board=all&size=100');
  assert.deepEqual(ids(all).sort(), ['dogdrip:7', 'humoruniv:1']);
  assert.deepEqual(all.json.items.find((p) => p.id === 'dogdrip:7').alsoOn, [{ source: 'humoruniv', url: 'https://example.invalid/2' }]);
  assert.ok(ids(await call(d, '/api/posts?board=filtered&size=100', { cookie })).includes('humoruniv:3'));
  assert.deepEqual(ids(await call(d, '/api/posts?board=adult', { cookie })), ['humoruniv:4']);
  assert.equal((await call(d, '/api/posts?board=adult')).status, 403);
  assert.equal((await call(d, '/api/posts?board=etoland')).json.total, 0, '수집을 끈 출처는 가져오지 않는다');

  // 게시판 수 = 목록 total (방문자·관리자)
  const anon = await call(d, '/api/meta');
  for (const b of Object.keys(anon.json.boardCounts)) assert.equal(anon.json.boardCounts[b], (await call(d, `/api/posts?board=${b}`)).json.total, b);
  for (const s of anon.json.sources) assert.equal(s.count, (await call(d, `/api/posts?board=${s.id}`)).json.total, s.id);
  for (const b of Object.keys(meta.json.boardCounts)) assert.equal(meta.json.boardCounts[b], (await call(d, `/api/posts?board=${b}`, { cookie })).json.total, b);
  assert.equal(meta.json.sources.find((s) => s.id === 'humoruniv').state.ok, true);

  // 저장소: 글은 행 하나씩, 다시 켜면 같은 상태
  assert.equal(storage.count('posts'), 5);
  const d2 = await boot(storage);
  assert.deepEqual((await call(d2, '/api/meta')).json.boardCounts, anon.json.boardCounts);
  assert.equal((await call(d2, '/api/meta')).json.live.lastCrawlAt, meta.json.live.lastCrawlAt);
});

test('실시간 ON/OFF·간격은 알람으로, 방금 수집했으면 겹쳐 돌지 않고, 켜져 있으면 늘 다음 알람이 있다', async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage);
  const cookie = await login(d);
  let r = await call(d, '/api/admin/live', { body: { live: true, intervalMin: 10 }, cookie });
  assert.equal(r.json.live, true);
  assert.equal(r.json.intervalMin, 10);
  assert.ok(near(storage.alarm, Date.now() + 1000), '막 켰으면 곧바로 한 번');
  assert.equal(r.json.nextRunAt, new Date(storage.alarm).toISOString());

  await quiet(() => d.alarm()); // 첫 수집
  const last = Date.parse((await call(d, '/api/meta')).json.live.lastCrawlAt);
  assert.ok(near(storage.alarm, Date.now() + 10 * 60e3), '다음은 간격 뒤');

  // 방금 수집했는데 알람이 또 오면(겹침) 목록을 다시 받지 않고 다음 차례만 맞춘다
  const calls = globalThis.__cl.listCalls;
  await quiet(() => d.alarm());
  assert.equal(globalThis.__cl.listCalls, calls);
  assert.ok(near(storage.alarm, last + 10 * 60e3));

  // 간격 바꾸기·범위
  r = await call(d, '/api/admin/live', { body: { intervalMin: 1 }, cookie });
  assert.equal(r.json.intervalMin, 3);
  assert.ok(near(storage.alarm, Date.now() + 3 * 60e3));

  // 끄면 알람도 없앤다, cron 확인도 다시 걸지 않는다
  r = await call(d, '/api/admin/live', { body: { live: false }, cookie });
  assert.equal(storage.alarm, null);
  assert.equal(r.json.nextRunAt, null);
  assert.deepEqual(await d.ensureAlarm(), { live: false, nextRunAt: null });
  assert.equal(storage.alarm, null);

  // 켜져 있는데 알람이 사라졌으면 cron 이 다시 건다 (마지막 수집 + 간격)
  await call(d, '/api/admin/live', { body: { live: true }, cookie });
  await storage.deleteAlarm();
  const out = await d.ensureAlarm();
  assert.equal(out.live, true);
  assert.ok(storage.alarm >= Date.now() + 1000 - 50 && storage.alarm <= last + 3 * 60e3 + 2000, `${storage.alarm - Date.now()}`);

  // DO 가 다시 켜져도 실시간 설정이 남는다
  const d2 = await boot(storage);
  const m = await call(d2, '/api/meta', { cookie });
  assert.equal(m.json.live.live, true);
  assert.equal(m.json.live.intervalMin, 3);
});

test('수집이 실패해도 알람은 예외를 내지 않고 다음 알람이 남는다 (출처 하나가 실패하면 그 출처만 오류로)', async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage, { ...ENV, CRAWL_INTERVAL_MIN: '7' }); // 기본 실시간 ON
  const cookie = await login(d);
  assert.equal((await call(d, '/api/meta')).json.live.live, true);
  assert.ok(storage.alarm !== null, '켤 때 알람을 건다');

  globalThis.__cl.boom = true;
  try {
    await quiet(() => d.alarm());
  } finally {
    globalThis.__cl.boom = false;
  }
  assert.ok(near(storage.alarm, Date.now() + 7 * 60e3), '실패해도 간격 뒤에 다시');

  globalThis.__cl.failList = { dogdrip: true };
  try {
    await call(d, '/api/admin/crawl', { body: {}, cookie });
    await quiet(() => d.alarm());
  } finally {
    globalThis.__cl.failList = null;
  }
  const st = (await call(d, '/api/meta', { cookie })).json.sources;
  assert.equal(st.find((s) => s.id === 'dogdrip').state.ok, false);
  assert.match(st.find((s) => s.id === 'dogdrip').state.error, /목록 실패/);
  assert.equal(st.find((s) => s.id === 'humoruniv').state.ok, true);
  assert.ok(near(storage.alarm, Date.now() + 7 * 60e3));
});

test('미리보기: 원문에서 가져와 정리하고 DO 저장소에 캐시 (다시 켜져도 원문에 다시 가지 않음), 본문 검사로 숨김', async () => {
  setItems();
  globalThis.__cl.articles = {
    'https://example.invalid/1': { html: '<p>웃긴 본문</p><img src="https://img.humoruniv.example.invalid/a.jpg"><script>alert(1)</script>', comments: [{ author: 'a', text: 'ㅋㅋ' }] },
    'https://example.invalid/2': { html: '<p>(서울=뉴스1) 홍길동 기자 = [단독] 어쩌구</p>' },
  };
  globalThis.__cl.readCalls = [];
  const storage = fakeStorage();
  let d = await boot(storage);
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());

  const r = await call(d, `/api/posts/${encodeURIComponent('humoruniv:1')}/read`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.html, /\/api\/img\?s=humoruniv&amp;u=https%3A%2F%2Fimg\.humoruniv\.example\.invalid%2Fa\.jpg/);
  assert.doesNotMatch(r.json.html, /script/);
  assert.equal(r.json.comments[0].text, 'ㅋㅋ');
  assert.equal(r.json.post.id, 'humoruniv:1');
  await call(d, `/api/posts/${encodeURIComponent('humoruniv:1')}/read`);
  assert.equal(globalThis.__cl.readCalls.length, 1);
  d = await boot(storage);
  assert.equal((await call(d, `/api/posts/${encodeURIComponent('humoruniv:1')}/read`)).status, 200);
  assert.equal(globalThis.__cl.readCalls.length, 1, 'DO 저장소 캐시');
  assert.equal(storage.count('reads'), 1);

  // 본문 검사: 방문자에게는 숨기고(409), 상태는 저장소에 남는다
  const b = await call(d, `/api/posts/${encodeURIComponent('humoruniv:2')}/read`);
  assert.equal(b.status, 409);
  d = await boot(storage);
  assert.ok(ids(await call(d, '/api/posts?board=filtered&size=100', { cookie })).includes('humoruniv:2'));
  assert.ok(!ids(await call(d, '/api/posts?board=humoruniv&size=100')).includes('humoruniv:2'));
  // 원문을 못 읽으면 502 와 원문 주소
  const e = await call(d, `/api/posts/${encodeURIComponent('dogdrip:7')}/read`);
  assert.equal(e.status, 502);
  assert.equal(e.json.url, 'https://example.invalid/7');
  assert.equal((await call(d, '/api/posts/%E0%A4%A/read')).status, 400);
  assert.equal((await call(d, '/api/posts/nope%3A1/read')).status, 404);
});

test('알람 때 핸드드립 → 푸어오버 글의 미리보기를 몇 개만 미리 준비하고, 못 가져온 글은 바로 다시 시도하지 않는다', async () => {
  globalThis.__cl.items = { humoruniv: [item('14', '못 읽는 썰'), item('11', '첫 번째 썰'), item('12', '두 번째 썰')] };
  globalThis.__cl.articles = Object.fromEntries(['11', '12'].map((n) => [`https://example.invalid/${n}`, { html: `<p>본문 ${n}</p>` }]));
  const storage = fakeStorage();
  let d = await boot(storage); // 미리 준비 끔
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  for (const n of ['14', '11', '12']) await call(d, `/api/admin/posts/${encodeURIComponent(`humoruniv:${n}`)}`, { body: { vibe: true }, cookie });
  assert.equal((await call(d, '/api/posts?board=story')).json.total, 3);
  assert.equal(storage.count('reads'), 0);

  d = await boot(storage, { ...ENV, PREFETCH_PER_RUN: '2' });
  globalThis.__cl.readCalls = [];
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  assert.deepEqual(globalThis.__cl.readCalls, ['https://example.invalid/14', 'https://example.invalid/11', 'https://example.invalid/12'], '못 읽은 글은 넘어가 2개를 채운다');
  assert.equal(storage.count('reads'), 2);
  // 다음 알람: 이미 있는 글은 건너뛰고, 못 읽은 글은 한동안 다시 가지 않는다
  globalThis.__cl.readCalls = [];
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  assert.deepEqual(globalThis.__cl.readCalls, []);
  // 미리 준비한 글은 원문에 가지 않고 바로 열린다
  assert.equal((await call(d, `/api/posts/${encodeURIComponent('humoruniv:11')}/read`)).status, 200);
  assert.deepEqual(globalThis.__cl.readCalls, []);
});

test('관리자 동작(게시하기·후보함·금지어·검수 결과)이 DO 저장소에 남는다', async () => {
  setItems();
  const storage = fakeStorage();
  let d = await boot(storage);
  let cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  const id = encodeURIComponent('humoruniv:3');
  let r = await call(d, `/api/admin/posts/${id}`, { body: { manual: 'ok', shorts: { stage: 'script', note: '메모' } }, cookie });
  assert.equal(r.json.post.status, 'ok');
  assert.equal(r.json.post.shorts.stage, 'script');
  r = await call(d, '/api/admin/rules', { body: { block: ['상자'], adult: [], allow: [] }, cookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.changed >= 1);
  r = await call(d, '/api/admin/verdicts', { body: { model: 'manual', items: [{ id: 'humoruniv:1', verdict: 'not_humor', shortsScore: 0, reason: '정보' }, { id: 'nope:1', verdict: 'ok' }] }, cookie });
  assert.deepEqual(r.json, { applied: 1, skipped: ['nope:1'] });
  assert.equal((await call(d, '/api/admin/review-queue', { cookie })).status, 200);

  d = await boot(storage);
  cookie = await login(d);
  assert.deepEqual((await call(d, '/api/admin/rules', { cookie })).json, { block: ['상자'], adult: [], allow: [] });
  const shorts = await call(d, '/api/posts?board=shorts', { cookie });
  assert.deepEqual(ids(shorts), ['humoruniv:3']);
  assert.equal(shorts.json.items[0].shorts.note, '메모');
  const filtered = ids(await call(d, '/api/posts?board=filtered&size=100', { cookie }));
  assert.ok(filtered.includes('humoruniv:1') && filtered.includes('humoruniv:2'), filtered.join());
  // 규칙을 다시 저장하기 전까지는 다시 켜도 다시 판정하지 않는다 (지문이 같다)
  assert.ok(filtered.includes('humoruniv:2'));
});

test('클라우드로 옮기기: 나눠 올려도 commit 전에는 그대로, commit 하면 통째로 바뀌고 다시 판정하지 않는다', async () => {
  setItems();
  const storage = fakeStorage();
  let d = await boot(storage);
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  globalThis.__cl.articles = { 'https://example.invalid/1': { html: '<p>캐시될 본문</p>' } };
  await call(d, `/api/posts/${encodeURIComponent('humoruniv:1')}/read`);
  assert.equal(storage.count('reads'), 1);

  const at = new Date(Date.now() - 3600e3).toISOString();
  const local = (id, title, extra = {}) => ({
    id, source: id.split(':')[0], postId: id.split(':')[1], title, url: `https://local.invalid/${id}`, firstSeenAt: at, updatedAt: at,
    manual: null, ai: null, aiPending: false, dupOf: null, auto: { status: 'ok', reasons: [], flags: {} }, status: 'ok', shortsScore: 50, ...extra,
  });
  const posts = {
    'dogdrip:100': local('dogdrip:100', '로컬에서 온 글', { published: { hash: 'x', at } }),
    'dogdrip:101': local('dogdrip:101', '본문 검사로 걸린 글', { auto: { status: 'blocked', reasons: ['본문 뉴스: [단독]'], flags: {} }, status: 'blocked', bodyChecked: true }),
    'humoruniv:102': local('humoruniv:102', '사본', { dupOf: 'nope:1' }),
    'bad:1': { id: 'bad:1', title: '주소 없음' },
  };
  const all = Object.values(posts);

  // 나눠서
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'begin' } })).status, 401);
  assert.equal((await call(d, '/api/admin/import', { body: 'x', cookie, headers: { 'content-type': 'text/plain' } })).status, 415);
  const begin = await call(d, '/api/admin/import', { body: { step: 'begin' }, cookie });
  const importId = begin.json.importId;
  assert.ok(importId);
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'posts', importId: 'wrong', posts: all } , cookie })).status, 409);
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'posts', importId, posts: all.slice(0, 2) }, cookie })).json.staged, 2);
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'posts', importId, posts: all.slice(2) }, cookie })).json.staged, 4);
  assert.deepEqual(ids(await call(d, '/api/posts?board=all&size=100')).sort(), ['dogdrip:7', 'humoruniv:1'], 'commit 전에는 그대로');
  const meta = { sources: { dogdrip: { ok: true, lastRunAt: at } }, lastCrawlAt: at, settings: { live: false, intervalMin: 20, rulesHash: 'local-hash' }, rules: { block: ['금지어'], adult: [], allow: ['예외'] } };
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'commit', importId, expect: 5, ...meta }, cookie })).status, 409, '받은 수가 다르면 바꾸지 않는다');
  const done = await call(d, '/api/admin/import', { body: { step: 'commit', importId, expect: 4, ...meta }, cookie });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { ok: true, posts: 3, skipped: 1, rules: true });
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'commit', importId, ...meta }, cookie })).status, 409, '한 번 쓰면 끝');

  const check = async (dd) => {
    const m = await call(dd, '/api/meta', { cookie });
    assert.equal(m.json.live.lastCrawlAt, at);
    assert.equal(m.json.live.intervalMin, 20);
    assert.equal(m.json.live.live, false);
    assert.deepEqual(ids(await call(dd, '/api/posts?board=all&size=100')).sort(), ['dogdrip:100', 'humoruniv:102']);
    assert.deepEqual(ids(await call(dd, '/api/posts?board=filtered&size=100', { cookie })), ['dogdrip:101'], '본문 판정이 그대로 (다시 판정하지 않음)');
    assert.deepEqual((await call(dd, '/api/admin/rules', { cookie })).json, { block: ['금지어'], adult: [], allow: ['예외'] });
  };
  await check(d);
  assert.equal(storage.count('reads'), 0, '예전 미리보기는 지운다');
  assert.equal(storage.count('import_posts'), 0);
  assert.equal(JSON.parse(storage.db.prepare("SELECT json FROM posts WHERE id = 'dogdrip:100'").get().json).published, undefined);
  assert.equal(JSON.parse(storage.db.prepare("SELECT json FROM posts WHERE id = 'humoruniv:102'").get().json).dupOf, null);
  d = await boot(storage); // 다시 켜도 다시 판정하지 않는다
  await check(d);

  // 한 번에 (작은 데이터). 글 목록이 없는 요청은 실수로 보고 아무것도 지우지 않는다
  assert.equal((await call(d, '/api/admin/import', { body: { settings: {} }, cookie })).status, 400);
  assert.equal((await call(d, '/api/admin/import', { body: { step: 'nope', importId: 'x' }, cookie })).status, 409);
  await check(d);
  const one = await call(d, '/api/admin/import', { body: { posts: [local('dogdrip:200', '한 번에 온 글')], settings: {} }, cookie });
  assert.deepEqual(one.json, { ok: true, posts: 1, skipped: 0, rules: false });
  assert.deepEqual(ids(await call(d, '/api/posts?board=all')), ['dogdrip:200']);
  assert.deepEqual((await call(d, '/api/admin/rules', { cookie })).json.block, ['금지어'], 'rules 를 안 보내면 금지어는 그대로');
});

test('클라우드로 옮기기: 수집이 도는 중에는 바꾸지 않는다 (409, 받아 둔 글은 그대로)', async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage);
  const cookie = await login(d);
  const begin = await call(d, '/api/admin/import', { body: { step: 'begin' }, cookie });
  await call(d, '/api/admin/import', { body: { step: 'posts', importId: begin.json.importId, posts: [] }, cookie });
  let open;
  globalThis.__cl.gate = new Promise((r) => (open = r));
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  const running = quiet(() => d.alarm());
  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await call(d, '/api/meta', { cookie })).json.live.running, true);
    const r = await call(d, '/api/admin/import', { body: { step: 'commit', importId: begin.json.importId }, cookie });
    assert.equal(r.status, 409);
    assert.equal((await call(d, '/api/admin/import', { body: { posts: [] }, cookie })).status, 409);
  } finally {
    globalThis.__cl.gate = null;
    open();
    await running;
  }
  assert.equal(storage.count('posts'), 5, '수집 결과는 그대로');
  const done = await call(d, '/api/admin/import', { body: { step: 'commit', importId: begin.json.importId, expect: 0 }, cookie });
  assert.equal(done.status, 200, '수집이 끝나면 이어서 바꿀 수 있다');
  assert.equal(storage.count('posts'), 0);
});

test('scripts/push-to-cloud.js: 로그인 → 나눠 올리기 → commit → 로그아웃 (비밀번호가 틀리면 아무것도 바꾸지 않음)', async () => {
  const storage = fakeStorage();
  const d = await boot(storage);
  const at = new Date(Date.now() - 600e3).toISOString();
  const posts = Array.from({ length: 30 }, (_, i) => ({ id: `dogdrip:${i}`, source: 'dogdrip', postId: String(i), title: `옮길 글 ${i} ${'가'.repeat(i)}`, url: `https://local.invalid/${i}`, firstSeenAt: at, auto: { status: 'ok', reasons: [] }, status: 'ok' }));
  const data = { posts, sources: {}, lastCrawlAt: at, settings: { live: false }, rules: { block: [], adult: [], allow: [] } };
  const paths = [];
  const viaDo = async (url, init) => {
    paths.push(new URL(url).pathname);
    return d.fetch(new Request(url, { ...init, headers: { ...init.headers, 'cf-connecting-ip': '192.0.2.50' } }));
  };
  await assert.rejects(pushToCloud({ origin: 'https://simsimhae.test.workers.dev', password: 'wrong', data, fetch: viaDo }), /HTTP 401/);
  assert.equal(storage.count('posts'), 0);
  paths.length = 0;
  const logs = [];
  const out = await pushToCloud({ origin: 'https://simsimhae.test.workers.dev', password: ENV.ADMIN_PASSWORD, data, chunkBytes: 1500, fetch: viaDo, log: (s) => logs.push(s) });
  assert.deepEqual(out, { posts: 30, skipped: 0 });
  assert.equal(paths[0], '/api/admin/login');
  assert.equal(paths.at(-1), '/api/admin/logout');
  assert.ok(paths.filter((p) => p === '/api/admin/import').length >= 4, '여러 번에 나눠');
  assert.equal(storage.count('posts'), 30);
  assert.equal((await call(d, '/api/posts?board=all&size=100')).json.total, 30);
  assert.ok(!logs.join('\n').includes(ENV.ADMIN_PASSWORD), '비밀번호를 찍지 않는다');
});

test('scripts/cloud-review.js: 이 컴퓨터에서 검수 대기 글을 받고 판정을 올린다 (로그인 쿠키로, 64KB 본문 한도 안으로 나눠서)', async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage);
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  const paths = [];
  const viaDo = async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    return d.fetch(new Request(url, { ...init, headers: { ...init.headers, 'cf-connecting-ip': '192.0.2.51' } }));
  };
  const origin = 'https://simsimhae.test.workers.dev';
  await assert.rejects(fetchQueue({ origin, password: 'wrong', fetch: viaDo }), /HTTP 401/);
  paths.length = 0;
  const q = await fetchQueue({ origin, password: ENV.ADMIN_PASSWORD, limit: 50, fetch: viaDo });
  assert.deepEqual(paths, ['POST /api/admin/login', 'GET /api/admin/review-queue', 'POST /api/admin/logout']);
  const queued = q.items.map((x) => x.id).sort();
  assert.ok(queued.includes('humoruniv:1') && queued.includes('dogdrip:7'), queued.join());
  assert.ok(!queued.includes('humoruniv:3'), '키워드로 차단된 글은 대기열에 없다');

  // 많이 올려도 요청 하나가 64KB 를 넘지 않게 나눠 보낸다 (없는 글은 건너뜀으로)
  const filler = Array.from({ length: 700 }, (_, i) => ({ id: `none:${i}`, verdict: 'ok', shortsScore: 50, reason: '가'.repeat(60) }));
  const items = [{ id: 'humoruniv:1', verdict: 'not_humor', shortsScore: 0, reason: '시험' }, { id: 'dogdrip:7', verdict: 'ok', shortsScore: 90, reason: '웃김', vibe: 80 }, ...filler];
  paths.length = 0;
  const logs = [];
  const r = await applyVerdicts({ origin, password: ENV.ADMIN_PASSWORD, data: { model: 'claude-code 검수', items }, fetch: viaDo, log: (s) => logs.push(s) });
  assert.equal(r.applied, 2);
  assert.equal(r.skipped.length, 700);
  assert.ok(paths.filter((p) => p === 'POST /api/admin/verdicts').length >= 3, paths.join());
  assert.ok(!logs.join('\n').includes(ENV.ADMIN_PASSWORD));
  const filtered = await call(d, '/api/posts?board=filtered&size=100', { cookie });
  const h1 = filtered.json.items.find((p) => p.id === 'humoruniv:1');
  assert.equal(h1?.ai?.verdict, 'not_humor', '판정이 반영되어 걸러진다');
  assert.equal(h1.ai.model, 'claude-code 검수');
  const all = await call(d, '/api/posts?board=all&size=100', { cookie });
  assert.equal(all.json.items.find((p) => p.id === 'dogdrip:7').ai.vibe, 80);
  const left = (await fetchQueue({ origin, password: ENV.ADMIN_PASSWORD, fetch: viaDo })).items.map((x) => x.id);
  assert.equal(left.length, queued.length - 2, '판정한 글은 대기열에서 빠진다');
  assert.ok(!left.includes('humoruniv:1') && !left.includes('dogdrip:7'), left.join());
  await assert.rejects(applyVerdicts({ origin, password: ENV.ADMIN_PASSWORD, data: { nope: 1 }, fetch: viaDo }), /items/);
});

test('없는 경로·잘못된 요청: 실시간 연결·업로드 API·공개 사이트 올리기는 404, 잘못된 JSON 400, 큰 본문 413', async () => {
  const d = await boot();
  const cookie = await login(d);
  for (const [p, opts] of [
    ['/api/events', {}],
    ['/api/sync/status', {}],
    ['/api/sync/snapshot', { method: 'PUT', body: {} }],
    ['/api/admin/publish', { body: {}, cookie }],
    ['/api/nope', {}],
    ['/api/posts', { method: 'DELETE' }],
  ]) {
    const r = await call(d, p, opts);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'not found' });
  }
  const bad = await call(d, '/api/lock', { body: '{', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json), ['error']);
  const big = await call(d, '/api/unlock', { body: { password: 'x'.repeat(70 * 1024) } });
  assert.equal(big.status, 413);
});

test('Claude 검수: Worker 비밀(ANTHROPIC_API_KEY)이 있으면 수집 때 판정하고, 판정 전에는 숨긴다', async () => {
  let calls = 0;
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      const j = JSON.parse(body);
      const lines = String(j.messages?.[0]?.content || '').split('\n').filter((l) => /^\d+\. /.test(l));
      const items = lines.map((l) => ({ i: Number(l.split('.')[0]), verdict: l.includes('상자') ? 'not_humor' : 'ok', shortsScore: 80, vibe: 90, reason: '테스트' }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: j.model, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items }) }] }));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  try {
    setItems();
    const env = { ...ENV, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, AI_MODEL: 'claude-test' };
    const d = await boot(fakeStorage(), env);
    const cookie = await login(d);
    assert.equal((await call(d, '/api/meta', { cookie })).json.ai.enabled, true);
    await call(d, '/api/admin/crawl', { body: {}, cookie });
    await quiet(() => d.alarm());
    assert.ok(calls >= 1);
    const all = ids(await call(d, '/api/posts?board=all&size=100'));
    assert.deepEqual(all, ['humoruniv:1'], `Claude 가 유머 아님으로 본 글은 빠진다: ${all}`);
    const p = (await call(d, '/api/posts?board=humoruniv&size=100', { cookie })).json.items.find((x) => x.id === 'humoruniv:1');
    assert.equal(p.ai.verdict, 'ok');
    assert.equal(p.ai.model, 'claude-test');
  } finally {
    api.close();
  }
});

test('Worker 진입점 + SiteDO: /api/* 는 DO("main") 로, 화면 파일은 ASSETS 로, cron 은 알람을 다시 건다 (예전 D1 바인딩은 무시)', async () => {
  const storage = fakeStorage();
  const d = await boot(storage, { ...ENV, CRAWL_INTERVAL_MIN: '15' });
  await storage.deleteAlarm();
  const names = [];
  const env = {
    SITE: { idFromName: (n) => (names.push(n), `id:${n}`), get: () => ({ fetch: (req) => d.fetch(req), ensureAlarm: () => d.ensureAlarm() }) },
    ASSETS: { fetch: async (req) => new Response(`page ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) },
    DB: { prepare() { throw new Error('D1 은 쓰지 않는다'); } },
  };
  const w = createWorker();
  const meta = await w.fetch(new Request('https://simsimhae.test.workers.dev/api/meta'), env, { waitUntil() {} });
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).mode, 'cloud');
  assert.match(meta.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(meta.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(names, ['main']);
  const page = await w.fetch(new Request('https://simsimhae.test.workers.dev/index.html'), env, {});
  assert.equal(await page.text(), 'page /index.html');
  // 이미지 프록시는 DO 를 거치지 않는다 (허용 호스트가 아니면 원본에도 가지 않고 403)
  names.length = 0;
  const img = await w.fetch(new Request('https://simsimhae.test.workers.dev/api/img?s=humoruniv&u=https%3A%2F%2Fevil.example%2Fa.png'), env, {});
  assert.equal(img.status, 403);
  assert.deepEqual(names, []);
  // cron
  const pending = [];
  await w.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.ok(storage.alarm !== null && storage.alarm >= Date.now(), '알람을 다시 건다');
});

// =====================================================================
// 리뷰에서 확인된 문제들 (로그인 전 큰 본문, 미리 준비 한도, '지금 수집' 예약, 저장 실패, 요청 대기열)
// =====================================================================

/** kv 표에 값을 직접 넣는다 (isolate 가 도중에 죽어 남은 상태 흉내) */
const putKv = (storage, k, v) => storage.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));

test('옮기기: 로그인하지 않은 요청은 본문을 읽거나 해석하기 전에 401 (큰 본문·깨진 JSON·길이를 알리지 않는 본문 모두)', async () => {
  const d = await boot();
  const json = { 'content-type': 'application/json' };
  const broken = `[${'{},'.repeat(400_000)}`; // 1.2MB, 닫히지 않은 JSON
  const parse = JSON.parse;
  let biggest = 0;
  JSON.parse = function (text, ...rest) {
    if (typeof text === 'string') biggest = Math.max(biggest, text.length);
    return parse.call(this, text, ...rest);
  };
  let pulled = 0;
  try {
    // 예전에는 끝까지 읽고 해석해서 400 이었다
    const r = await call(d, '/api/admin/import', { body: broken, headers: json });
    assert.equal(r.status, 401, r.text);
    assert.deepEqual(r.json, { error: '관리자 로그인이 필요해요' });
    // 옮기기 상한보다 커도 413 이 아니라 401
    assert.equal((await call(d, '/api/admin/import', { body: 'x'.repeat(IMPORT_MAX_BYTES + 10), headers: json })).status, 401);
    // JSON 이 아니어도 401 (예전에는 415 가 먼저)
    assert.equal((await call(d, '/api/admin/import', { body: 'x', headers: { 'content-type': 'text/plain' } })).status, 401);
    // 길이를 알리지 않는 본문(chunked): 조금만 읽고 멈춘다
    const piece = new TextEncoder().encode(`{"a":"${'가'.repeat(5000)}`); // 약 15KB
    const stream = new ReadableStream(
      {
        pull(c) {
          if (pulled >= 8 * 1024 * 1024) return c.close();
          pulled += piece.length;
          c.enqueue(piece);
        },
      },
      { highWaterMark: 0 },
    );
    const res = await d.fetch(
      new Request('https://simsimhae.test.workers.dev/api/admin/import', { method: 'POST', headers: { ...json, 'cf-connecting-ip': '203.0.113.7' }, body: stream, duplex: 'half' }),
    );
    assert.equal(res.status, 401);
  } finally {
    JSON.parse = parse;
  }
  assert.ok(pulled <= 128 * 1024, `로그인 전에 본문을 ${pulled}바이트 읽었다`);
  assert.ok(biggest < 64 * 1024, `로그인 전에 큰 본문을 해석했다 (${biggest}자)`);

  // 관리자는 그대로: 깨진 JSON 400, 상한을 넘으면 413, 상한 안이면 받는다
  const cookie = await login(d);
  assert.equal((await call(d, '/api/admin/import', { body: broken, cookie, headers: json })).status, 400);
  assert.equal((await call(d, '/api/admin/import', { body: 'x'.repeat(IMPORT_MAX_BYTES + 10), cookie, headers: json })).status, 413);
  const begin = await call(d, '/api/admin/import', { body: { step: 'begin' }, cookie });
  assert.equal(begin.status, 200);
  const big = Array.from({ length: 3 }, (_, i) => ({ id: `dogdrip:${i}`, source: 'dogdrip', postId: String(i), title: `큰 글 ${i}`, url: `https://local.invalid/${i}`, firstSeenAt: new Date().toISOString(), note: '가'.repeat(300_000) }));
  const r = await call(d, '/api/admin/import', { body: { step: 'posts', importId: begin.json.importId, posts: big }, cookie });
  assert.equal(r.status, 200, '64KB 보다 큰 묶음도 관리자는 올릴 수 있다');
  assert.equal(r.json.staged, 3);
  // 다른 경로의 본문 상한(64KB)은 그대로
  assert.equal((await call(d, '/api/admin/verdicts', { body: { items: [], pad: 'x'.repeat(70 * 1024) }, cookie })).status, 413);
});

test('미리 준비: 못 가져오는 글이 많아도 성공 목표의 두 배까지만, 시간 예산 안에서만 시도하고, 실패 기록은 실패할 때마다 바로 저장한다', async () => {
  const N = 12;
  globalThis.__cl.items = { dogdrip: Array.from({ length: N }, (_, i) => item(String(100 + i), `소소한 썰 번호 ${i} 이야기`)) };
  globalThis.__cl.articles = {}; // 글 페이지는 모두 실패
  const storage = fakeStorage();
  let d = await boot(storage);
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  for (let i = 0; i < N; i++) await call(d, `/api/admin/posts/${encodeURIComponent(`dogdrip:${100 + i}`)}`, { body: { vibe: true }, cookie });
  assert.equal((await call(d, '/api/posts?board=story&size=100')).json.total, N);

  d = await boot(storage, { ...ENV, PREFETCH_PER_RUN: '2' });
  globalThis.__cl.readCalls = [];
  // 두 번째 글을 읽는 순간(알람이 여기서 끊긴다고 치고) 저장소를 들여다본다
  let mid = null;
  globalThis.__cl.onRead = async () => {
    if (globalThis.__cl.readCalls.length === 2) mid = storage.kv('prefetchFails');
  };
  try {
    await call(d, '/api/admin/crawl', { body: {}, cookie });
    await quiet(() => d.alarm());
  } finally {
    globalThis.__cl.onRead = null;
  }
  assert.equal(globalThis.__cl.readCalls.length, 4, '대기열 끝까지가 아니라 성공 목표(2)의 두 배까지만');
  assert.equal(Object.keys(mid || {}).length, 1, '첫 실패는 다음 글을 읽기 전에 이미 저장돼 있다');
  assert.equal(Object.keys(storage.kv('prefetchFails')).length, 4);

  // 시간 예산: 알람이 시작된 지 오래됐으면 더 가져오지 않는다 (예산 안이면 가져온다)
  globalThis.__cl.readCalls = [];
  assert.equal(await d.prefetch(requestCount(), { startedAt: Date.now() - 5 * 60e3 }), 0);
  assert.equal(globalThis.__cl.readCalls.length, 0);
  await quiet(() => d.prefetch(requestCount()));
  assert.equal(globalThis.__cl.readCalls.length, 4);

  // 이번 수집에서 목록을 못 받은 출처의 글은 건너뛴다 (남은 4개를 시도할 차례지만)
  globalThis.__cl.failList = { dogdrip: true };
  globalThis.__cl.readCalls = [];
  try {
    await call(d, '/api/admin/crawl', { body: {}, cookie });
    await quiet(() => d.alarm());
  } finally {
    globalThis.__cl.failList = null;
  }
  assert.equal(globalThis.__cl.readCalls.length, 0);
});

test("'지금 수집'이 기다리는 동안 간격 변경·다시 예약이 그 알람을 늦추지 않고, cron 도 늦게 잡힌 알람을 바로 고친다", async () => {
  setItems();
  const storage = fakeStorage();
  const d = await boot(storage, { ...ENV, CRAWL_INTERVAL_MIN: '60' }); // 실시간 ON, 60분
  const cookie = await login(d);
  await quiet(() => d.alarm()); // 첫 수집 → 다음은 60분 뒤
  assert.ok(near(storage.alarm, Date.now() + 60 * 60e3));
  assert.equal((await call(d, '/api/admin/crawl', { body: {}, cookie })).status, 202);
  assert.ok(near(storage.alarm, Date.now()));

  const r = await call(d, '/api/admin/live', { body: { intervalMin: 30 }, cookie });
  assert.equal(r.json.intervalMin, 30);
  assert.equal(r.json.running, true);
  assert.ok(near(storage.alarm, Date.now()), `간격을 바꿔도 '지금 수집'은 바로 (${storage.alarm - Date.now()}ms 뒤로 잡힘)`);
  crawler.schedule(); // 옮기기 commit 등이 부르는 다시 예약
  assert.ok(near(storage.alarm, Date.now()));

  // cron: 어떤 이유로든 늦게 잡혀 있으면 바로로 고친다
  await storage.setAlarm(Date.now() + 30 * 60e3);
  await d.ensureAlarm();
  assert.ok(near(storage.alarm, Date.now()), `${storage.alarm - Date.now()}`);

  // 그 수집이 돌고 나면 다음은 간격 뒤 (바로 다시 걸지 않는다)
  const calls = globalThis.__cl.listCalls;
  await quiet(() => d.alarm());
  assert.ok(globalThis.__cl.listCalls > calls, '수집했다');
  assert.equal(storage.kv('crawlRequested'), undefined);
  assert.ok(near(storage.alarm, Date.now() + 30 * 60e3), `${storage.alarm - Date.now()}`);
  assert.equal((await call(d, '/api/meta', { cookie })).json.live.running, false);
});

test("'지금 수집'이 도중에 끊기면(알람이 다시 불림) 다시 수집하고, 같은 요청이 계속 끊기면 몇 번 뒤 그만둔다", async () => {
  setItems();
  const storage = fakeStorage();
  let d = await boot(storage); // 실시간 OFF
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  // 수집 도중의 표시: 시작했다는 표시가 수집 전에 저장돼 있어야 끊겨도 알 수 있다
  let open;
  globalThis.__cl.gate = new Promise((r) => (open = r));
  const run = quiet(() => d.alarm());
  let midFlag;
  try {
    await new Promise((r) => setTimeout(r, 10));
    midFlag = storage.kv('crawlRequested');
    assert.equal((await call(d, '/api/meta', { cookie })).json.live.running, true);
  } finally {
    globalThis.__cl.gate = null;
    open();
    await run;
  }
  assert.ok(midFlag?.startedAt && midFlag.tries === 1, JSON.stringify(midFlag));
  assert.equal(storage.kv('crawlRequested'), undefined, '끝나면 지운다');
  assert.equal(storage.alarm, null, '실시간이 꺼져 있으니 다음 알람 없음 (0 으로 다시 걸지 않는다)');
  const first = (await call(d, '/api/meta')).json.live.lastCrawlAt;

  // 그 순간 isolate 가 죽었다고 치고(표시가 남은 채) 다시 켠다 → 바로 알람 → 알람은 다시 수집한다
  putKv(storage, 'crawlRequested', midFlag);
  await new Promise((r) => setTimeout(r, 5));
  d = await boot(storage);
  assert.ok(near(storage.alarm, Date.now()), '다시 켜질 때 끊긴 수집을 바로 잡는다');
  assert.equal((await call(d, '/api/meta', { cookie })).json.live.running, true);
  let calls = globalThis.__cl.listCalls;
  await quiet(() => d.alarm());
  assert.ok(globalThis.__cl.listCalls > calls, '다시 수집했다');
  assert.notEqual((await call(d, '/api/meta')).json.live.lastCrawlAt, first);
  assert.equal(storage.kv('crawlRequested'), undefined);
  assert.equal(storage.alarm, null);

  // cron 도 끊긴 표시를 보면 바로 알람을 건다
  putKv(storage, 'crawlRequested', { at: Date.now(), startedAt: Date.now(), tries: 1 });
  await d.ensureAlarm();
  assert.ok(near(storage.alarm, Date.now()));
  // 같은 요청이 여러 번 끊겼으면(수집이 isolate 를 계속 죽이는 경우) 더 돌리지 않는다
  putKv(storage, 'crawlRequested', { at: Date.now(), startedAt: Date.now(), tries: CRAWL_RETRY_MAX });
  calls = globalThis.__cl.listCalls;
  await quiet(() => d.alarm());
  assert.equal(globalThis.__cl.listCalls, calls);
  assert.equal(storage.kv('crawlRequested'), undefined);
  assert.equal(storage.alarm, null);
  // 끊긴 표시가 남아 있어도 관리자가 다시 누르면 새 요청으로 센다
  putKv(storage, 'crawlRequested', { at: Date.now(), startedAt: Date.now(), tries: 2 });
  const again = await call(d, '/api/admin/crawl', { body: {}, cookie });
  assert.deepEqual(again.json, { started: true, running: true });
  assert.equal(storage.kv('crawlRequested').startedAt, undefined);
});

test('저장소 쓰기가 실패하는 동안: 읽기는 200, 관리자 변경은 500 이고 메모리·저장소 모두 그대로, 다시 되면 밀린 변경을 저장한다', async () => {
  setItems();
  globalThis.__cl.articles = { 'https://example.invalid/1': { html: '<p>웃긴 본문</p>' } };
  const storage = fakeStorage();
  const d = await boot(storage);
  const cookie = await login(d);
  await call(d, '/api/admin/crawl', { body: {}, cookie });
  await quiet(() => d.alarm());
  const id = 'humoruniv:1';
  assert.equal(storage.row(id).status, 'ok');

  storage.failPosts = true;
  try {
    // (1) 관리자 변경: 500, 메모리(목록)와 저장소 모두 바뀌지 않는다
    const r = await quiet(() => call(d, `/api/admin/posts/${encodeURIComponent(id)}`, { body: { manual: 'blocked' }, cookie }));
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: '저장하지 못했어요' });
    assert.equal(storage.row(id).manual, null);
    assert.ok(ids(await quiet(() => call(d, '/api/posts?board=all&size=100'))).includes(id), '메모리에도 반영되지 않았다');
    assert.ok(!ids(await quiet(() => call(d, '/api/posts?board=filtered&size=100', { cookie }))).includes(id));

    // (2) 읽기는 계속 된다 (미리보기가 남긴 변경은 저장하지 못한 채 밀려 있다)
    const read = await quiet(() => call(d, `/api/posts/${encodeURIComponent(id)}/read`));
    assert.equal(read.status, 200, read.text);
    assert.equal(storage.row(id).bodyChecked, undefined);
    assert.equal((await quiet(() => call(d, '/api/meta'))).status, 200);
    assert.equal((await quiet(() => call(d, '/api/posts'))).status, 200);
  } finally {
    storage.failPosts = false;
  }
  // (3) 쓰기가 다시 되면 다음 요청 때 밀린 변경을 저장한다
  assert.equal((await call(d, '/api/meta')).status, 200);
  assert.equal(storage.row(id).bodyChecked, true);
  const ok = await call(d, `/api/admin/posts/${encodeURIComponent(id)}`, { body: { manual: 'blocked' }, cookie });
  assert.equal(ok.status, 200);
  assert.equal(storage.row(id).manual, 'blocked');
});

test('같은 사이트 요청 간격: 미리보기가 밀려 있으면 기다리지 않고 502 와 원문 주소, 느린 출처 하나는 시간 예산에서 끊고 나머지로 수집을 끝낸다', async () => {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/hang')) return; // 응답하지 않는 출처
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<div id="c"><p>본문</p></div>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const INTERVAL = 300;
  const slow = mkSrc('slowsite', {
    async list(page) {
      return page === 1 ? Array.from({ length: 5 }, (_, i) => item(`s${i}`, `느린 사이트의 재미있는 글 ${i}`, { url: `${base}/post/${i}` })) : [];
    },
    async read(url) {
      const { $ } = await fetchHtml(url, { interval: INTERVAL });
      return { title: '', html: $('#c').html(), comments: [] };
    },
  });
  const hang = mkSrc('hangsite', {
    async list() {
      // 요청 하나의 시간 제한(2초)보다 출처 예산(0.4초)이 먼저 끊어야 한다
      await fetchHtml(`${base}/hang`, { interval: 0, timeout: 2000, retries: 0 });
      return [];
    },
  });
  globalThis.__clSources.push(slow, hang);
  try {
    setItems();
    const d = await boot(fakeStorage(), { ...ENV, PREVIEW_MAX_WAIT_SEC: '0.5', CRAWL_SOURCE_BUDGET_SEC: '0.4' });
    const cookie = await login(d);
    await call(d, '/api/admin/crawl', { body: {}, cookie });
    const t0 = Date.now();
    await quiet(() => d.alarm());
    assert.ok(Date.now() - t0 < 1500, `느린 출처 하나가 수집 전체를 붙잡지 않는다 (${Date.now() - t0}ms)`);
    const st = Object.fromEntries((await call(d, '/api/meta', { cookie })).json.sources.map((s) => [s.id, s.state]));
    assert.equal(st.hangsite.ok, false);
    assert.match(st.hangsite.error, /시간 초과/);
    assert.equal(st.humoruniv.ok, true);
    assert.equal(st.slowsite.ok, true);
    assert.ok((await call(d, '/api/posts?board=slowsite')).json.total >= 5);

    // 미리보기 5개를 한꺼번에: 간격 300ms, 대기 상한 0.5초 → 앞의 둘만 기다리고 나머지는 바로 502 + 원문 주소
    const t1 = Date.now();
    const rs = await Promise.all(
      [0, 1, 2, 3, 4].map(async (i) => {
        const r = await call(d, `/api/posts/${encodeURIComponent(`slowsite:s${i}`)}/read`);
        return { ...r, i, ms: Date.now() - t1 };
      }),
    );
    const okOnes = rs.filter((r) => r.status === 200);
    const busy = rs.filter((r) => r.status === 502);
    assert.equal(okOnes.length + busy.length, 5, rs.map((r) => `${r.status} ${r.text}`).join(' | '));
    assert.ok(okOnes.length >= 1 && busy.length >= 2, rs.map((r) => r.status).join());
    for (const b of busy) {
      assert.equal(b.json.url, `${base}/post/${b.i}`);
      assert.match(b.json.error, /잠시 뒤에 다시/);
      assert.ok(b.ms < 250, `기다리지 않고 바로 (${b.ms}ms)`);
    }
    assert.equal(hits.filter((h) => h.startsWith('/post/')).length, okOnes.length, '포기한 미리보기는 출처에 요청하지 않는다');
  } finally {
    globalThis.__clSources.splice(globalThis.__clSources.indexOf(slow), 2);
    srv.closeAllConnections();
    srv.close();
  }
});

test('scripts/push-to-cloud.js: 사이트가 다른 주소로 보내면(리다이렉트) 따라가지 않고 멈춘다 — 비밀번호가 http·다른 곳으로 나가지 않는다', async () => {
  // 가짜 fetch: 308 하나만 돌려준다
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 308, headers: { location: 'http://127.0.0.1:9/api/admin/login' } });
  };
  await assert.rejects(adminSession({ origin: 'https://simsimhae.test.workers.dev', password: 'secret-pw-123', fetch: fake }), (e) => {
    assert.match(e.message, /다른 주소/);
    assert.match(e.message, /127\.0\.0\.1:9/);
    assert.ok(!e.message.includes('secret-pw-123'));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');

  // 진짜 fetch 로도: https 대신 이 컴퓨터 안의 http 서버 둘 (A 가 308 로 B 를 가리킨다)
  const got = [];
  const b = createServer((req, res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      got.push(s);
      res.end('{}');
    });
  });
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  const a = createServer((req, res) => {
    req.resume();
    res.writeHead(308, { location: `http://127.0.0.1:${b.address().port}${req.url}` });
    res.end();
  });
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(adminSession({ origin: `http://127.0.0.1:${a.address().port}`, password: 'secret-pw-123' }), /다른 주소/);
    assert.deepEqual(got, [], 'B 는 비밀번호를 받지 않았다');
  } finally {
    for (const s of [a, b]) {
      s.closeAllConnections();
      s.close();
    }
  }

  // 묶음 크기는 클라우드가 받는 한 요청의 상한보다 작고, 클라우드가 받지 않을 만큼 큰 글은 보내지 않는다
  assert.ok(CHUNK_MB_MAX * 1024 * 1024 < IMPORT_MAX_BYTES);
  const storage = fakeStorage();
  const d = await boot(storage);
  const at = new Date().toISOString();
  const post = (i, extra = {}) => ({ id: `dogdrip:${i}`, source: 'dogdrip', postId: String(i), title: `옮길 글 ${i}`, url: `https://local.invalid/${i}`, firstSeenAt: at, ...extra });
  const data = { posts: [post(1), post(2, { note: 'x'.repeat(1_100_000) }), post(3)], sources: {}, lastCrawlAt: at, settings: { live: false }, rules: { block: [], adult: [], allow: [] } };
  const sizes = [];
  const viaDo = async (url, init) => {
    if (init.body) sizes.push(init.body.length);
    return d.fetch(new Request(url, { ...init, headers: { ...init.headers, 'cf-connecting-ip': '192.0.2.52' } }));
  };
  const out = await pushToCloud({ origin: 'https://simsimhae.test.workers.dev', password: ENV.ADMIN_PASSWORD, data, fetch: viaDo });
  assert.deepEqual(out, { posts: 2, skipped: 1 });
  assert.ok(Math.max(...sizes) < 100_000, '너무 큰 글은 보내지 않았다');
  assert.equal(storage.count('posts'), 2);
});
