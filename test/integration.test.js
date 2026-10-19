// 영역 간 통합 회귀 테스트: reader(본문 판정) → store → crawler(제목 변경 재판정) / server 식 재판정(classify 제목 기준)이
// 서로의 약속대로 맞물리는지 본다. 가짜 소스만 쓰고 외부 사이트로는 요청을 보내지 않는다.
//  - classify(post, src, { body }) 는 본문에서 나온 사유에만 '본문 ' 을 붙인다 (filter)
//  - reader 는 그 판정을 auto 에 올리고, 글 페이지의 후방 표시는 post.nsfwHint 로 남긴다 (reader)
//  - crawler 는 제목이 바뀌어도 '본문 ' 사유로 올라간 판정은 낮추지 않고, 다음 미리보기 때 본문을 다시 검사하게 한다 (backend)
//  - server 의 규칙 재판정은 본문 없이 classify(p, src) 만 부르므로, 후방 표시로 간 므흣은 남아야 한다 (backend + reader)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_ENV = { ...process.env }; // 아래 before() 가 process.env 를 바꾸기 전의 값 (자식 서버용)
const tmpBase = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : os.tmpdir();
mkdirSync(tmpBase, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpBase, 'integ-'));
const serverDir = mkdtempSync(path.join(tmpBase, 'integ-srv-'));

// 가짜 소스 레지스트리 (src/sources/index.js 대신)
globalThis.__itItems = [];
globalThis.__itArticles = {};
const fakeSource = {
  id: 'humoruniv',
  name: '웃대 테스트',
  short: '웃대',
  strictness: 'normal',
  imageHosts: [],
  async list(page) {
    return page === 1 ? globalThis.__itItems.map((x) => ({ ...x })) : [];
  },
  async read(url) {
    const a = globalThis.__itArticles[url];
    if (!a) throw new Error('테스트 본문 없음');
    return { title: '', comments: [], ...a };
  },
};
globalThis.__itSources = [fakeSource];
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/sources/index.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const loadErrors = {};' +
          'export async function loadSources() { return globalThis.__itSources; }' +
          'export async function getSource(id) { return globalThis.__itSources.find((s) => s.id === id) || null; }',
      };
    }
    return nextLoad(url, context);
  },
});

let store;
let crawler;
let reader;
let filter;
before(async () => {
  Object.assign(process.env, { DATA_DIR: dataDir, CRAWL_INTERVAL_MIN: '0', AI_MODERATION: '0' });
  store = await import('../src/store.js');
  crawler = await import('../src/crawler.js');
  reader = await import('../src/reader.js');
  filter = await import('../src/filter.js');
});
after(() => {
  try {
    store?.saveNow();
  } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(serverDir, { recursive: true, force: true });
});

test('통합: 본문 판정(reader) → 제목 변경(crawler) → 다시 보기(reader) 에서 본문 사유가 이어진다', async () => {
  const url = 'https://example.invalid/h/1';
  const id = 'humoruniv:1';
  globalThis.__itItems = [{ postId: '1', title: '편의점 알바하다 겪은 웃긴 썰', url }];
  await crawler.crawlAll();
  assert.equal(store.getPost(id).status, 'ok', '제목만으로는 공개');

  globalThis.__itArticles[url] = { html: '<p>어제 살인 사건 피해자 사망 소식 보고 충격</p>' };
  const first = await reader.readPost(store.getPost(id));
  let p = store.getPost(id);
  assert.equal(first.statusChanged, true);
  assert.equal(p.status, 'blocked');
  assert.equal(p.bodyChecked, true);
  assert.ok(p.auto.reasons.length && p.auto.reasons.every((r) => r.startsWith('본문 ')), `본문 사유에만 접두: ${JSON.stringify(p.auto)}`);

  // 제목이 바뀌면 crawler 는 '본문 ' 사유 판정을 유지하고, 본문을 다시 검사하게 표시하고, 캐시를 비운다
  globalThis.__itItems[0].title = '편의점 알바하다 겪은 웃긴 썰 (수정)';
  await crawler.crawlAll();
  p = store.getPost(id);
  assert.equal(p.status, 'blocked', JSON.stringify(p.auto));
  assert.ok(p.auto.reasons.some((r) => r.startsWith('본문 ')), JSON.stringify(p.auto));
  assert.equal(p.bodyChecked, false);

  const second = await reader.readPost(p);
  assert.notEqual(second, first, '캐시가 비워져 원문을 다시 읽었다');
  assert.equal(store.getPost(id).bodyChecked, true);
  assert.equal(store.getPost(id).status, 'blocked');
});

