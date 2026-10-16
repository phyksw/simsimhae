// 중복 묶기: 같은 제목·비슷한 제목(강조어만 다른 것)을 먼저 본 글로 묶고, 고리가 생기지 않으며, 후방 표시를 서로 나눈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'dedup-'));
process.env.AI_MODERATION = '0';
const store = await import('../src/store.js');
const { relinkAll } = await import('../src/crawler.js');
const { titleKey, classify } = await import('../src/filter.js');

function post(id, title, at, extra = {}) {
  const [source] = id.split(':');
  const p = { id, source, postId: id.split(':')[1], title, url: `https://example.com/${id}`, firstSeenAt: at, updatedAt: at, titleKey: titleKey(title), dupOf: null, manual: null, ai: null, nsfwHint: false, ...extra };
  p.auto = classify(p);
  p.status = store.resolveStatus(p);
  store.upsertPost(p);
  return p;
}

test('강조어만 다른 제목은 먼저 본 글로 묶인다', async () => {
  post('humoruniv:1', '택시 탈 때 ㅈㄹ 이해 안되는 반응', '2026-10-16T10:00:00.000Z');
  post('inven:2', '택시 탈 때 존나 이해 안되는 반응', '2026-10-16T11:00:00.000Z');
  post('dogdrip:3', '완전히 다른 고양이 이야기 레전드', '2026-10-16T12:00:00.000Z');
  await relinkAll();
  assert.equal(store.getPost('inven:2').dupOf, 'humoruniv:1');
  assert.equal(store.getPost('humoruniv:1').dupOf, null);
  assert.equal(store.getPost('dogdrip:3').dupOf, null);
});

test('같은 시각에 들어온 같은 제목끼리 서로를 가리키지 않는다', async () => {
  post('ppomppu:10', '순대국 집에서 직장 상사를 만난 사람', '2026-10-16T13:00:00.000Z');
  post('todayhumor:11', '순대국 집에서 직장 상사를 만난 사람.', '2026-10-16T13:00:00.000Z');
  await relinkAll();
  const a = store.getPost('ppomppu:10');
  const b = store.getPost('todayhumor:11');
  assert.ok(!(a.dupOf && b.dupOf), '둘 다 사본이면 고리');
  assert.ok(a.dupOf === b.id || b.dupOf === a.id, '하나는 다른 하나에 묶여야 함');
});

test('한쪽에만 후방 표시가 있으면 다른 쪽도 잠금 게시판으로', async () => {
  post('etoland:20', '해변에서 찍은 사진 모음집 대방출', '2026-10-16T14:00:00.000Z', { nsfwHint: true });
  post('dcinside:21', '해변에서 찍은 사진 모음집 대방출', '2026-10-16T15:00:00.000Z');
  await relinkAll();
  const copy = store.getPost('dcinside:21');
  assert.equal(copy.dupOf, 'etoland:20');
  assert.equal(copy.status, 'adult');
});
