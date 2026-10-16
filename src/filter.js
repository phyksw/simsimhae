// 키워드 기반 검열 + 쇼츠 적합도 점수. 즉시·무료로 돌아가는 1차 판정이고, Claude 검수(ai.js)가 켜져 있으면 그 결과와 합쳐진다.
// 관리자 금지어는 저장소 백엔드에 둔다: 로컬 = data/custom-rules.json (src/platform/node.js), 클라우드 = DO 저장소 (setRulesBackend).
import { createHash } from 'node:crypto';
import * as platform from '#platform';
import { RULES, CATEGORY_RULES, CATEGORY_EXACT, SHORTS_SIGNALS, SOURCE_BIAS, VIBE_SIGNALS } from './filter-rules.js';

const WEIGHT = { strong: 2, weak: 1, soft: 0.5 };
const CATEGORIES = Object.keys(RULES);
/** 본문 점수 기준점 기본값: 서로 다른 strong 단어 2개 */
const BODY_THRESHOLD = 4;
const BODY_MAX = 3000;

// 단어 사이에 끼워 회피하는 문자: 글자·숫자가 아닌 모든 것 + 가운뎃점으로 쓰이는 아래아(ㆍ, ᆞ — 유니코드상 글자라 따로)
const SEP = String.raw`(?:[^\p{L}\p{N}]|[ㆍᆞ])`;
// 단어 시작: 맨 앞, 글자·숫자가 아닌 문자 뒤, 또는 ㅋㅋ·ㅎㅎ 같은 낱자 뒤
const WORD_START = String.raw`(?<=^|[^\p{L}\p{N}]|[ㄱ-ㅣㆍᆞ])`;
// 띄어 쓴 회피형의 끝: 맨 끝, 구분 문자, 낱자, 또는 조사 ("윤석 열이", "노 무현을")
const WORD_END = String.raw`(?=$|[^\p{L}\p{N}]|[ㄱ-ㅣㆍᆞ]|한테|[이가은는을를의도에랑과와들])`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** 관리자가 추가한 규칙: { block: [...], adult: [...], allow: [...] } */
let custom = { block: [], adult: [], allow: [] };
let compiled = null;
/** 금지어 저장소 { load(): rules|null, save(rules) } (없으면 메모리에만) */
let rulesStore = platform.rulesBackend();

/** 금지어 저장소를 바꾸고 거기서 다시 읽는다 (클라우드: SiteDO) */
export function setRulesBackend(b) {
  rulesStore = b || null;
  return loadCustomRules();
}

export function loadCustomRules() {
  const j = rulesStore?.load();
  custom = {
    block: Array.isArray(j?.block) ? j.block : [],
    adult: Array.isArray(j?.adult) ? j.adult : [],
    allow: Array.isArray(j?.allow) ? j.allow : [],
  };
  compiled = null;
  return custom;
}

export function getCustomRules() {
  return custom;
}

export function saveCustomRules(next) {
  const clean = (arr) =>
    [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim().toLowerCase()).filter((s) => s.length >= 1 && s.length <= 40))].slice(0, 500);
  custom = { block: clean(next?.block), adult: clean(next?.adult), allow: clean(next?.allow) };
  rulesStore?.save(custom);
  compiled = null;
  return custom;
}

