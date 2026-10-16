// 같은 사이트 요청 간격(src/lib/http.js throttle): 수집 목록 요청이 미리보기보다 먼저, 미리보기는 대기 상한·취소.
// 출처 대신 이 컴퓨터 안의 HTTP 서버(127.0.0.1)만 쓴다. 간격은 실제(1.2~10초)보다 짧게 줄여서.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchText, withRequestScope, BusyError } from '../src/lib/http.js';

const servers = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

/** 받은 요청의 경로·시각을 적는 가짜 출처 서버 (테스트마다 새로 — 주소(포트)가 다르니 대기열도 따로) */
async function origin() {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push({ path: req.url, at: Date.now() });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, hits };
}

const preview = (url, interval, scope = {}) => withRequestScope({ priority: 'preview', ...scope }, () => fetchText(url, { interval }));
const crawl = (url, interval) => withRequestScope({ priority: 'crawl' }, () => fetchText(url, { interval }));

test('수집 목록 요청은 기다리는 미리보기들보다 먼저 나가고, 같은 사이트 간격은 그대로 지킨다', async () => {
  const I = 150;
  const { base, hits } = await origin();
  const previews = Array.from({ length: 6 }, (_, i) => preview(`${base}/post/${i}`, I, { maxWaitMs: 60_000 }));
  await new Promise((r) => setTimeout(r, 20));
  const list = crawl(`${base}/list`, I);
  await Promise.all([list, ...previews]);
  const order = hits.map((h) => h.path);
  assert.equal(order.length, 7);
  assert.ok(order.indexOf('/list') <= 2, `목록 요청이 간격 1~2번 안에 나가야 한다: ${order.join(' ')}`);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].at - hits[i - 1].at >= I * 0.8, `간격 ${hits[i].at - hits[i - 1].at}ms`);
});

test('미리보기: 기다릴 시간이 상한을 넘으면 기다리지도 다시 시도하지도 않고 바로 BusyError(503), 출처에는 가지 않는다', async () => {
  const I = 300;
  const { base, hits } = await origin();
  const t0 = Date.now();
  const rs = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      preview(`${base}/p/${i}`, I, { maxWaitMs: 700 }).then(
        () => Date.now() - t0,
        (e) => {
          e.ms = Date.now() - t0;
          throw e;
        },
      ),
    ),
  );
  // 예상 대기 0·300·600ms 는 기다리고, 900·1200ms 는 바로 포기
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
  for (const r of rs.slice(3)) {
    assert.ok(r.reason instanceof BusyError, String(r.reason));
    assert.equal(r.reason.status, 503);
    assert.equal(r.reason.busy, true);
    assert.ok(r.reason.ms < 100, `바로 포기 (${r.reason.ms}ms, 재시도 대기 없음)`);
  }
  assert.equal(hits.length, 3);
});

test('미리보기: 기다리는 중에 취소하면 대기열 자리를 내놓아 뒤 요청이 앞당겨진다', async () => {
  const I = 250;
  const { base, hits } = await origin();
  const a = preview(`${base}/a`, I);
  const ac = new AbortController();
  const b = preview(`${base}/b`, I, { signal: ac.signal });
  const c = preview(`${base}/c`, I);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(b, (e) => e.name === 'AbortError');
  await Promise.all([a, c]);
  assert.deepEqual(hits.map((h) => h.path), ['/a', '/c']);
  assert.ok(hits[1].at - hits[0].at < I * 1.6, `c 가 b 의 자리로 (${hits[1].at - hits[0].at}ms)`);
});

test('미리보기: 뒤에 온 수집 요청에 밀려 상한을 넘기면 그때 포기한다', async () => {
  const I = 200;
  const { base, hits } = await origin();
  const first = crawl(`${base}/l0`, I); // 바로 나간다
  await new Promise((r) => setTimeout(r, 5));
  const p = preview(`${base}/p`, I, { maxWaitMs: 300 }); // 예상 200ms → 기다린다
  const lists = [crawl(`${base}/l1`, I), crawl(`${base}/l2`, I)]; // 미리보기 앞에 선다 → 미리보기는 600ms 뒤가 된다
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.busy === true);
  assert.ok(Date.now() - t0 < 450, `상한(300ms) 무렵에 포기 (${Date.now() - t0}ms)`);
  await Promise.all([first, ...lists]);
  assert.deepEqual(hits.map((h) => h.path), ['/l0', '/l1', '/l2']);
});

test('범위 밖(스크립트 등)의 요청은 예전처럼 들어온 순서대로, 상한 없이 기다린다', async () => {
  const I = 100;
  const { base, hits } = await origin();
  await Promise.all(Array.from({ length: 4 }, (_, i) => fetchText(`${base}/n/${i}`, { interval: I })));
  assert.deepEqual(hits.map((h) => h.path), ['/n/0', '/n/1', '/n/2', '/n/3']);
});
