// 소소한 이야기·소소한 웃음: 기간 제한 없이 조건에 맞는 최근 BOARD_KEEP 개를 남기고, 그 글들은 보관 기간이 지나도 지우지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'boards-'));
process.env.AI_MODERATION = '0';
process.env.BOARD_KEEP = '10';
const store = await import('../src/store.js');
const { boardPosts, keptBoardIds, BOARD_KEEP } = await import('../src/boards.js');

const day = 864e5;
function post(i, daysAgo, ai) {
  const at = new Date(Date.now() - daysAgo * day).toISOString();
  const p = {
    id: `humoruniv:${i}`, source: 'humoruniv', postId: String(i), title: `글 ${i}`, url: `https://example.com/${i}`,
    firstSeenAt: at, updatedAt: at, postedAt: at, dupOf: null, manual: null, nsfwHint: false,
    auto: { status: 'ok', reasons: [] }, ai, shortsScore: ai?.shortsScore ?? 0,
  };
  p.status = store.resolveStatus(p);
  store.upsertPost(p);
  return p;
}

test('기간 제한 없이 최근 BOARD_KEEP 개만 남는다', () => {
  assert.equal(BOARD_KEEP, 10);
  // 30일 전부터 오늘까지 웃긴 글 15개 (2일 간격), 그리고 웃기지 않은 글 5개
  for (let i = 0; i < 15; i++) post(i, i * 2, { verdict: 'ok', shortsScore: 80, vibe: 90, reason: '', model: 't', at: '' });
  for (let i = 100; i < 105; i++) post(i, 1, { verdict: 'not_humor', shortsScore: 0, vibe: 0, reason: '', model: 't', at: '' });

  for (const board of ['story', 'pick']) {
    const ids = boardPosts(board).map((p) => p.id);
    assert.equal(ids.length, 10, board);
    // 가장 최근 10개 (0~9번 = 0~18일 전) — 7일보다 오래된 글도 들어간다
    for (let i = 0; i < 10; i++) assert.ok(ids.includes(`humoruniv:${i}`), `${board} ${i}`);
    for (let i = 10; i < 15; i++) assert.ok(!ids.includes(`humoruniv:${i}`), `${board} ${i} 는 밀려남`);
  }
  const kept = keptBoardIds();
  assert.equal(kept.size, 10);
  assert.ok(kept.has('humoruniv:9'));
  assert.ok(!kept.has('humoruniv:100'));
});
