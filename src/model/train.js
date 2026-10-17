// 선별 점수 모델 학습 도구 (순수 JS, 의존성·파일 입출력 없음). 실행은 scripts/train-rule-model.js 가 한다.
//
// 두 모델: funny (웃긴 글인가: Claude 판정 ok & shortsScore ≥ 65), vibe (쇼츠 궤인가: Claude vibe ≥ 70)
// 입력: 제목(+말머리·출처)의 문자 1~3-gram·단어·형식 특징 (features.js) + 규칙 묶음 표지 (rules.js)
// 학습 데이터: Claude 판정이 있는 사이트 글 + 쇼츠 제목(reference-shorts.json, 양성) + 쇼츠 음성 예시(reference-negatives.json)
// 방법: 가중 로지스틱 회귀(L2, 전체 배치 Adam, 결정적) 또는 나이브 베이즈. 상위 특징만 남겨 weights.json 으로 내보낸다.
import { extractFeatures, cleanTitle, ruleText } from './features.js';
import { applyRules, ruleDelta } from './rules.js';

export const FUNNY_MIN = 65;
export const VIBE_MIN = 70;

/**
 * 고른 학습 설정 (scripts/train-rule-model.js 기본값). 근거: 사이트 5겹 교차검증 + 쇼츠 쪽 5겹 교차검증 (2026-10-17, 사이트 글 640·쇼츠 1,148·음성 531),
 * 목표 J = 0.6·쇼츠 AUC + 0.4·사이트 AUC — scripts/train-rule-model.js --grid 로 다시 볼 수 있다.
 * 사이트 겹은 같은 제목끼리, 크롤러가 묶은 사본(dupOf)은 대표 제목의 겹으로 나눈다 (같은 글이 학습·시험 겹에 갈라지지 않게).
 * 기본값 J: funny 0.867 (사이트 0.802·쇼츠 0.910), vibe 0.887 (사이트 0.906·쇼츠 0.874). 키워드 기준선은 사이트 0.723·0.672, 쇼츠 0.582·0.591.
 * (쇼츠 쪽 숫자는 낙관적이다: 금지 상한 규칙을 reference-negatives.json 제목을 보면서 다듬었다. 사이트 숫자는 그 영향이 없다)
 * - l2 1e-4: 1e-3 이면 J funny 0.853·vibe 0.873, 3e-4 면 0.862·0.882
 * - refWeight 0.5: 0.25 면 0.866·0.882 (사이트↑ 쇼츠↓), 0.75 면 0.867·0.883 — 합이 가장 큰 가운데를 고름
 * - ruleScale {neg: 0, pos: 0.5}: 감점 규칙의 손 무게는 학습된 r:묶음 특징과 겹쳐(이중 계산) 사이트 AUC 를 깎았다
 *   (규칙 무게 1 이면 0.858·0.883, 감점 1·가점 0 이면 0.860·0.874, 규칙 무게 0 이면 0.869·0.880, 0.5 면 0.864·0.888).
 *   금지 소재는 무게 대신 상한(cap)으로 누른다. 가점 0.5 는 vibe 사이트 AUC 를 올린다 (학습만 0.888 → 0.906).
 * - 나이브 베이즈는 0.834·0.839 로 낮다.
 */
export const DEFAULT_CONFIG = Object.freeze({
  kind: 'lr',
  norm: 'l2',
  l2: 1e-4,
  iters: 400,
  lr: 0.08,
  minDf: 2,
  topK: 3000,
  refWeight: 0.5,
  negWeight: 1,
  contrastWeight: 0.4,
  ruleFeatures: true,
  ruleScale: Object.freeze({ neg: 0, pos: 0.5 }),
});

