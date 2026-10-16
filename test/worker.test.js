// Cloudflare Worker 진입점(worker/index.js) 단위 테스트: 경로 나누기, 이미지 프록시, 보안 헤더, cron, 배포 설정, 런타임 중립 규칙.
// SiteDO 는 가짜 stub 으로 받아 넘기는지만 본다 (SiteDO 자체는 test/cloud.test.js). 외부로는 요청을 보내지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 로컬 쪽 모듈(src/platform/node.js)이 비밀 파일을 만들 곳 — data/ 를 건드리지 않게
const tmpBase = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : os.tmpdir();
mkdirSync(tmpBase, { recursive: true });
process.env.DATA_DIR = mkdtempSync(path.join(tmpBase, 'worker-'));
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

// cloudflare:workers 는 Workers 런타임에만 있다 → 테스트에서는 같은 모양의 빈 기반 클래스
// 출처 레지스트리는 가짜 (이미지 허용 호스트·Referer)
globalThis.__wkSources = [
  { id: 'dogdrip', name: '개드립', imageHosts: ['dogdrip.net'], referer: 'https://www.dogdrip.net/', list: async () => [], read: async () => ({}) },
  { id: 'humoruniv', name: '웃대', imageHosts: ['.humoruniv.com'], referer: null, list: async () => [], read: async () => ({}) },
];
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
          'export async function loadSources() { return globalThis.__wkSources; }' +
          'export async function getSource(id) { return globalThis.__wkSources.find((s) => s.id === id) || null; }',
      };
    }
    return next(url, context);
  },
});

const { default: workerEntry, createWorker, SiteDO } = await import('../worker/index.js');
const { PAGE_CSP } = await import('../worker/http.js');
const { sniffMedia, hostMatches, clientKey, RateWindow } = await import('../worker/img.js');

const NOW = Date.parse('2026-10-17T03:00:00.000Z');

