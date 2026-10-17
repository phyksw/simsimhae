// 판정 기준 표시: Claude 판정(p.ai)을 저장할 때 criteria 로 같이 남긴다 (src/crawler.js runAi 와 src/api.js 의 판정 올리기).
// 지금 기준 = src/ai.js 의 CRITERIA·VIBE_TABLE = src/model/STYLE.md §7 (잡학 통과, 금지 소재 목록). 기준 문장을 바꾸면 이 값도 바꾼다.
// 이 표시가 없거나 다른 판정은 옛 기준 판정이라 판정 대기열의 "다시 보기"(review-queue?revisit=1) 대상이 되고,
// 푸어오버(src/boards.js pickWorthy)에서는 금지 소재 상한도 함께 본다.
// 저장소·수집기를 불러오지 않는 작은 파일로 둔다 (boards.js ↔ crawler.js 가 서로 불러오지 않게).
export const CRITERIA_VERSION = 'style-2026-10';