/** 기준 3채널 (운영자가 보여준 쇼츠의 채널): 채널마다 같은 무게. 나머지 유사 채널은 절반 무게 */
export const REFERENCE_CHANNELS = ['도롱챠 DOLONGCHA', '코리수의게임세상', '허니가루비'];

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** FNV-1a 32bit (폴드 나누기용, 결정적) */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Claude 판정 → 학습 라벨. 판정이 없거나 이상하면 null (학습에 쓰지 않는다) */
export function labelsOf(post, { soft = false } = {}) {
  const ai = post?.ai;
  if (!ai || typeof ai.verdict !== 'string') return null;
  const ok = ai.verdict === 'ok';
  const shorts = ok ? Number(ai.shortsScore) || 0 : 0;
  const vibe = ok && typeof ai.vibe === 'number' ? ai.vibe : 0;
  if (ok && typeof ai.vibe !== 'number') return null; // 분위기 점수 없는 예전 판정
  const hard = { funny: shorts >= FUNNY_MIN ? 1 : 0, vibe: vibe >= VIBE_MIN ? 1 : 0 };
  const target = { funny: shorts, vibe };
  if (!soft) return { y: hard, hard, target };
  const s = (v, m) => (ok ? sigmoid((v - m) / 6) : 0);
  return { y: { funny: s(shorts, FUNNY_MIN), vibe: s(vibe, VIBE_MIN) }, hard, target };
}

/**
 * 학습 데이터 만들기.
 * @param {{posts: any[], reference?: any[], negatives?: any[]}} src
 * @param {{soft?: boolean, refWeight?: number, negWeight?: number, contrastWeight?: number, ruleFeatures?: boolean}} [cfg]
 *   refWeight: 쇼츠 양성 예시 무게의 합 / 사이트 글 수. negWeight·contrastWeight: 음성 예시 1개 무게 / 양성 예시 1개 평균 무게
 * @returns {{site: Example[], yt: Example[]}}
 * @typedef {{id: string, group: string, post: any, feats: string[], rules: ReturnType<typeof applyRules>,
 *   y: {funny: number|null, vibe: number|null}, hard?: {funny: number, vibe: number}, target?: {funny: number, vibe: number},
 *   w: {funny: number, vibe: number}, domain: 'site'|'yt'}} Example
 */
export function makeDataset({ posts, reference = [], negatives = [] }, cfg = {}) {
  const { soft = false, refWeight = 0.5, negWeight = 1, contrastWeight = 0.4, ruleFeatures = true } = cfg;
  const feats = (post, domain, rules) => extractFeatures(post, { domain, extra: ruleFeatures ? rules.hits.map((h) => `r:${h}`) : [] });
  const site = [];
  for (const p of [...posts].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const L = labelsOf(p, { soft });
    if (!L || !p.title) continue;
    const rules = applyRules(ruleText(p));
    const post = { title: p.title, category: p.category || null, source: p.source || null };
    site.push({ id: p.id, group: cleanTitle(p.title).replace(/\s/g, '') || p.id, dup: p.dupOf || p.id, post, feats: feats(post, 'site', rules), rules, y: L.y, hard: L.hard, target: L.target, w: { funny: 1, vibe: 1 }, domain: 'site' });
  }
  // 겹 나누기: 같은 제목(group)에 더해 크롤러가 같은 글로 묶은 사본(dupOf, "택시 탈 때 존나/ㅈㄹ …" 처럼 제목이 조금 다른 것)을 이어 붙인 묶음(join).
  // join = 그 묶음의 가장 앞선(정렬 기준) 제목 키. assignFolds 가 사본을 join 의 겹으로 맞춘다 (사본이 없는 글의 겹은 그대로).
  const joinOf = joinGroups(site.map((ex) => [ex.group, ex.dup]));
  for (const ex of site) {
    ex.join = joinOf.get(ex.group);
    delete ex.dup;
  }
  const yt = [];
  // 쇼츠 양성: 채널별 무게를 맞춘다 (허니가루비 196개가 외국인 소재를 끌어올리지 않게 — STYLE.md §2)
  const perChannel = new Map();
  for (const r of reference) perChannel.set(r.channel, (perChannel.get(r.channel) || 0) + 1);
  const unit = (ch) => (REFERENCE_CHANNELS.includes(ch) ? 1 : 0.5);
  let unitSum = 0;
  for (const ch of perChannel.keys()) unitSum += unit(ch);
  const totalRef = refWeight * site.length;
  for (const r of reference) {
    if (!r.title) continue;
    const post = { title: r.title, category: null, source: null };
    const rules = applyRules(ruleText(post));
    const w = (totalRef * unit(r.channel)) / unitSum / perChannel.get(r.channel);
    yt.push({ id: r.url || r.title, group: `yt:${r.title}`, post, feats: feats(post, 'yt', rules), rules, y: { funny: 1, vibe: 1 }, w: { funny: w, vibe: w }, domain: 'yt' });
  }
  const meanRefW = reference.length ? totalRef / reference.length : 1;
  for (const r of negatives) {
    if (!r.title) continue;
    const post = { title: r.title, category: null, source: null };
    const rules = applyRules(ruleText(post));
    const contrast = !String(r.reason || '').startsWith('X:');
    const w = meanRefW * (contrast ? contrastWeight : negWeight);
    // 대조 채널(형식은 같고 궤가 다른 곳)은 웃긴지 여부를 모르므로 vibe 에만 쓴다
    yt.push({ id: r.url || r.title, group: `yt:${r.title}`, post, feats: feats(post, 'yt', rules), rules, y: { funny: contrast ? null : 0, vibe: 0 }, w: { funny: contrast ? 0 : w, vibe: w }, domain: 'yt' });
  }
  return { site, yt };
}

