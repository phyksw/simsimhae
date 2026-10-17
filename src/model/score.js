// 선별 점수 모델: modelScore(post) → { funny, vibe } (0~100 정수, Claude 점수와 같은 눈금).
//   funny: 웃긴 글인가 (Claude 판정 ok & shortsScore ≥ 65 를 맞히도록 학습)
//   vibe:  기준 쇼츠 3개와 같은 궤인가 (Claude vibe ≥ 70 + 쇼츠 제목 1,148개를 맞히도록 학습)
// 점수 = 학습 점수(weights.json 의 선형 모델 logit) + 손으로 쓴 규칙(rules.js)의 가감 → 0~100 눈금표 → 금지 소재 상한.
// 키워드 점수와 섞는 것은 filter.js(shortsScore·vibeGuess)가 weights.json 의 blend 비율로 한다.
// 가중치는 scripts/train-rule-model.js 가 만든다. 순수 JS + JSON — Workers 번들에서도 그대로 import 된다.
import WEIGHTS from './weights.json' with { type: 'json' };
import { extractFeatures, ruleText, TITLE_MAX } from './features.js';
import { applyRules, ruleDelta } from './rules.js';
import { finalScore } from './train.js';

/**
 * weights.json 의 한 모델을 점수 매기기 좋은 모양으로. 모양이 이상하면(눈금표가 숫자가 아님·가중치가 비었음 등) null.
 * 여기서 throw 하면 filter.js 가 이 파일을 정적으로 불러오므로 서버·Worker 가 아예 뜨지 않는다 → 없는 것으로 치고 키워드 점수로 물러난다.
 */
function load(m) {
  if (!m || typeof m !== 'object' || !m.calib || !m.weights || typeof m.weights !== 'object') return null;
  const { z, s } = m.calib;
  if (!Array.isArray(z) || !Array.isArray(s) || z.length < 2 || z.length !== s.length || ![...z, ...s].every(Number.isFinite)) return null;
  for (let i = 1; i < z.length; i++) if (!(z[i] > z[i - 1])) return null;
  const entries = Object.entries(m.weights);
  if (!entries.length || !entries.every(([, v]) => Number.isFinite(v))) return null;
  const ruleScale = typeof m.ruleScale === 'number' || (m.ruleScale && typeof m.ruleScale === 'object') ? m.ruleScale : 1;
  return {
    norm: m.norm || 'none',
    bias: Number(m.bias) || 0,
    sourceDefault: Number(m.sourceDefault) || 0,
    calib: m.calib,
    weights: new Map(entries),
    ruleScale,
  };
}
const MODELS = { funny: load(WEIGHTS?.funny), vibe: load(WEIGHTS?.vibe) };
/** weights.json 을 쓸 수 있는지. 아니면 modelScore 는 0, 섞는 비율은 키워드만(1), 판정 대기열 순서는 키워드 점수(src/crawler.js loadModelScore) */
export const MODEL_READY = !!(MODELS.funny && MODELS.vibe);
if (!MODEL_READY) console.warn('[model] weights.json 모양이 이상해 학습 점수 없이 키워드 점수만 써요 (scripts/train-rule-model.js 로 다시 만들어 주세요)');
const RULE_FEATURES = WEIGHTS?.ruleFeatures !== false;

/** 모델 정보 (학습 시각·데이터 수·교차검증 결과) */
export const MODEL_INFO = Object.freeze({ version: WEIGHTS?.version, trainedAt: WEIGHTS?.trainedAt, data: WEIGHTS?.data, cv: WEIGHTS?.cv, ready: MODEL_READY });

const unit = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(1, Number(x))) : 0);
/** 키워드 점수와 섞는 비율 (키워드 쪽 몫 0~1). 학습 스크립트가 겹 밖 예측으로 정한다. 모델을 못 쓰면 키워드만 */
export const MODEL_BLEND = Object.freeze(MODEL_READY ? { funny: unit(WEIGHTS.blend?.funny), vibe: unit(WEIGHTS.blend?.vibe) } : { funny: 1, vibe: 1 });