/** 전각 영숫자·기호(（속보）, ｋｂｓ)를 반각으로 바꾸고 소문자로. 공백은 건드리지 않는다. */
function fold(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * 공백·기호를 뺀 비교용 문자열. ㆍ(U+318D)·ᆞ 는 유니코드상 글자라 따로 지운다.
 * (NFKC 는 ㅎㅂ 같은 낱자를 조합용 자모로 바꿔 원문 매칭을 깨뜨리므로 쓰지 않는다)
 */
export function compact(s) {
  return fold(s)
    .replace(/[ㆍᆞ·‧∙・･]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalize(s) {
  return fold(s).replace(/\s+/g, ' ').trim();
}

/**
 * 규칙 단어 하나를 비교용으로 준비한다.
 * - 문자열: 부분 문자열. 글자·숫자·공백으로만 된 3글자 이상이면 회피형(띄어쓰기·기호 끼우기)도 찾는다.
 *   ("kbs)" 같은 기호 포함 표식은 원문 그대로만 찾아야 "KBS 드라마" 를 잘못 잡지 않는다)
 * - '^단어': 단어 맨 앞에서만 (회피형 매칭 없음).
 * - { re, label, titleOnly?, assist? }: 정규식.
 */
function term(t, weight, tier) {
  if (t instanceof RegExp) t = { re: t, label: t.source };
  if (t && typeof t === 'object') {
    const flags = String(t.re.flags || '').replace(/[gy]/g, ''); // test() 가 lastIndex 에 끌려가지 않게
    return { label: t.label || t.re.source, re: new RegExp(t.re.source, flags), weight, tier, titleOnly: !!t.titleOnly, assist: !!t.assist };
  }
  let lower = fold(t);
  const wordStart = lower.length > 1 && lower.startsWith('^');
  if (wordStart) lower = lower.slice(1);
  if (!lower.trim()) return { label: '', term: '', weight, tier };
  const chars = [...lower];
  // 본문용: 2글자 이하 단어는 단어 시작에서만 ("키운지"→운지, "가야한다"→야한 방지)
  const startRe = new RegExp(WORD_START + escapeRe(lower), 'u');
  if (wordStart) return { label: lower, term: lower, re: startRe, startRe, weight, tier };
  const compactTerm = compact(lower);
  const useCompact = /^[\p{L}\p{N}\s]+$/u.test(lower) && [...compactTerm].length >= 3;
  return {
    label: lower,
    term: lower,
    // 붙여 쓴 형태 ("극단적 선택" → "극단적선택")
    compactTerm: useCompact && compactTerm !== lower ? compactTerm : null,
    // 띄어 쓰거나 기호를 끼운 회피형: 덩어리 앞뒤가 단어 경계여야 한다 ("왼쪽 발이"·"수박 들고" 제외)
    spaced: useCompact ? new RegExp(WORD_START + [...compactTerm].map(escapeRe).join(`${SEP}*`) + WORD_END, 'u') : null,
    startRe: chars.length <= 2 ? startRe : null,
    weight,
    tier,
  };
}

function compile() {
  if (compiled) return compiled;
  const allow = custom.allow.map(fold);
  const byLength = (a, b) => b.length - a.length;
  const cats = {};
  for (const cat of CATEGORIES) {
    const r = RULES[cat];
    const terms = [];
    for (const tier of ['strong', 'weak', 'soft']) {
      for (const t of r[tier] || []) terms.push(term(t, WEIGHT[tier], tier));
    }
    cats[cat] = {
      terms,
      exceptions: [...(r.exceptions || []).map(fold), ...allow].sort(byLength),
      bodyMarkers: (r.bodyMarkers || []).map(fold),
    };
  }
  cats.custom = { terms: custom.block.map((t) => term(t, 2, 'strong')), exceptions: [...allow].sort(byLength), bodyMarkers: [] };
  cats.customAdult = { terms: custom.adult.map((t) => term(t, 2, 'strong')), exceptions: [...allow].sort(byLength), bodyMarkers: [] };
  compiled = cats;
  return compiled;
}

function stripExceptions(t, exceptions) {
  for (const ex of exceptions) {
    if (ex && t.includes(ex)) t = t.split(ex).join(' ');
  }
  return t;
}

const NONE = Object.freeze({ score: 0, hits: [], markers: [] });

/**
 * 한 분류에 대해 매칭된 단어와 점수.
 * 제목 모드: 모든 단어, 회피형 매칭 포함. titleOnly 정규식은 opts.title 에만.
 * 본문 모드(opts.body): strong 단어만, 회피형 매칭 없음, 2글자 이하는 단어 시작에서만, titleOnly 제외.
 *   "성폭행" 이 "폭행" 까지 두 단어로 세지지 않게, 다른 걸린 단어에 포함된 단어는 뺀다.
 */
function scoreCategory(c, text, opts = {}) {
  const body = !!opts.body;
  const t = stripExceptions(normalize(text), c.exceptions);
  const tt = opts.title != null ? stripExceptions(normalize(opts.title), c.exceptions) : t;
  let hits = [];
  let assist = [];
  for (const x of c.terms) {
    if (!x.label) continue;
    if (body && (x.tier !== 'strong' || x.titleOnly)) continue;
    let found;
    if (x.re) found = x.re.test(x.titleOnly ? tt : t);
    else if (body) found = x.startRe ? x.startRe.test(t) : t.includes(x.term) || (x.compactTerm !== null && t.includes(x.compactTerm));
    else found = t.includes(x.term) || (x.compactTerm !== null && t.includes(x.compactTerm)) || (x.spaced !== null && x.spaced.test(t));
    if (!found) continue;
    (x.assist ? assist : hits).push(x);
  }
  if (hits.length) hits.push(...assist);
  if (body) hits = hits.filter((x) => !hits.some((y) => y !== x && y.label.length > x.label.length && y.label.includes(x.label)));
  const markers = body ? c.bodyMarkers.filter((m) => m && t.includes(m)) : [];
  return { score: hits.reduce((s, x) => s + x.weight, 0), hits: hits.map((x) => x.label), markers };
}

/**
 * 1차 판정. 제목·말머리와 본문은 따로 점수를 매기고, 본문은 기준이 더 높다
 * (strong 단어만, 서로 다른 strong 2개 이상 또는 bodyMarkers). 본문에서 나온 사유는 "본문 " 으로 시작한다.
 * @param {{title: string, category?: string|null, nsfwHint?: boolean, body?: string}} post  (post.body 는 예전 호출 호환용, opts.body 와 같게 취급)
 * @param {{strictness?: 'normal'|'strict'}} [source]
 * @param {{body?: string|null}} [opts] 글을 열 때 읽은 본문 텍스트 (앞 3000자만 본다)
 * @returns {{status: 'ok'|'adult'|'blocked', reasons: string[], flags: Record<string, string[]>}}
 */
export function classify(post, source = {}, opts = {}) {
  const c = compile();
  const strict = source?.strictness === 'strict';
  const head = [post.title, post.category].filter(Boolean).join(' \n ');
  const rawBody = opts?.body ?? post.body;
  const body = rawBody ? String(rawBody).slice(0, BODY_MAX) : '';
  const reasons = [];
  const flags = {};
  let blocked = false;
  let adult = false;
  const mark = (action) => {
    if (action === 'blocked') blocked = true;
    else if (action === 'adult') adult = true;
  };
  const addFlags = (key, h, b) => {
    const all = [...new Set([...h.hits, ...b.hits, ...b.markers])];
    if (all.length) flags[key] = all;
  };

  for (const cat of CATEGORIES) {
    const r = RULES[cat];
    const h = scoreCategory(c[cat], head, { title: post.title || '' });
    const b = body ? scoreCategory(c[cat], body, { body: true }) : NONE;
    addFlags(cat, h, b);
    const th = strict ? r.strictThreshold : r.threshold;
    if (h.hits.length && h.score >= th) {
      reasons.push(`${r.label}: ${h.hits.slice(0, 4).join(', ')}`);
      mark(r.action);
    } else if (b.markers.length || (b.hits.length && b.score >= (r.bodyThreshold ?? BODY_THRESHOLD))) {
      reasons.push(`본문 ${r.label}: ${[...new Set([...b.markers, ...b.hits])].slice(0, 4).join(', ')}`);
      mark(r.action);
    }
  }

  // 관리자가 넣은 단어는 하나만 걸려도 적용 (본문에서는 회피형 매칭 없이)
  for (const [key, label, action] of [['custom', '금지어', 'blocked'], ['customAdult', '성인 단어', 'adult']]) {
    const h = scoreCategory(c[key], head, { title: post.title || '' });
    const b = body ? scoreCategory(c[key], body, { body: true }) : NONE;
    addFlags(key, h, b);
    if (h.hits.length) reasons.push(`${label}: ${h.hits.slice(0, 4).join(', ')}`);
    else if (b.hits.length) reasons.push(`본문 ${label}: ${b.hits.slice(0, 4).join(', ')}`);
    else continue;
    mark(action);
  }

  const cat = fold(post.category || '').trim();
  if (cat) {
    const kinds = new Set();
    for (const [kind, words] of Object.entries(CATEGORY_RULES)) if (words.some((x) => cat.includes(fold(x)))) kinds.add(kind);
    for (const [kind, words] of Object.entries(CATEGORY_EXACT)) if (words.some((x) => cat === fold(x))) kinds.add(kind);
    for (const kind of kinds) {
      reasons.push(`말머리 "${post.category}"`);
      mark(kind === 'adult' ? 'adult' : 'blocked');
    }
  }
  if (post.nsfwHint) {
    adult = true;
    reasons.push('사이트 후방 표시');
  }

  const status = blocked ? 'blocked' : adult ? 'adult' : 'ok';
  return { status, reasons: [...new Set(reasons)], flags };
}

/**
 * 쇼츠(읽어주며 반응하는 형식) 적합도 0~100. 제목 신호 + 같은 소스 안에서의 반응(추천·댓글) 수준.
 * @param {{title: string, commentCount?: number|null, likes?: number|null, views?: number|null}} post
 * @param {{likes?: number, comments?: number, views?: number}} [medians] 같은 소스의 중앙값 (없으면 반응 점수 생략)
 */
export function shortsScore(post, medians = {}) {
  const t = normalize(post.title);
  let s = 40 + (SOURCE_BIAS[post.source] || 0);
  let plusHits = 0;
  for (const [w, p] of SHORTS_SIGNALS.plus) {
    if (t.includes(w.toLowerCase())) {
      s += p;
      plusHits++;
    }
  }
  for (const [w, p] of SHORTS_SIGNALS.minus) if (t.includes(w.toLowerCase())) s += p;
  const len = [...String(post.title || '')].length;
  if (len < 6) s -= 8; // "ㅋㅋㅋ", "제목" 같은 정보 없는 제목
  else if (len <= 9 && !plusHits) s -= 8; // "카리나", "리센느 원이" 같은 이름만 있는 사진 글
  else if (len >= 12 && len <= 40) s += 4; // 썰 제목은 보통 이 길이
  if (/\?|？/.test(post.title || '')) s += 2;

  const rel = (v, m) => (v != null && m ? Math.log2((v + 1) / (m + 1)) : null);
  const parts = [rel(post.likes, medians.likes), rel(post.commentCount, medians.comments), rel(post.views, medians.views)].filter((x) => x != null);
  if (parts.length) {
    const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
    s += Math.max(-10, Math.min(18, avg * 7));
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** 중복 판정용 제목 정규화: 꼬리표·이모지·기호·공백 제거 */
export function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]{0,12}\]|\([^)]{0,12}\)/g, ' ') // [펌], (스압) 같은 꼬리표
    .replace(/펌|스압|약스압|feat\.?/g, ' ')
    .replace(/[ㅋㅎㄷㅠㅜ]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

loadCustomRules();

/**
 * 판정 규칙의 지문: 기본 규칙·판정 방식·관리자 규칙·소스 엄격도가 바뀌면 달라진다 (다르면 저장된 글을 다시 판정한다).
 * 로컬은 판정 파일(filter.js·filter-rules.js) 내용 그대로, 클라우드는 파일이 없어 규칙 데이터와 판정 함수의 코드로 만든다.
 * @param {Array<{id: string, strictness?: string}>} srcs
 */
export function rulesFingerprint(srcs) {
  const h = createHash('sha1');
  const parts = platform.filterCodeParts();
  if (parts) for (const b of parts) h.update(b);
  else {
    const rx = (k, v) => (v instanceof RegExp ? `/${v.source}/${v.flags}` : v);
    h.update(JSON.stringify([RULES, CATEGORY_RULES, CATEGORY_EXACT], rx));
    for (const fn of [fold, compact, normalize, term, compile, stripExceptions, scoreCategory, classify]) h.update(String(fn));
  }
  h.update(JSON.stringify(custom));
  h.update(JSON.stringify(srcs.map((s) => [s.id, s.strictness || 'normal'])));
  return h.digest('hex').slice(0, 16);
}

/**
 * "썰·대화" 분위기 점수 0~100 (Claude 판정이 없을 때 쓰는 제목 기반 어림값).
 * 운영자가 보여준 쇼츠처럼 글자로 된 썰·대화·반응이면 높고, 사진·움짤·영상 위주면 낮다.
 * @param {{title: string, source?: string}} post
 */
export function vibeGuess(post) {
  const t = normalize(post.title);
  let s = 30 + (post.source === 'blind' ? 10 : 0);
  for (const [w, p] of VIBE_SIGNALS.story) if (t.includes(w.toLowerCase())) s += p;
  for (const [w, p] of VIBE_SIGNALS.visual) if (t.includes(w.toLowerCase())) s += p;
  for (const [w, p] of VIBE_SIGNALS.tone || []) if (t.includes(w.toLowerCase())) s += p;
  for (const [w, p] of VIBE_SIGNALS.warm || []) if (t.includes(w.toLowerCase())) s += p;
  return Math.max(0, Math.min(100, Math.round(s)));
}
