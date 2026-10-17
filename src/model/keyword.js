// 키워드 점수 (손으로 쓴 제목 신호, src/filter-rules.js 의 SHORTS_SIGNALS·VIBE_SIGNALS). 학습 점수 모델과 섞기 전의 원래 점수.
// filter.js 의 shortsScore·vibeGuess 가 이것과 학습 점수(score.js)를 섞고, 학습 스크립트(scripts/train-rule-model.js)가
// 섞는 비율을 정하고 기준선으로 비교할 때도 이것을 쓴다. 가중치 파일(weights.json) 없이도 읽히도록 score.js 를 import 하지 않는다.
// 순수 JS — Workers 번들에서도 돈다.
import { SHORTS_SIGNALS, SOURCE_BIAS, VIBE_SIGNALS } from '../filter-rules.js';

/** 전각 영숫자·기호를 반각으로, 소문자로, 공백 하나로 (filter.js normalize 와 같다 — 이름을 달리 둔 것은 Workers 번들에서 filter.js 함수 이름이 바뀌어 규칙 지문이 달라지지 않게) */
function normKw(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 제목은 앞 TITLE_SCAN 글자만 훑는다 (아주 긴 제목 방어. 길이 구간은 40자까지만 보므로 결과는 같다) */
const TITLE_SCAN = 300;

/** [단어, 점수] 목록을 소문자로 한 번만 바꿔 둔다 */
const lowerList = (list) => (list || []).map(([w, p]) => [String(w).toLowerCase(), p]);
const SHORTS_PLUS = lowerList(SHORTS_SIGNALS.plus);
const SHORTS_MINUS = lowerList(SHORTS_SIGNALS.minus);
const VIBE_ALL = [...lowerList(VIBE_SIGNALS.story), ...lowerList(VIBE_SIGNALS.visual), ...lowerList(VIBE_SIGNALS.tone), ...lowerList(VIBE_SIGNALS.warm)];

/**
 * 쇼츠 적합도 키워드 점수 0~100. 제목 신호 + 같은 소스 안에서의 반응(추천·댓글) 수준.
 * @param {{title?: string, source?: string, commentCount?: number|null, likes?: number|null, views?: number|null}} post
 * @param {{likes?: number, comments?: number, views?: number}} [medians] 같은 소스의 중앙값 (없으면 반응 점수 생략)
 */
export function keywordShorts(post, medians = {}) {
  const title = (typeof post?.title === 'string' ? post.title : String(post?.title ?? '')).slice(0, TITLE_SCAN);
  const t = normKw(title);
  let s = 40 + (SOURCE_BIAS[post?.source] || 0);
  let plusHits = 0;
  for (const [w, p] of SHORTS_PLUS) {
    if (t.includes(w)) {
      s += p;
      plusHits++;
    }
  }
  for (const [w, p] of SHORTS_MINUS) if (t.includes(w)) s += p;
  const len = [...title].length;
  if (len < 6) s -= 8; // "ㅋㅋㅋ", "제목" 같은 정보 없는 제목
  else if (len <= 9 && !plusHits) s -= 8; // "카리나", "리센느 원이" 같은 이름만 있는 사진 글
  else if (len >= 12 && len <= 40) s += 4; // 썰 제목은 보통 이 길이
  if (/\?|？/.test(title)) s += 2;

  const m = medians || {};
  const rel = (v, med) => (v != null && Number.isFinite(Number(v)) && med ? Math.log2((Math.max(0, Number(v)) + 1) / (med + 1)) : null);
  const parts = [rel(post?.likes, m.likes), rel(post?.commentCount, m.comments), rel(post?.views, m.views)].filter((x) => x != null);
  if (parts.length) {
    const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
    s += Math.max(-10, Math.min(18, avg * 7));
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

/**
 * "소소한 이야기" 분위기 키워드 점수 0~100 (제목 기반 어림값).
 * 글자로 된 썰·대화·반응·말의 재미면 높고, 사진·움짤·영상 위주이거나 분노·갈등·무거운 소재면 낮다.
 * @param {{title?: string, source?: string}} post
 */
export function keywordVibe(post) {
  const t = normKw(String(post?.title ?? '').slice(0, TITLE_SCAN));
  let s = 30 + (post?.source === 'blind' ? 10 : 0);
  for (const [w, p] of VIBE_ALL) if (t.includes(w)) s += p;
  return Math.max(0, Math.min(100, Math.round(s)));
}