/**
 * 제목 키와 중복 묶음 id 쌍 [titleKey, dupId] 들을 이어 붙인 묶음 (union-find). 결정적: 묶음 이름은 그 안의 가장 작은 제목 키.
 * @param {Array<[string, string]>} pairs
 * @returns {Map<string, string>} 제목 키 → 묶음 이름
 */
export function joinGroups(pairs) {
  const parent = new Map();
  const root = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let y = x; parent.get(y) !== r; ) {
      const next = parent.get(y);
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  const add = (x) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  // 제목 키와 묶음 id 는 이름이 겹치지 않게 앞에 표시를 붙인다
  for (const [t, d] of pairs) {
    const a = `t\u0001${t}`;
    const b = `d\u0001${d}`;
    add(a);
    add(b);
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  // 묶음마다 가장 작은 제목 키를 이름으로
  const best = new Map();
  for (const [t] of pairs) {
    const r = root(`t\u0001${t}`);
    if (!best.has(r) || t < best.get(r)) best.set(r, t);
  }
  return new Map(pairs.map(([t]) => [t, best.get(root(`t\u0001${t}`))]));
}

/**
 * 사이트 글을 k 겹으로 나눈다: 같은 제목(여러 출처에 올라온 같은 글)은 같은 겹, 양성은 겹마다 고르게. 결정적.
 * 크롤러가 묶은 사본(ex.join)은 그 묶음 대표 제목의 겹으로 맞춘다 — 다른 글의 겹은 사본이 있든 없든 그대로다.
 * @returns {number[]} site[i] 의 겹 번호
 */
export function assignFolds(site, k = 5) {
  const groups = new Map();
  for (const ex of site) {
    if (!groups.has(ex.group)) groups.set(ex.group, { key: ex.group, stratum: 0 });
    const g = groups.get(ex.group);
    const s = (ex.hard?.vibe ?? (ex.y.vibe >= 0.5 ? 1 : 0)) ? 2 : (ex.hard?.funny ?? (ex.y.funny >= 0.5 ? 1 : 0)) ? 1 : 0;
    g.stratum = Math.max(g.stratum, s);
  }
  const foldOf = new Map();
  for (const stratum of [2, 1, 0]) {
    const gs = [...groups.values()].filter((g) => g.stratum === stratum).sort((a, b) => hash32(a.key) - hash32(b.key) || a.key.localeCompare(b.key));
    gs.forEach((g, i) => foldOf.set(g.key, (i + stratum) % k));
  }
  return site.map((ex) => foldOf.get(ex.join && foldOf.has(ex.join) ? ex.join : ex.group));
}

/** 특징 사전: 학습 예시 중 minDf 개 이상에 나온 특징 (정렬, 결정적) */
export function buildVocab(examples, minDf = 2) {
  const df = new Map();
  for (const ex of examples) for (const f of ex.feats) df.set(f, (df.get(f) || 0) + 1);
  const vocab = [...df.entries()].filter(([f, n]) => n >= minDf || f === 'd:yt').map(([f]) => f).sort();
  return { vocab, index: new Map(vocab.map((f, i) => [f, i])), df };
}

const scaleOf = (ex, norm) => (norm === 'l2' ? 1 / Math.sqrt(Math.max(1, ex.feats.length)) : 1);

/**
 * 가중 로지스틱 회귀 (L2, 전체 배치 Adam). y 는 0~1 (부드러운 라벨 가능), y 가 null 이거나 무게 0 인 예시는 뺀다.
 * @returns {{kind: 'lr', bias: number, weights: Map<string, number>, norm: string}}
 */
export function trainLogistic(examples, target, { minDf = 2, l2 = 1e-3, iters = 400, lr = 0.08, norm = 'l2' } = {}) {
  const ex = examples.filter((e) => e.y[target] != null && e.w[target] > 0);
  const { vocab, index } = buildVocab(ex, minDf);
  const rows = ex.map((e) => {
    const idx = [];
    for (const f of e.feats) {
      const j = index.get(f);
      if (j !== undefined) idx.push(j);
    }
    return { idx, x: scaleOf(e, norm), y: e.y[target], w: e.w[target] };
  });
  const W = rows.reduce((s, r) => s + r.w, 0) || 1;
  const n = vocab.length;
  const w = new Float64Array(n);
  let b = 0;
  // 시작 편향 = 가중 평균 라벨의 logit
  const ybar = Math.min(0.99, Math.max(0.01, rows.reduce((s, r) => s + r.w * r.y, 0) / W));
  b = Math.log(ybar / (1 - ybar));
  const m = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const g = new Float64Array(n + 1);
  const B1 = 0.9;
  const B2 = 0.999;
  for (let t = 1; t <= iters; t++) {
    g.fill(0);
    for (const r of rows) {
      let z = b;
      for (const j of r.idx) z += w[j] * r.x;
      const d = (r.w * (sigmoid(z) - r.y)) / W;
      for (const j of r.idx) g[j] += d * r.x;
      g[n] += d;
    }
    for (let j = 0; j < n; j++) g[j] += l2 * w[j];
    const c1 = 1 - B1 ** t;
    const c2 = 1 - B2 ** t;
    for (let j = 0; j <= n; j++) {
      m[j] = B1 * m[j] + (1 - B1) * g[j];
      v[j] = B2 * v[j] + (1 - B2) * g[j] * g[j];
      const step = (lr * (m[j] / c1)) / (Math.sqrt(v[j] / c2) + 1e-8);
      if (j === n) b -= step;
      else w[j] -= step;
    }
  }
  const weights = new Map();
  for (let j = 0; j < n; j++) if (w[j] !== 0) weights.set(vocab[j], w[j]);
  return { kind: 'lr', bias: b, weights, norm };
}

/**
 * 나이브 베이즈 (다항, 라플라스 평활, 가중·부드러운 라벨). 점수 = 편향 + Σ log 비율 (특징은 있음/없음).
 * @returns {{kind: 'nb', bias: number, weights: Map<string, number>, norm: 'none'}}
 */
export function trainNaiveBayes(examples, target, { minDf = 2, alpha = 0.5 } = {}) {
  const ex = examples.filter((e) => e.y[target] != null && e.w[target] > 0);
  const { vocab, index } = buildVocab(ex, minDf);
  const pos = new Float64Array(vocab.length);
  const neg = new Float64Array(vocab.length);
  let np = 0;
  let nn = 0;
  for (const e of ex) {
    const yp = e.y[target] * e.w[target];
    const yn = (1 - e.y[target]) * e.w[target];
    np += yp;
    nn += yn;
    for (const f of e.feats) {
      const j = index.get(f);
      if (j === undefined) continue;
      pos[j] += yp;
      neg[j] += yn;
    }
  }
  const sp = pos.reduce((a, b) => a + b, 0) + alpha * vocab.length;
  const sn = neg.reduce((a, b) => a + b, 0) + alpha * vocab.length;
  const weights = new Map();
  for (let j = 0; j < vocab.length; j++) weights.set(vocab[j], Math.log((pos[j] + alpha) / sp) - Math.log((neg[j] + alpha) / sn));
  return { kind: 'nb', bias: Math.log(Math.max(np, 1e-6) / Math.max(nn, 1e-6)), weights, norm: 'none' };
}

/** 출처 특징(s:)은 크기와 상관없이 남긴다 — 빠지면 그 출처 글이 "모르는 출처"로 보여 기본값(sourceDefault)을 받게 된다 */
const ALWAYS_KEEP = (f) => f.startsWith('s:');

/** 특징 가중치를 |값| 큰 순으로 topK 개만 (같으면 이름순, 출처 특징은 늘 남김) — 내보낼 크기를 줄인다 */
export function pruneModel(model, topK = 3000, digits = 4) {
  const entries = [...model.weights.entries()].filter(([, v]) => Number.isFinite(v) && Math.abs(v) >= 10 ** -digits);
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1));
  const q = 10 ** digits;
  const kept = entries.slice(0, topK);
  for (const e of entries.slice(topK)) if (ALWAYS_KEEP(e[0])) kept.push(e);
  const weights = new Map(kept.map(([f, v]) => [f, Math.round(v * q) / q]));
  return { ...model, bias: Math.round(model.bias * q) / q, weights };
}

