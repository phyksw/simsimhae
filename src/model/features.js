// 선별 점수 모델의 특징 뽑기: 학습(train.js)과 점수 매기기(score.js)가 같은 함수를 쓴다.
// 제목(+말머리·출처)만 본다. 본문은 Workers 목록 단계에서는 없어서 쓰지 않는다.
// 순수 JS (node: 모듈 없음) — Workers 번들에서도 그대로 돈다.

/** 제목은 앞 TITLE_MAX 글자만 본다 (아주 긴 제목이 n-gram·정규식에 오래 붙잡히지 않게 — 실제 제목은 100자 안쪽) */
export const TITLE_MAX = 200;

/** 전각 영숫자·기호를 반각으로, 소문자로, NFC 로 */
function foldText(s) {
  return String(s ?? '')
    .slice(0, TITLE_MAX * 2)
    .normalize('NFC')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

// 형식 표지: n-gram 에는 넣지 않고 따로 플래그로 (쇼츠 제목은 다시 쓴 제목이라 이런 꼬리표가 거의 없어서, n-gram 에 남기면 "유튜브 제목처럼 생겼나"를 배운다)
// 짤: \b 는 한글 뒤에서 경계가 생기지 않으므로 뒤에 한글·영숫자가 오지 않는지로 본다 ("웃긴 짤"·"짤모음" 은 맞고 "짤렸다" 는 아님)
const RE_IMG = /\.?(?:jpe?g|png|webp)\b|짤(?:방|모음)?(?![가-힣a-z0-9])/;
const RE_VID = /\.?(?:gif|mp4|avi|webm)\b|움짤|영상|직캠|유튜브/;
const RE_TAG = /^\s*(?:\[[^\]]{1,10}\]|\([^)]{1,10}\)|[가-힣a-z]{1,4}\))\s*/; // [펌] (스압) 고전) 블라)
const RE_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/**
 * n-gram 용 제목 정리: 꼬리표·확장자·ㅋㅋ/ㅎㅎ/ㄷㄷ/ㅠㅠ·이모지·기호를 지우고 숫자는 0 으로.
 * @param {string} title
 */
export function cleanTitle(title) {
  let t = foldText(title).slice(0, TITLE_MAX).replace(RE_EMOJI, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/#\S+/g, ' ');
  for (let i = 0; i < 2; i++) t = t.replace(RE_TAG, ' ');
  return t
    .replace(/\.?(?:jpe?g|png|gif|mp4|webp|txt)\b/g, ' ')
    .replace(/[ㄱ-ㅎㅏ-ㅣ]{2,}/g, ' ') // ㅋㅋ ㅎㅎ ㄷㄷ ㅠㅠ ㅇㅇ
    .replace(/\d+/g, '0')
    .replace(/[^\p{L}\p{N}?\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const lenBucket = (n) => (n <= 8 ? 'xs' : n <= 14 ? 's' : n <= 22 ? 'm' : n <= 32 ? 'l' : 'xl');

/**
 * 글 하나의 특징 (중복 없는 문자열 목록, 정렬됨 — 결정적).
 * - g: 문자 1~3-gram (공백 = 단어 경계), w: 단어, p: 한글 단어 앞 2글자, b: 단어 2-gram
 * - f: 형식 표지, len: 길이 구간, s: 출처, c: 말머리, d:yt 쇼츠 제목(학습용 도메인 표지 — 사이트 글에는 없다)
 * - extra: 규칙 묶음 id 등 호출 측이 더하는 특징
 * @param {{title?: string, category?: string|null, source?: string|null}} post
 * @param {{domain?: 'site'|'yt', extra?: string[]}} [opts]
 * @returns {string[]}
 */
export function extractFeatures(post, opts = {}) {
  const raw = foldText(post?.title).slice(0, TITLE_MAX);
  const text = cleanTitle(post?.title);
  const out = new Set();
  if (opts.domain === 'yt') out.add('d:yt');
  if (post?.source) out.add(`s:${String(post.source).toLowerCase()}`);
  const cat = foldText(post?.category).replace(/\s+/g, '').slice(0, 12);
  if (cat) out.add(`c:${cat}`);

  if (RE_IMG.test(raw)) out.add('f:img');
  if (RE_VID.test(raw)) out.add('f:vid');
  if (/ㅋㅋ|ㅎㅎ/.test(raw)) out.add('f:ㅋ');
  if (/ㄷㄷ/.test(raw)) out.add('f:ㄷ');
  if (/[ㅠㅜ]{2}/.test(raw)) out.add('f:ㅠ');
  if (/[?？¿]/.test(raw)) out.add('f:?');
  if (/!/.test(raw)) out.add('f:!');
  if (/…|\.\./.test(raw)) out.add('f:..');
  if (/["“”'‘’]/.test(raw)) out.add('f:quote');
  if (RE_TAG.test(raw)) out.add('f:tag');
  if (/\d/.test(raw)) out.add('f:num');
  out.add(`len:${lenBucket([...text.replace(/\s/g, '')].length)}`);

  const chars = [...` ${text} `];
  for (let i = 0; i < chars.length; i++) {
    for (let n = 1; n <= 3 && i + n <= chars.length; n++) {
      const g = chars.slice(i, i + n).join('');
      if (!g.trim()) continue;
      if (n === 1 && g === ' ') continue;
      if (n > 1 && (g.startsWith('  ') || g.endsWith('  '))) continue;
      out.add(`g:${g}`);
    }
  }
  const words = text.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out.add(`w:${w}`);
    if (/^[가-힣]{3,}$/.test(w)) out.add(`p:${w.slice(0, 2)}`);
    if (i + 1 < words.length) out.add(`b:${w}_${words[i + 1]}`);
  }
  for (const e of opts.extra || []) out.add(e);
  return [...out].sort();
}

/** 규칙 매칭용 텍스트: 제목 + 말머리, 소문자·반각·NFC, 공백 하나로 */
export function ruleText(post) {
  return [foldText(post?.title).slice(0, TITLE_MAX), foldText(post?.category).slice(0, 40)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