/** 학습 logit. 학습에 없던 출처(또는 출처 없는 글)는 출처 가중치 대신 학습 출처들의 평균(sourceDefault)을 받는다 */
function logit(m, feats, source) {
  const x = m.norm === 'l2' ? 1 / Math.sqrt(Math.max(1, feats.length)) : 1;
  let z = m.bias;
  for (const f of feats) {
    const v = m.weights.get(f);
    if (v !== undefined) z += v * x;
  }
  if (!source || !m.weights.has(`s:${source.toLowerCase()}`)) z += m.sourceDefault * x;
  return z;
}

/**
 * 규칙까지 합친 최종 점수 (학습 스크립트도 같은 식을 쓴다: train.js evaluateTarget).
 * @param {number} z 학습 모델 logit
 * @param {ReturnType<typeof applyRules>} rules applyRules 결과
 * @param {'funny'|'vibe'} target
 * @param {{calib: {z: number[], s: number[]}, ruleScale?: number|{neg?: number, pos?: number}}} m
 */
export function combineScore(z, rules, target, m) {
  return finalScore(m.calib, z + ruleDelta(rules, target, m.ruleScale ?? 1), rules.caps[target]);
}

/** 글 → 점수 매기기에 쓰는 부분만 (제목·말머리·출처). 이상한 값은 빈 문자열로 */
function pick(post) {
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  return { title: s(post?.title).slice(0, TITLE_MAX * 2), category: s(post?.category) || null, source: s(post?.source) || null };
}

/** 점수 계산 (withTop 이면 근거 특징 상위 6개도) */
function compute(post, withTop) {
  const p = pick(post);
  const rules = applyRules(ruleText(p));
  const feats = extractFeatures(p, { extra: RULE_FEATURES ? rules.hits.map((h) => `r:${h}`) : [] });
  const out = { rules: rules.hits, caps: rules.caps };
  for (const t of ['funny', 'vibe']) {
    const m = MODELS[t];
    if (!MODEL_READY) {
      out[t] = 0; // 모델 없음 (섞는 비율이 키워드만이라 shortsScore·vibeGuess 에는 들어가지 않는다)
      continue;
    }
    const z = logit(m, feats, p.source);
    out[t] = combineScore(z, rules, t, m);
    if (!withTop) continue;
    const x = m.norm === 'l2' ? 1 / Math.sqrt(Math.max(1, feats.length)) : 1;
    out[`${t}Logit`] = Math.round(z * 1000) / 1000;
    out[`${t}Top`] = feats
      .map((f) => [f, (m.weights.get(f) || 0) * x])
      .filter(([, v]) => v)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, 6)
      .map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v.toFixed(2)}`);
  }
  return out;
}

/**
 * 점수와 근거 (관리자·학습 보고용): {funny, vibe, rules, caps, funnyLogit, vibeLogit, funnyTop, vibeTop}
 * @param {{title?: string, category?: string|null, source?: string|null}} post
 */
export function explainScore(post) {
  return compute(post, true);
}

// 같은 글을 여러 번 매기지 않게 (수집마다 rescoreAll 이 모든 글을 다시 매긴다). 같은 입력이면 늘 같은 값이라 지워도 결과는 같다.
const cache = new Map();
const CACHE_MAX = 5000;

/** 점수·상한 (캐시) */
function scored(post) {
  const p = pick(post);
  const key = `${p.source || ''}\u0001${p.category || ''}\u0001${p.title}`;
  let hit = cache.get(key);
  if (!hit) {
    const e = compute(p, false);
    hit = Object.freeze({ funny: e.funny, vibe: e.vibe, caps: Object.freeze({ ...e.caps }) });
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

/**
 * 선별 점수 0~100. 제목·말머리·출처만 본다 (같은 입력이면 늘 같은 값).
 * @param {{title?: string, category?: string|null, source?: string|null}} post
 * @returns {{funny: number, vibe: number}}
 */
export function modelScore(post) {
  const { funny, vibe } = scored(post);
  return { funny, vibe };
}

/** 금지 소재 상한 (규칙만, 학습 점수 없이) — 키워드 점수와 섞은 뒤에도 같은 상한을 씌울 때 */
export function ruleCaps(post) {
  return { ...scored(post).caps };
}