/**
 * 학습에 없던 출처(또는 출처 없는 글)에 줄 출처 가중치: 학습 글이 있는 출처들의 s: 가중치 평균.
 * (사이트 글은 모두 출처 특징이 있어서, 없으면 그만큼 점수가 한쪽으로 쏠린다)
 */
export function sourceDefaultOf(model, sources) {
  const vals = [...new Set(sources)].filter(Boolean).map((s) => model.weights.get(`s:${String(s).toLowerCase()}`) || 0);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1e4) / 1e4 : 0;
}

/** 모델 점수 (logit). feats 는 extractFeatures 결과 */
export function linearScore(model, feats) {
  const x = model.norm === 'l2' ? 1 / Math.sqrt(Math.max(1, feats.length)) : 1;
  let z = model.bias;
  for (const f of feats) {
    const v = model.weights.get(f);
    if (v !== undefined) z += v * x;
  }
  return z;
}

export function train(examples, target, cfg = {}) {
  const m = cfg.kind === 'nb' ? trainNaiveBayes(examples, target, cfg) : trainLogistic(examples, target, cfg);
  return pruneModel(m, cfg.topK ?? 3000);
}

/**
 * k 겹 교차검증: 사이트 글만 시험에 쓰고, 쇼츠 예시는 늘 학습에 넣는다. 겹마다 사전·학습·가지치기를 새로 한다.
 * @returns {Float64Array} site[i] 의 겹 밖 예측 logit (모델만, 규칙 전)
 */
