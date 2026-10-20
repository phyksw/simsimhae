// 주제 탭: 웃긴 정도가 아니라 "무슨 이야기인가"로 고른 게시판 (2026-10-20 운영자 요청).
// Claude 판정(PC 판정 루틴)이 글마다 주제(p.ai.topics)를 붙이고, 게시판은 그 주제가 붙은 글을 모은다 (src/boards.js).
// 이 파일은 아무것도 import 하지 않는다 — PC 루틴(scripts/cloud-review.js)도 판정 검사에 같은 목록을 쓴다.

/** 주제 게시판: id 는 주소(#/b/<id>)·판정 칸(topics)에 쓰는 값, label 은 화면 이름 */
export const TOPIC_BOARDS = Object.freeze([
  { id: 'sub', label: '🎮 서브컬처' },
  { id: 'stream', label: '📺 방송' },
]);
export const TOPIC_IDS = Object.freeze(TOPIC_BOARDS.map((t) => t.id));

/** 판정 파일·요청의 topics 값 → 알려진 주제만, 중복 없이 (배열이 아니면 null) */
export function cleanTopics(v) {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((x) => typeof x === 'string' && TOPIC_IDS.includes(x)))];
}

/** 글에 붙은 주제: 관리자 지정(p.manualTopics, 빈 목록이면 "주제 없음") > Claude 판정(p.ai.topics) */
export function topicsOf(p) {
  return cleanTopics(p?.manualTopics) || cleanTopics(p?.ai?.topics) || [];
}
