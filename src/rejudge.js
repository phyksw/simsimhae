// 규칙 재판정: 관리자 금지어를 바꾸거나 기본 규칙(filter-rules.js 등)이 바뀌었을 때 저장된 글을 지금 규칙으로 다시 판정한다.
// 로컬 서버(src/server.js)와 클라우드(worker/site.js)가 같이 쓴다.
import { loadSources } from './sources/index.js';
import { classify, rulesFingerprint } from './filter.js';
import { forgetCached } from './reader.js';
import { currentMedians, rescorePost, checkBody, pcFed, rejudgeKeepingBody } from './crawler.js';
import * as store from './store.js';

/** 지금 규칙의 지문 */
export async function currentRulesHash() {
  return rulesFingerprint(await loadSources());
}

/**
 * 모든 글을 지금 규칙으로 다시 판정한다. 제목 기준으로 판정하고, 본문 검사 표시(bodyChecked)를 지워
 * 다음 미리보기 때 본문을 새 규칙으로 다시 검사하게 한다 (허용 단어로 본문 오탐을 풀 수 있게).
 * PC 가 올려 준 미리보기(p.pcRead)가 있는 글은 이 서버가 원문을 못 가져오므로 저장된 본문으로 그 자리에서 다시 검사한다
 * (안 그러면 본문으로 차단된 글이 방문자가 열 때까지 공개 목록·판정 대기열에 다시 나온다).
 * PC 가 받는 출처의 글인데 미리보기가 없으면(기간이 지나 떼어 냄) 본문 검사로 올라간 판정을 그대로 둔다.
 * @returns {Promise<number>} 상태가 바뀐 글 수
 */
export async function rejudgeAll() {
  const list = await loadSources();
  const srcs = Object.fromEntries(list.map((s) => [s.id, s]));
  const med = currentMedians();
  let changed = 0;
  for (const p of store.allPosts()) {
    const before = p.status;
    const src = srcs[p.source] || {};
    // PC 가 받는 출처인데 미리보기가 떨어져 나간 글은 여기서 본문을 다시 볼 수 없다 → 본문 검사로 올라간 판정은 낮추지 않는다
    p.auto = !p.pcRead && pcFed(p.source) ? rejudgeKeepingBody(p, src) : classify(p, src);
    if (p.bodyChecked) {
      p.bodyChecked = false;
      forgetCached(p.id);
    }
    if (p.pcRead) checkBody(p, src, p.pcRead.text || '');
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