export function crossValidate(data, target, cfg = {}, k = 5) {
  const folds = assignFolds(data.site, k);
  const oof = new Float64Array(data.site.length);
  for (let f = 0; f < k; f++) {
    const trainSet = [...data.site.filter((_, i) => folds[i] !== f), ...(cfg.noYt ? [] : data.yt)];
    const model = train(trainSet, target, cfg);
    data.site.forEach((ex, i) => {
      if (folds[i] === f) oof[i] = linearScore(model, ex.feats);
    });
  }
  return oof;
}

/**
 * 쇼츠 제목 쪽 교차검증: 쇼츠 양성(기준·유사 채널)과 쇼츠 음성(빠진 쇼츠·대조 채널)을 k 겹으로 나눠 맞히는지 본다.
 * 같은 "유튜브 제목" 안에서 소재·톤만으로 가르는지 보는 시험이다 (사이트 글은 늘 학습에 넣는다).
 * scores 는 모델 logit + 규칙 가감, idx 는 각 점수의 data.yt 번호.
 * @returns {{scores: number[], labels: number[], idx: number[]}}
 */
export function crossValidateYt(data, target, cfg = {}, k = 5) {
  const idx = data.yt.map((e, i) => i).filter((i) => data.yt[i].y[target] != null && data.yt[i].w[target] > 0);
  const fold = new Map(idx.map((i) => [i, hash32(data.yt[i].group) % k]));
  const scores = [];
  const labels = [];
  const order = [];
  for (let f = 0; f < k; f++) {
    const trainSet = [...data.site, ...data.yt.filter((_, i) => fold.get(i) !== f)];
    const model = train(trainSet, target, cfg);
    for (const i of idx) {
      if (fold.get(i) !== f) continue;
      const ex = data.yt[i];
      scores.push(linearScore(model, ex.feats) + ruleDelta(ex.rules, target, cfg.ruleScale ?? 1));
      labels.push(ex.y[target] >= 0.5 ? 1 : 0);
      order.push(i);
    }
  }
  return { scores, labels, idx: order };
}