/** 가짜 SITE 바인딩: 받은 요청과 cron 확인을 기록 */
function fakeSite() {
  const site = {
    names: [],
    requests: [],
    ensured: 0,
    idFromName(n) {
      site.names.push(n);
      return `id:${n}`;
    },
    get(id) {
      return {
        async fetch(req) {
          site.requests.push({ id, method: req.method, url: req.url, body: req.body ? await req.text() : null, ip: req.headers.get('cf-connecting-ip') });
          return new Response(JSON.stringify({ from: 'site' }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
        },
        async ensureAlarm() {
          site.ensured++;
          return { live: true, nextRunAt: null };
        },
      };
    },
  };
  return site;
}
const fakeAssets = {
  calls: 0,
  async fetch(req) {
    this.calls++;
    return new Response(`<!doctype html><title>${new URL(req.url).pathname}</title>`, { headers: { 'content-type': 'text/html' } });
  },
};
const makeEnv = (over = {}) => ({ SITE: fakeSite(), ASSETS: fakeAssets, ...over });

async function call(worker, env, p, { method = 'GET', headers = {}, body, ip } = {}) {
  const h = new Headers(headers);
  if (ip) h.set('cf-connecting-ip', ip);
  const ctx = { pending: [], waitUntil(pr) { this.pending.push(pr); } };
  const res = await worker.fetch(new Request(`https://simsimhae.test.workers.dev${p}`, { method, headers: h, body }), env, ctx);
  res.ctx = ctx;
  return res;
}

// ---------------------------------------------------------------------
// 경로·cron
// ---------------------------------------------------------------------

test('경로: /api/* 는 SiteDO("main") 로 그대로 넘기고(본문·방문자 IP 포함), 화면 파일은 ASSETS 로', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  for (const [method, p] of [
    ['GET', '/api/meta'],
    ['GET', '/api/posts?board=all&sort=hot'],
    ['GET', '/api/events'],
    ['PUT', '/api/sync/snapshot'],
    ['POST', '/api/admin/login'],
  ]) {
    const res = await call(w, env, p, { method, ip: '203.0.113.5', ...(method !== 'GET' ? { body: '{"a":1}', headers: { 'content-type': 'application/json' } } : {}) });
    assert.equal(res.status, 200, p);
    assert.deepEqual(await res.json(), { from: 'site' });
  }
  assert.deepEqual(new Set(env.SITE.names), new Set(['main']));
  assert.deepEqual(env.SITE.requests.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`), [
    'GET /api/meta',
    'GET /api/posts?board=all&sort=hot',
    'GET /api/events',
    'PUT /api/sync/snapshot',
    'POST /api/admin/login',
  ]);
  assert.equal(env.SITE.requests.at(-1).body, '{"a":1}');
  assert.equal(env.SITE.requests.at(-1).ip, '203.0.113.5');

  const before = fakeAssets.calls;
  const page = await call(w, env, '/index.html');
  assert.equal(page.status, 200);
  assert.equal(fakeAssets.calls, before + 1);
  assert.equal(env.SITE.requests.length, 5, '화면 파일은 DO 로 가지 않는다');
  assert.equal(page.headers.get('content-security-policy'), PAGE_CSP);
});

test('경로: 관리자 쿠키가 없는 옮기기(/api/admin/import) 요청은 DO 로 넘기지 않고 본문도 읽지 않은 채 401', async () => {
  const w = createWorker({ now: () => NOW });
  const env = makeEnv();
  let pulled = 0;
  const body = new ReadableStream(
    {
      pull(c) {
        pulled += 16384;
        c.enqueue(new Uint8Array(16384));
      },
    },
    { highWaterMark: 0 },
  );
  const res = await w.fetch(
    new Request('https://simsimhae.test.workers.dev/api/admin/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' }),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: '관리자 로그인이 필요해요' });
  assert.ok(pulled <= 16384, `본문을 ${pulled}바이트 읽었다`);
  for (const cookie of ['other=1', 'hg_admin=', 'x_hg_admin=abc']) {
    assert.equal((await call(w, env, '/api/admin/import', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).status, 401, cookie);
  }
  assert.equal(env.SITE.requests.length, 0, 'DO 는 이런 요청을 받지 않는다');
  // 쿠키가 있으면 DO 로 (진짜인지는 DO 가 본문을 읽기 전에 확인한다 — test/cloud.test.js)
  const ok = await call(w, env, '/api/admin/import', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'a=1; hg_admin=abc.def' }, body: '{"step":"begin"}' });
  assert.equal(ok.status, 200);
  assert.deepEqual(env.SITE.requests.map((r) => new URL(r.url).pathname), ['/api/admin/import']);
});

test('경로: SITE 바인딩이 없으면 503 JSON, 예전 D1 바인딩(DB)이 남아 있어도 쓰지 않는다', async () => {
  const w = createWorker({ now: () => NOW });
  const none = await call(w, { ASSETS: fakeAssets }, '/api/meta');
  assert.equal(none.status, 503);
  assert.deepEqual(Object.keys(await none.json()), ['error']);
  const db = { prepare() { throw new Error('D1 은 쓰지 않는다'); } };
  const res = await call(w, makeEnv({ DB: db }), '/api/meta');
  assert.equal(res.status, 200);
});

test('cron: 5분마다 SiteDO 의 알람을 확인한다 (waitUntil 로 끝까지)', async () => {
  const env = makeEnv();
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
  await workerEntry.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, env, ctx);
  await Promise.all(ctx.pending);
  assert.equal(env.SITE.ensured, 1);
  assert.deepEqual(env.SITE.names, ['main']);
  // 실패해도 예외를 밖으로 내지 않는다
  const broken = { idFromName: () => 'x', get: () => ({ ensureAlarm: async () => { throw new Error('down'); } }) };
  const orig = console.error;
  console.error = () => {};
  try {
    await workerEntry.scheduled({ cron: '*/5 * * * *' }, { SITE: broken }, {});
  } finally {
    console.error = orig;
  }
});

test('진입점: SiteDO 클래스를 내보낸다 (wrangler.jsonc 의 class_name)', () => {
  assert.equal(typeof SiteDO, 'function');
  assert.equal(SiteDO.name, 'SiteDO');
  for (const m of ['fetch', 'alarm', 'ensureAlarm']) assert.equal(typeof SiteDO.prototype[m], 'function', m);
});

// ---------------------------------------------------------------------
// 이미지 프록시 (Worker 에서 바로, 출처 정보는 src/sources 레지스트리)
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

function imgWorker(routes) {
  const upstream = fakeUpstream(routes);
  const w = createWorker({ now: () => NOW, fetch: upstream });
  const env = makeEnv();
  const get = (s, u, opts) => call(w, env, `/api/img?s=${encodeURIComponent(s)}&u=${encodeURIComponent(u)}`, opts);
  return { w, env, upstream, get };
}

test('이미지: 허용 호스트만, 앞부분으로 형식 판별 후 나머지는 그대로 흘린다 (DO 를 거치지 않음)', async () => {
  const total = PNG.length + REST.length;
  const { env, upstream, get } = imgWorker({
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
  const init = upstream.calls[0].init;
  assert.equal(init.headers.referer, 'https://www.dogdrip.net/');
  assert.match(init.headers['user-agent'], /Mozilla/);
  assert.equal(init.redirect, 'manual');
  assert.equal(env.SITE.requests.length, 0);
});

test('이미지: 허용 안 된 호스트·이상한 주소·모르는 출처는 원본에 요청하지 않고 403/400', async () => {
  const { upstream, get } = imgWorker({});
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
  const { upstream, get } = imgWorker({
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
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), PNG);
  upstream.calls.length = 0;
  assert.equal((await get('dogdrip', 'https://dogdrip.net/ssrf')).status, 403);
  assert.deepEqual(upstream.calls.map((c) => c.url), ['https://dogdrip.net/ssrf']);
  upstream.calls.length = 0;
  assert.equal((await get('dogdrip', 'https://dogdrip.net/l0')).status, 508);
  assert.equal(upstream.calls.length, 4);
});

test('이미지: SVG·HTML 은 거부, 원본 오류는 404/502, 너무 크면 413, 연결 실패는 504', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = new TextEncoder().encode('<!doctype html><html><script>alert(1)</script></html>');
  const { get } = imgWorker({
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

test('이미지: 길이를 알리지 않거나 압축된(길이를 믿을 수 없는) 응답도 크기 한도(IMG_MAX_BYTES)를 넘으면 끊고 원본을 취소한다', async () => {
  const MAX = 1024;
  /** 앞부분(PNG) 뒤로 512바이트씩 계속 주는 원본 본문. 얼마나 읽혔는지·취소됐는지 기록 */
  const endless = () => {
    const o = { pulled: 0, cancelled: false };
    o.stream = new ReadableStream(
      {
        pull(c) {
          if (o.pulled === 0) {
            o.pulled += PNG.length;
            return c.enqueue(PNG);
          }
          if (o.pulled > 1024 * 1024) return c.close();
          o.pulled += 512;
          c.enqueue(REST.slice(0, 512));
        },
        cancel() {
          o.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return o;
  };
  const cases = { chunked: endless(), gzip: endless(), lies: endless() };
  const upstream = fakeUpstream({
    // ① 길이 헤더 없는 chunked
    'https://img.dogdrip.net/chunked.png': () => new Response(cases.chunked.stream, { headers: { 'content-type': 'image/png' } }),
    // ② 압축(gzip)에 거짓 길이 — 런타임이 풀어 주므로 길이를 믿지 않는다
    'https://img.dogdrip.net/gzip.png': () => new Response(cases.gzip.stream, { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': '1000' } }),
    // ③ 압축 없이 알려 준 길이(600)보다 더 보내는 원본
    'https://img.dogdrip.net/lies.png': () => new Response(cases.lies.stream, { headers: { 'content-type': 'image/png', 'content-length': '600' } }),
    'https://img.dogdrip.net/small.png': () => new Response(chunked(PNG, REST.slice(0, 500)), { headers: { 'content-type': 'image/png' } }),
    'https://img.dogdrip.net/declared.png': () => new Response(chunked(PNG), { headers: { 'content-type': 'image/png', 'content-length': String(MAX + 1) } }),
  });
  const w = createWorker({ now: () => NOW, fetch: upstream, imgMaxBytes: MAX });
  const env = makeEnv();
  const get = (name) => call(w, env, `/api/img?s=dogdrip&u=${encodeURIComponent(`https://img.dogdrip.net/${name}.png`)}`);

  for (const [name, limit] of [['chunked', MAX], ['gzip', MAX], ['lies', 600]]) {
    const res = await get(name);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'image/png');
    let got = 0;
    await assert.rejects(
      (async () => {
        for await (const part of res.body) got += part.byteLength;
      })(),
      `${name}: 한도를 넘으면 본문이 오류로 끝난다`,
    );
    assert.ok(got <= limit, `${name}: 방문자에게 ${got}바이트 (한도 ${limit})`);
    await Promise.all(res.ctx.pending);
    assert.equal(cases[name].cancelled, true, `${name}: 원본을 취소한다`);
    assert.ok(cases[name].pulled < 8 * 1024, `${name}: 원본에서 ${cases[name].pulled}바이트만 읽었다`);
  }
  // 한도 안이면 그대로, 원본이 알려 준 길이가 한도를 넘으면 처음부터 413 (설정값 기준)
  const small = await get('small');
  assert.equal(small.status, 200);
  assert.equal((await small.arrayBuffer()).byteLength, PNG.length + 500);
  assert.equal((await get('declared')).status, 413);
});

test('이미지: Range 요청을 넘기고, 중간 구간은 원래 영상 형식으로', async () => {
  const mid = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
  const { upstream, get } = imgWorker({
    'https://dogdrip.net/v.mp4': () =>
      new Response(mid, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 1000-1999/5000', 'content-length': '1000', 'accept-ranges': 'bytes' } }),
  });
  const res = await get('dogdrip', 'https://dogdrip.net/v.mp4', { headers: { range: 'bytes=1000-1999' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-range'), 'bytes 1000-1999/5000');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), mid);
  assert.equal(upstream.calls[0].init.headers.range, 'bytes=1000-1999');
  await get('dogdrip', 'https://dogdrip.net/v.mp4', { headers: { range: 'items=1-2' } });
  assert.equal(upstream.calls.at(-1).init.headers.range, undefined, '이상한 Range 는 넘기지 않는다');
});

test('이미지: 접속자당 분당 600번을 넘으면 429 (다른 접속자는 따로)', async () => {
  const { get } = imgWorker({});
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
    const { upstream, get } = imgWorker({
      'https://dogdrip.net/c.png': () => new Response(chunked(PNG, REST), { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length + REST.length) } }),
    });
    const first = await get('dogdrip', 'https://dogdrip.net/c.png');
    const a = new Uint8Array(await first.arrayBuffer());
    await Promise.all(first.ctx.pending);
    assert.equal(store.size, 1);
    const second = await get('dogdrip', 'https://dogdrip.net/c.png');
    assert.equal(second.status, 200);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), a);
    assert.equal(upstream.calls.length, 1);
    await get('dogdrip', 'https://dogdrip.net/c.png', { headers: { range: 'bytes=0-10' } });
    assert.equal(upstream.calls.length, 2, '범위 요청은 캐시를 쓰지 않는다');
  } finally {
    globalThis.caches = prev;
  }
});

// ---------------------------------------------------------------------
// 보안 헤더·오류
// ---------------------------------------------------------------------

test('보안 헤더: DO 응답·바꿀 수 없는 응답에도 로컬 서버와 같은 CSP·Referrer-Policy·nosniff', async () => {
  const w = createWorker({ now: () => NOW });
  const res = await call(w, makeEnv(), '/api/meta');
  assert.equal(res.headers.get('content-security-policy'), PAGE_CSP);
  assert.match(PAGE_CSP, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const immutableAssets = { fetch: async () => Response.redirect('https://simsimhae.test.workers.dev/', 302) };
  const r2 = await call(w, makeEnv({ ASSETS: immutableAssets }), '/old');
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('x-content-type-options'), 'nosniff');
});

test('보안 헤더: 화면 파일(public/)은 Worker 를 거치지 않으므로 public/_headers 가 같은 헤더를 모든 경로에 붙인다', () => {
  const rules = readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
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

test('오류: DO 가 실패하면 내부 정보 없이 500 JSON', async () => {
  const w = createWorker({ now: () => NOW });
  const site = { idFromName: () => 'x', get: () => ({ fetch: async () => { throw new Error('C:\\secret\\path stack'); } }) };
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await call(w, { SITE: site }, '/api/meta');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '서버 오류가 났어요' });
  } finally {
    console.error = orig;
  }
});

// ---------------------------------------------------------------------
// 배포 설정·런타임 중립
// ---------------------------------------------------------------------

test('배포 설정(wrangler.jsonc): 진입점·화면 파일·DO(SQLite)·cron·CPU 한도·nodejs_compat, 비밀·D1 없음', () => {
  const raw = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')); // 줄 전체 주석만 쓴다
  assert.equal(cfg.name, 'simsimhae');
  assert.equal(cfg.main, 'worker/index.js');
  assert.ok(cfg.compatibility_flags.includes('nodejs_compat'));
  assert.ok(cfg.compatibility_date <= '2026-10-06', '설치된 workerd 보다 늦은 날짜는 쓰지 않는다');
  assert.equal(cfg.assets.directory, './public');
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*']);
  assert.deepEqual(cfg.durable_objects.bindings, [{ name: 'SITE', class_name: 'SiteDO' }]);
  assert.deepEqual(cfg.migrations, [{ tag: 'v1', new_sqlite_classes: ['SiteDO'] }]);
  assert.deepEqual(cfg.triggers.crons, ['*/5 * * * *']);
  assert.ok(cfg.limits.cpu_ms > 30000 && cfg.limits.cpu_ms <= 300000);
  assert.equal(cfg.d1_databases, undefined, '예전 D1 스냅샷은 쓰지 않는다');
  assert.ok(!/"(ADMIN_PASSWORD|ADULT_PASSWORD|SESSION_SECRET|ANTHROPIC_API_KEY)"\s*:/.test(raw), '비밀은 설정 파일에 쓰지 않는다');
});

test('런타임 중립: Workers 번들에서는 #platform 이 클라우드용으로 풀리고, 공용 모듈은 파일 시스템을 직접 쓰지 않는다', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cond = pkg.imports['#platform'];
  assert.equal(Object.keys(cond)[0], 'workerd', 'wrangler 의 조건(workerd)이 먼저 맞아야 한다');
  assert.equal(cond.workerd, './src/platform/cloud.js');
  assert.equal(cond.node, './src/platform/node.js');
  // 로컬 전용 파일(서버·공개 사이트 업로드·Node 환경) 말고는 node:fs·path·import.meta.url·폴더 읽기를 쓰지 않는다
  const nodeOnly = new Set(['server.js', 'publish.js', 'platform/node.js']);
  const files = [];
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith('.js')) files.push(`${rel}${e.name}`);
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const f of files.filter((x) => !nodeOnly.has(x))) {
    const code = readFileSync(path.join(ROOT, 'src', f), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
    assert.doesNotMatch(code, /from 'node:(fs|path|url|child_process)'|import\.meta\.url|readdirSync|process\.cwd\(/, f);
  }
});

test('출처 레지스트리: src/sources 의 어댑터 파일이 모두 정적 목록에 들어 있다 (새 파일을 넣고 빠뜨리지 않게)', () => {
  const files = readdirSync(path.join(ROOT, 'src/sources'))
    .filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'))
    .map((f) => f.slice(0, -3))
    .sort();
  // 진짜 레지스트리는 다른 프로세스에서 (이 파일은 가짜 레지스트리를 쓴다). 불러오기만 하고 외부 요청은 하지 않는다.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/sources/index.js'); console.log(JSON.stringify({ ids: (await m.loadSources()).map((s) => s.id), errors: m.loadErrors }));"], { cwd: ROOT });
  const { ids, errors } = JSON.parse(String(out).trim().split('\n').at(-1));
  assert.deepEqual([...ids].sort(), files);
  assert.deepEqual(errors, {});
});

// ---------------------------------------------------------------------
// 도우미 단위
// ---------------------------------------------------------------------

test('도우미: 접속자 키·요청 수 제한·형식 판별·호스트 일치 (로컬 서버와 같은 규칙)', () => {
  const req = (ip) => new Request('https://x/', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
  assert.equal(clientKey(req('203.0.113.5')), '203.0.113.5');
  assert.equal(clientKey(req('2001:DB8:1:2:3:4:5:6')), '2001:0db8:0001:0002::/64');
  assert.equal(clientKey(req('::ffff:192.0.2.1')), '192.0.2.1');
  assert.equal(clientKey(req()), 'unknown');
  const rw = new RateWindow(2, 1000);
  assert.equal(rw.hit('a', NOW), 0);
  assert.equal(rw.hit('a', NOW), 0);
  assert.equal(rw.hit('a', NOW), 1);
  assert.equal(rw.hit('a', NOW + 1001), 0);

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
