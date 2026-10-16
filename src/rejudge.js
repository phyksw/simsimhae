// 규칙 재판정: 관리자 금지어를 바꾸거나 기본 규칙(filter-rules.js 등)이 바뀌었을 때 저장된 글을 지금 규칙으로 다시 판정한다.
// 로컬 서버(src/server.js)와 클라우드(worker/site.js)가 같이 쓴다.
import { loadSources } from './sources/index.js';
import { classify, rulesFingerprint } from './filter.js';
import { forgetCached } from './reader.js';
import { currentMedians, rescorePost } from './crawler.js';
import * as store from './store.js';

/** 지금 규칙의 지문 */
export async function currentRulesHash() {
  return rulesFingerprint(await loadSources());
}

/**
 * 모든 글을 지금 규칙으로 다시 판정한다. 제목 기준으로 판정하고, 본문 검사 표시(bodyChecked)를 지워
 * 다음 미리보기 때 본문을 새 규칙으로 다시 검사하게 한다 (허용 단어로 본문 오탐을 풀 수 있게).
 * @returns {Promise<number>} 상태가 바뀐 글 수
 */
export async function rejudgeAll() {
  const list = await loadSources();
  const srcs = Object.fromEntries(list.map((s) => [s.id, s]));
  const med = currentMedians();
  let changed = 0;
  for (const p of store.allPosts()) {
    const before = p.status;
    p.auto = classify(p, srcs[p.source] || {});
    if (p.bodyChecked) {
      p.bodyChecked = false;
      forgetCached(p.id);
    }
    p.status = store.resolveStatus(p);
    if (p.status !== before) {
      changed++;
      rescorePost(p, med);
    }
    store.upsertPost(p);
  }
  store.updateSettings({ rulesHash: rulesFingerprint(list) }); // updateSettings 가 바로 저장한다
  return changed;
}

/**
 * 시작할 때: 판정 규칙이 지난번과 달라졌으면 기존 글을 다시 판정한다.
 * @returns {Promise<number|null>} 다시 판정했으면 상태가 바뀐 글 수, 그대로면 null
 */
export async function rejudgeIfRulesChanged() {
  const hash = await currentRulesHash();
  if (store.getSettings().rulesHash === hash) return null;
  return rejudgeAll();
}