test('통합: 사이트가 본문·그림·댓글 없는 빈 페이지를 주면 미리보기를 저장하지 않고 실패로 (예전에 저장된 빈 미리보기도 다시 읽는다)', async () => {
  const url = 'https://example.invalid/h/empty';
  const id = 'humoruniv:77';
  globalThis.__itItems.push({ postId: '77', title: '빈 페이지 시험 글', url });
  await crawler.crawlAll();
  globalThis.__itArticles[url] = { html: '<div class="view-content"> </div>', comments: [] };
  await assert.rejects(reader.readPost(store.getPost(id)), (e) => e.empty === true && /본문이 비어/.test(e.message));
  assert.equal(reader.hasCached(id), false, '빈 결과는 저장하지 않는다');
  assert.ok(!store.getPost(id).bodyChecked, '빈 본문으로 본문 검사를 끝낸 셈 치지 않는다');

  // 다음에 진짜 본문을 받으면 정상
  globalThis.__itArticles[url] = { html: '<p><img src="https://example.invalid/a.jpg"></p>', comments: [] };
  const ok = await reader.readPost(store.getPost(id));
  assert.equal(ok.mediaCount, 1);
  assert.equal(reader.hasCached(id), true);
  // 글자 없이 댓글만 있어도 빈 페이지는 아니다
  assert.equal(reader.isEmptyRead({ text: '', mediaCount: 0, comments: [{ text: 'ㅋㅋ' }] }), false);

  // 예전 코드가 저장해 둔 빈 미리보기: 저장소에 있어도 없는 셈 치고 다시 읽는다
  const saved = new Map([[id, { at: Date.now(), data: { title: '', html: '', text: '', mediaCount: 0, comments: [] } }]]);
  reader.setReadCache({ get: (k) => saved.get(k) || null, set: (k, at, data) => saved.set(k, { at, data }), delete: (k) => saved.delete(k), clear: () => saved.clear() });
  try {
    assert.equal(reader.hasCached(id), false, '저장된 빈 미리보기는 캐시로 치지 않는다');
    const again = await reader.readPost(store.getPost(id));
    assert.equal(again.mediaCount, 1, '원문을 다시 읽었다');
    assert.equal(saved.get(id).data.mediaCount, 1, '새 결과로 덮어썼다');
  } finally {
    reader.setReadCache(null);
  }
});

test('통합: 글 페이지의 후방 표시는 글에 남아, 본문 없는 재판정(server rejudgeAll 방식)·재수집에도 므흣이 유지된다', async () => {
  const url = 'https://example.invalid/h/2';
  const id = 'humoruniv:2';
  globalThis.__itItems.push({ postId: '2', title: '여름 휴가 사진 모음', url });
  await crawler.crawlAll();
  assert.equal(store.getPost(id).status, 'ok');

  globalThis.__itArticles[url] = { html: '<p>사진 몇 장</p>', nsfwHint: true };
  await reader.readPost(store.getPost(id));
  let p = store.getPost(id);
  assert.equal(p.nsfwHint, true);
  assert.equal(p.status, 'adult');

  // server.js rejudgeAll 과 같은 호출: 본문 없이 제목·말머리·후방 표시로만
  const again = filter.classify(p, fakeSource);
  assert.equal(again.status, 'adult', JSON.stringify(again));
  assert.ok(!again.reasons.some((r) => r.startsWith('본문 ')), '본문 없이 판정했으니 본문 사유는 없다');

  // 목록에는 후방 표시가 없어도 다시 수집할 때 지워지지 않는다
  await crawler.crawlAll();
  p = store.getPost(id);
  assert.equal(p.nsfwHint, true);
  assert.equal(p.status, 'adult');
});