// ---------------------------------------------------------------------
// 평가
// ---------------------------------------------------------------------

/** ROC AUC (같은 점수는 반씩) */
export function auc(scores, labels) {
  const idx = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0;
  let nPos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) if (labels[idx[t]]) {
      rankSum += r;
      nPos++;
    }
    i = j + 1;
  }
  const nNeg = idx.length - nPos;
  if (!nPos || !nNeg) return NaN;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** 기준점 이상을 양성으로 볼 때 정밀도·재현율·F1 */
export function prf(scores, labels, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  scores.forEach((s, i) => {
    if (s >= threshold) labels[i] ? tp++ : fp++;
    else if (labels[i]) fn++;
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, selected: tp + fp, tp };
}

/** 점수 상위 k 개 중 양성 비율 */
export function precisionAt(scores, labels, k) {
  const idx = [...scores.keys()].sort((a, b) => scores[b] - scores[a] || a - b).slice(0, k);
  return idx.filter((i) => labels[i]).length / Math.max(1, idx.length);
}

// ---------------------------------------------------------------------
// 0~100 눈금 맞추기
// ---------------------------------------------------------------------

/**
 * logit → 0~100 표: 겹 밖 예측의 분위수를 Claude 점수(판정 거절 = 0)의 분위수에 맞춘다.
 * Claude 가 거절한 글(0점) 구간은 0~30 으로 펴서 순서가 남게 한다. 결과 점수는 Claude 점수와 같은 눈금이다 (65·70 기준을 그대로 쓸 수 있다).
 * @param {ArrayLike<number>} z 겹 밖 logit
 * @param {number[]} target Claude 점수 (판정 거절 = 0)
 * @returns {{z: number[], s: number[]}} 51개 매듭 (단조 증가)
 */
export function fitCalibration(z, target, knots = 51) {
  const zs = [...z].sort((a, b) => a - b);
  const zeros = target.filter((t) => t <= 0).length;
  const ts = [...target.filter((t) => t > 0)];
  for (let j = 0; j < zeros; j++) ts.push((30 * j) / Math.max(1, zeros));
  ts.sort((a, b) => a - b);
  const q = (arr, p) => {
    const pos = p * (arr.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(arr.length - 1, lo + 1);
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const outZ = [];
  const outS = [];
  for (let i = 0; i < knots; i++) {
    const p = i / (knots - 1);
    let zz = r4(q(zs, p));
    let ss = Math.round(q(ts, p) * 100) / 100;
    if (outZ.length && zz <= outZ.at(-1)) zz = r4(outZ.at(-1) + 1e-4); // logit 매듭은 엄격히 증가
    if (outS.length && ss < outS.at(-1)) ss = outS.at(-1);
    outZ.push(zz);
    outS.push(ss);
  }
  return { z: outZ, s: outS };
}

/** logit → 0~100 (표 사이는 직선, 위쪽 끝은 마지막 기울기로 늘려 100 에서 자른다) */
export function applyCalibration(cal, z) {
  const Z = cal.z;
  const S = cal.s;
  const n = Z.length;
  if (z <= Z[0]) return Math.max(0, S[0]);
  if (z >= Z[n - 1]) {
    const slope = (S[n - 1] - S[n - 2]) / Math.max(1e-6, Z[n - 1] - Z[n - 2]);
    return Math.min(100, S[n - 1] + Math.max(0, Math.min(slope, 60)) * (z - Z[n - 1]));
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Z[mid] <= z) lo = mid;
    else hi = mid;
  }
  return S[lo] + ((S[hi] - S[lo]) * (z - Z[lo])) / (Z[hi] - Z[lo]);
}

/** 내보낼 모양 (weights.json 의 funny·vibe 칸) */
export function exportModel(model, cal, extra = {}) {
  return { kind: model.kind, norm: model.norm, bias: model.bias, ...extra, calib: cal, weights: Object.fromEntries(model.weights) };
}

/**
 * 학습 점수(logit, 규칙 가감까지 더한 값) → 최종 0~100 정수 (눈금표 → 금지 소재 상한). score.js 도 같은 식을 쓴다.
 * @param {{z: number[], s: number[]}} cal
 * @param {number} z
 * @param {number} [cap]
 */
export function finalScore(cal, z, cap = 100) {
  const s = applyCalibration(cal, Number.isFinite(z) ? z : 0);
  return Math.max(0, Math.min(cap, Math.round(s)));
}

/**
 * 키워드 점수와 학습 점수 섞기: 키워드 비율 kw (0~1), 결과는 0~100 정수이고 금지 소재 상한을 씌운다. filter.js 도 같은 식을 쓴다.
 * @param {number} keyword 키워드 점수 0~100
 * @param {number} model 학습 점수 0~100
 * @param {number} kw 키워드 비율
 * @param {number} [cap]
 */
export function blendScore(keyword, model, kw, cap = 100) {
  const k = Math.max(0, Math.min(1, Number(kw) || 0));
  const v = k * (Number(keyword) || 0) + (1 - k) * (Number(model) || 0);
  return Math.max(0, Math.min(cap, Math.round(v)));
}

/**
 * 한 목표의 설정 하나를 평가한다: 사이트 k 겹 교차검증(겹 밖 예측) + 쇼츠 쪽 교차검증.
 * 눈금표는 사이트 겹 밖 예측(규칙 가감 포함)으로 맞추고, 쇼츠 쪽 점수에도 같은 눈금표·상한을 씌운다.
 * @param {{site: Example[], yt: Example[]}} data makeDataset 결과
 * @param {'funny'|'vibe'} target
 * @param {object} cfg 학습 설정 (ruleScale 포함)
 * @returns {{cal: {z: number[], s: number[]}, site: {z: number[], final: number[], labels: number[]},
 *   yt: {final: number[], labels: number[], idx: number[]}}}
 */
export function evaluateTarget(data, target, cfg = {}, k = 5) {
  const scale = cfg.ruleScale ?? 1;
  const oof = crossValidate(data, target, cfg, k);
  const z = [...oof].map((v, i) => v + ruleDelta(data.site[i].rules, target, scale));
  const cal = fitCalibration(z, data.site.map((e) => e.target[target]));
  const site = {
    z,
    final: z.map((v, i) => finalScore(cal, v, data.site[i].rules.caps[target])),
    labels: data.site.map((e) => e.hard[target]),
  };
  const ytcv = crossValidateYt(data, target, cfg, k);
  const yt = { final: ytcv.scores.map((v, j) => finalScore(cal, v, data.yt[ytcv.idx[j]].rules.caps[target])), labels: ytcv.labels, idx: ytcv.idx };
  return { cal, site, yt };
}

/**
 * 점수 목록 하나의 지표: AUC, 상위 20개 정밀도, 기준점(threshold) 이상의 정밀도·재현율·선택 수.
 * @param {number[]} scores
 * @param {number[]} labels 0/1
 * @param {number} threshold
 */
export function metrics(scores, labels, threshold) {
  const p = prf(scores, labels, threshold);
  return { auc: auc(scores, labels), p20: precisionAt(scores, labels, 20), precision: p.precision, recall: p.recall, selected: p.selected };
}