test("통합: crawler 의 'crawl' 이벤트는 공개 수(addedPublic)와 내부용 freshIds 를 함께 넘긴다 (server 가 freshIds 로 게시판별 수를 센다)", async () => {
  globalThis.__itItems.push(
    { postId: '3', title: '고양이가 상자에 들어가는 방법', url: 'https://example.invalid/h/3' },
    { postId: '4', title: '약후) 여름 해변 사진', url: 'https://example.invalid/h/4' },
  );
  let got = null;
  const on = (d) => (got = d);
  crawler.events.on('crawl', on);
  try {
    const s = await crawler.crawlAll();
    assert.deepEqual([...s.freshIds].sort(), ['humoruniv:3', 'humoruniv:4']);
    assert.equal(s.added, 2);
    assert.equal(s.addedPublic, 1, '므흣 글은 공개 수에서 빠진다');
    assert.ok(got, 'crawl 이벤트');
    assert.deepEqual(Object.keys(got).sort(), ['added', 'addedPublic', 'aiReviewed', 'at', 'freshIds']);
    assert.deepEqual([...got.freshIds].sort(), ['humoruniv:3', 'humoruniv:4']);
  } finally {
    crawler.events.off('crawl', on);
  }
});

test('통합: 수집을 끈 출처라도 공개 글이 남아 있으면 /api/meta 가 보내 준다 (배지·"같은 글:" 이 id 로 보이지 않게)', async () => {
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const seed = (id, title, extra = {}) => {
    const [source, postId] = id.split(':');
    return {
      id, source, postId, title, url: `https://example.invalid/${source}/${postId}`,
      postedAt: null, firstSeenAt: iso(10 * 60e3), updatedAt: iso(10 * 60e3),
      commentCount: null, views: null, likes: null, category: null, nsfwHint: false, thumbnail: null,
      manual: null, ai: null, aiPending: false, dupOf: null, titleKey: '', shorts: null,
      auto: { status: 'ok', reasons: [], flags: {} }, status: 'ok', shortsScore: 50, ...extra,
    };
  };
  const posts = {};
  for (const p of [
    seed('humoruniv:1', '편의점 알바하다 겪은 웃긴 썰'),
    seed('dogdrip:2', '편의점 알바하다 겪은 웃긴 썰', { dupOf: 'humoruniv:1' }),
    seed('dogdrip:3', '고양이가 상자에 들어가는 방법'),
  ]) posts[p.id] = p;
  writeFileSync(path.join(serverDir, 'posts.json'), JSON.stringify({ posts, sources: {}, lastCrawlAt: null, settings: {} }));

  const env = { ...BASE_ENV, DATA_DIR: serverDir, PORT: '0', HOST: '127.0.0.1', CRAWL_INTERVAL_MIN: '0', AI_MODERATION: '0', ADMIN_PASSWORD: 'integ-admin', DISABLE_SOURCES: 'dogdrip,ygosu' };
  for (const k of ['ADULT_PASSWORD', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SESSION_SECRET', 'SOURCES']) delete env[k];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`서버 시작 시간 초과\n${out}`)), 20000);
      const onData = (b) => {
        out += b;
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m && /Claude 검수/.test(out)) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${m[1]}`);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (b) => (out += b));
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`서버가 종료됨 (${code})\n${out}`));
      });
    });
    const meta = await (await fetch(`${base}/api/meta`)).json();
    const dd = meta.sources.find((s) => s.id === 'dogdrip');
    assert.ok(dd, '공개 글이 남은 꺼진 출처는 방문자에게도 보낸다');
    assert.equal(dd.active, false);
    assert.equal(dd.short, '개드립');
    assert.equal(dd.count, 2);
    const list = await (await fetch(`${base}/api/posts?board=dogdrip&size=100`)).json();
    assert.equal(list.total, dd.count, '칩 숫자 = 목록 total');
    assert.ok(!meta.sources.some((s) => s.id === 'ygosu'), '글이 없는 꺼진 출처는 방문자에게 보내지 않는다');
    assert.ok(meta.sources.some((s) => s.id === 'humoruniv' && s.active), '수집 중인 출처는 그대로');
    const all = await (await fetch(`${base}/api/posts?board=all&size=100`)).json();
    const rep = all.items.find((p) => p.id === 'humoruniv:1');
    assert.deepEqual(rep.alsoOn.map((a) => a.source), ['dogdrip']);
    assert.ok(meta.sources.some((s) => s.id === rep.alsoOn[0].source), '"같은 글:" 배지의 출처 정보가 meta 에 있다');

    const adminMeta = await (await fetch(`${base}/api/meta`, { headers: { 'x-admin-key': 'integ-admin' } })).json();
    assert.equal(adminMeta.admin, true);
    assert.ok(adminMeta.sources.some((s) => s.id === 'ygosu' && !s.active), '관리자에게는 모든 출처');
  } finally {
    child.kill();
  }
});
