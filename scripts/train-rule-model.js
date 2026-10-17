// 선별 점수 모델 학습 → src/model/weights.json (점수 매기기는 src/model/score.js, 키워드 점수와 섞기는 src/filter.js)
//
//   node scripts/train-rule-model.js [--posts <파일>] [--out src/model/weights.json] [--report] [--grid] [--stamp <ISO 시각>] [--dry-run]
//
//   --posts      Claude 판정이 붙은 글 파일. {posts: {id: 글}} · {posts: [글]} · [글] 모두 받는다. 기본 data/posts.json (읽기만 한다).
//                클라우드 판정 사본으로 다시 학습할 때 그 파일을 넘기면 된다.
//   --reference  쇼츠 양성 예시 (기본 src/model/reference-shorts.json),  --negatives 쇼츠 음성 예시 (기본 src/model/reference-negatives.json)
//   --out        가중치 파일 (기본 src/model/weights.json)
//   --report     교차검증 표 전체 (섞는 비율별 표, 푸어오버 기준점별 정밀도·재현율)
//   --grid       설정 비교표 (규칙 무게·쇼츠 무게·L2) — DEFAULT_CONFIG 를 고른 근거. 1~2분 걸린다
//   --stamp      trainedAt 에 넣을 시각. 없으면 입력 글의 가장 늦은 Claude 판정 시각 → 같은 입력이면 같은 파일 (git diff 가 매번 나지 않게)
//   --dry-run    파일을 쓰지 않고 보고만
//
// 순서: 사이트 글 5겹 교차검증 + 쇼츠 제목 5겹 교차검증 → 겹 밖 예측으로 0~100 눈금표 → 키워드 점수와 섞는 비율 고르기 → 전체 데이터로 다시 학습해 내보내기.
// 섞는 비율: 목표 J = 0.6·쇼츠 AUC + 0.4·사이트 AUC 가 가장 큰 값 (사이트 AUC 가 키워드 기준선보다 낮으면 안 되고, J 가 0.002 안쪽으로 같으면 키워드 몫이 큰 쪽).
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, FUNNY_MIN, VIBE_MIN, auc, blendScore, evaluateTarget, exportModel, makeDataset, metrics, prf, sourceDefaultOf, train } from '../src/model/train.js';
import { keywordShorts, keywordVibe } from '../src/model/keyword.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEIGHTS_VERSION = 1;
const TARGETS = ['funny', 'vibe'];
const TH = { funny: FUNNY_MIN, vibe: VIBE_MIN };
/** 섞는 비율 후보 (키워드 몫) */
export const BLEND_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const J_TIE = 0.002;
const J_YT = 0.6;

/** 글 파일 → 글 목록 ({posts: {...}} · {posts: [...]} · [...]) */
export function readPosts(json) {
  const raw = Array.isArray(json) ? json : json && typeof json === 'object' ? json.posts : null;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.title === 'string');
}

function median(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 출처별 반응 중앙값 (입력 글 전체 기준 — 수집 서버는 최근 3일 기준이지만 학습은 결정적이어야 해서) */
export function sourceMedians(posts) {
  const by = new Map();
  for (const p of posts) {
    if (!by.has(p.source)) by.set(p.source, []);
    by.get(p.source).push(p);
  }
  const out = {};
  for (const [src, arr] of [...by.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    out[src] = { likes: median(arr.map((p) => p.likes)), comments: median(arr.map((p) => p.commentCount)), views: median(arr.map((p) => p.views)) };
  }
  return out;
}

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const pack = (m) => ({ auc: r3(m.auc), p20: r3(m.p20), precision: r3(m.precision), recall: r3(m.recall), selected: m.selected });
const objective = (site, yt) => (Number.isFinite(yt) ? J_YT * yt + (1 - J_YT) * site : site);

/**
 * 한 목표의 교차검증·섞는 비율 고르기·최종 학습.
 * @returns {{model: object, report: object}}
 */
function trainTarget(src, t, cfg, med, k) {
  const byId = new Map(src.posts.map((p) => [p.id, p]));
  const data = makeDataset(src, cfg);
  const ev = evaluateTarget(data, t, cfg, k);
  const kw = (post, m) => (t === 'funny' ? keywordShorts(post, m) : keywordVibe(post));
  const kwSite = data.site.map((e) => kw(byId.get(e.id), med[e.post.source]));
  const kwYt = ev.yt.idx.map((i) => kw(data.yt[i].post, {}));
  const capSite = data.site.map((e) => e.rules.caps[t]);
  const capYt = ev.yt.idx.map((i) => data.yt[i].rules.caps[t]);
  const labels = ev.site.labels;

  const row = (siteScores, ytScores) => ({ site: pack(metrics(siteScores, labels, TH[t])), yt: { auc: r3(auc(ytScores, ev.yt.labels)) } });
  const keyword = row(kwSite, kwYt);
  const keywordCapped = row(kwSite.map((v, i) => Math.min(v, capSite[i])), kwYt.map((v, j) => Math.min(v, capYt[j])));
  const model = row(ev.site.final, ev.yt.final);

  const blends = BLEND_GRID.map((a) => {
    const s = ev.site.final.map((m, i) => blendScore(kwSite[i], m, a, capSite[i]));
    const y = ev.yt.final.map((m, j) => blendScore(kwYt[j], m, a, capYt[j]));
    const r = row(s, y);
    return { alpha: a, ...r, J: r3(objective(r.site.auc, r.yt.auc)), scores: s };
  });
  const allowed = blends.filter((b) => !(b.site.auc < keyword.site.auc)); // NaN 이면 통과
  const pool = allowed.length ? allowed : blends;
  const bestJ = Math.max(...pool.map((b) => b.J ?? -Infinity));
  const chosen = [...pool].reverse().find((b) => (b.J ?? -Infinity) >= bestJ - J_TIE) || pool[0];

  // 푸어오버(pick) 판정 없는 글 대체 기준을 고르는 데 쓰는 표: 섞은 점수 기준점별 정밀도·재현율 (사이트 겹 밖)
  const thresholds = t === 'funny' ? [50, 55, 60, 65, 70, 75].map((th) => ({ threshold: th, ...prf(chosen.scores, labels, th) })) : [];

  const full = train([...data.site, ...data.yt], t, cfg);
  const exported = exportModel(full, ev.cal, { ruleScale: cfg.ruleScale ?? 1, sourceDefault: sourceDefaultOf(full, data.site.map((e) => e.post.source)) });
  return {
    model: exported,
    report: {
      n: { site: data.site.length, sitePos: labels.filter(Boolean).length, yt: ev.yt.labels.length, ytPos: ev.yt.labels.filter(Boolean).length },
      keyword,
      keywordCapped,
      model,
      blend: { alpha: chosen.alpha, site: chosen.site, yt: chosen.yt, J: chosen.J },
      blends: blends.map(({ scores, ...b }) => b), // eslint-disable-line no-unused-vars
      thresholds: thresholds.map((x) => ({ threshold: x.threshold, precision: r3(x.precision), recall: r3(x.recall), selected: x.selected })),
      features: Object.keys(exported.weights).length,
    },
  };
}

/** 입력의 지문 (같은 입력인지 확인용) */
function inputHash(src) {
  const h = createHash('sha1');
  for (const p of [...src.posts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!p.ai) continue;
    h.update(JSON.stringify([p.id, p.title, p.category || null, p.source || null, p.likes ?? null, p.commentCount ?? null, p.views ?? null, p.ai.verdict, p.ai.shortsScore ?? null, p.ai.vibe ?? null]));
  }
  h.update(JSON.stringify(src.reference.map((r) => [r.title, r.channel])));
  h.update(JSON.stringify(src.negatives.map((r) => [r.title, r.reason])));
  return h.digest('hex').slice(0, 16);
}

/** 입력에서 학습 시각 유도: 가장 늦은 Claude 판정 시각 (없으면 가장 늦게 들어온 글, 그것도 없으면 0) */
function stampOf(posts) {
  let best = '';
  for (const p of posts) {
    const at = p.ai?.at || '';
    if (at > best && !Number.isNaN(Date.parse(at))) best = at;
  }
  if (!best) for (const p of posts) if ((p.firstSeenAt || '') > best && !Number.isNaN(Date.parse(p.firstSeenAt))) best = p.firstSeenAt;
  return new Date(best ? Date.parse(best) : 0).toISOString();
}

/** 학습에 쓸 수 있는 판정 글이 이만큼은 있어야 한다 (판정이 없는 글 파일로 돌려 weights.json 을 망가뜨리지 않게) */
export const MIN_SITE_POSTS = 50;

/**
 * 만든 가중치가 쓸 만한지: 눈금표(calib.z·s)가 같은 길이(2 이상)의 유한한 수이고 logit 매듭이 증가하며, 특징 가중치가 비지 않았다.
 * @returns {string|null} 문제가 있으면 그 설명
 */
export function weightsProblem(w) {
  for (const t of TARGETS) {
    const m = w?.[t];
    const z = m?.calib?.z;
    const sc = m?.calib?.s;
    if (!Array.isArray(z) || !Array.isArray(sc) || z.length < 2 || z.length !== sc.length) return `${t} 눈금표 모양이 이상해요`;
    if (![...z, ...sc].every(Number.isFinite)) return `${t} 눈금표에 숫자가 아닌 값이 있어요`;
    for (let i = 1; i < z.length; i++) if (!(z[i] > z[i - 1])) return `${t} 눈금표 logit 이 증가하지 않아요`;
    const vals = Object.values(m.weights || {});
    if (!vals.length || !vals.every(Number.isFinite)) return `${t} 특징 가중치가 비었거나 숫자가 아니에요`;
    if (!Number.isFinite(Number(m.bias))) return `${t} 편향이 숫자가 아니에요`;
  }
  return null;
}

/**
 * 학습 전체 (파일 입출력 없음). 같은 입력이면 같은 결과.
 * 판정 글이 MIN_SITE_POSTS 개보다 적거나, funny·vibe 양성이 하나도 없거나, 만든 가중치가 이상하면 throw 한다 (파일을 쓰지 않게).
 * @param {{posts: any[], reference?: any[], negatives?: any[]}} src
 * @param {{config?: object, k?: number, stamp?: string, minSitePosts?: number}} [opts]
 * @returns {{weights: object, report: object}}
 */
export function trainModels(src, { config = DEFAULT_CONFIG, k = 5, stamp, minSitePosts = MIN_SITE_POSTS } = {}) {
  const s = { posts: src.posts || [], reference: src.reference || [], negatives: src.negatives || [] };
  // 판정(ai)이 든 글이 모자라면 학습하지 않는다 — 공개 /api/posts 응답·판정 없는 사본을 넘기면 모든 점수가 0 이 되는 파일이 나온다
  const labeled = makeDataset(s, { ...config }).site;
  const pos = (t) => labeled.filter((e) => e.hard[t]).length;
  if (labeled.length < minSitePosts) throw new Error(`판정이 든 글이 ${labeled.length}개뿐이에요 (${minSitePosts}개 이상 필요 — Claude 판정(ai)이 붙은 글 파일인지 확인해 주세요)`);
  for (const t of TARGETS) if (!pos(t)) throw new Error(`${t} 양성(판정 기준 이상) 글이 하나도 없어요 — 판정이 든 글 파일인지 확인해 주세요`);
  const med = sourceMedians(s.posts);
  const res = {};
  for (const t of TARGETS) res[t] = trainTarget(s, t, { ...config, ...(config[t] || {}) }, med, k);
  const { funny: _f, vibe: _v, ...cfgOut } = config; // eslint-disable-line no-unused-vars
  const cv = { k, objective: `${J_YT}*yt+${r3(1 - J_YT)}*site`, thresholds: TH };
  for (const t of TARGETS) {
    const r = res[t].report;
    cv[t] = { n: r.n, keyword: r.keyword, keywordCapped: r.keywordCapped, model: r.model, blend: r.blend };
  }
  const weights = {
    version: WEIGHTS_VERSION,
    trainedAt: stamp ? new Date(stamp).toISOString() : stampOf(s.posts),
    data: {
      sitePosts: res.funny.report.n.site,
      funnyPos: res.funny.report.n.sitePos,
      vibePos: res.vibe.report.n.sitePos,
      shorts: s.reference.length,
      negatives: s.negatives.length,
      inputHash: inputHash(s),
    },
    config: cfgOut,
    cv,
    ruleFeatures: config.ruleFeatures !== false,
    blend: { funny: res.funny.report.blend.alpha, vibe: res.vibe.report.blend.alpha },
    funny: res.funny.model,
    vibe: res.vibe.model,
  };
  const bad = weightsProblem(weights);
  if (bad) throw new Error(`만든 가중치가 이상해요: ${bad}`);
  return { weights, report: { funny: res.funny.report, vibe: res.vibe.report } };
}

/**
 * weights.json 글자: 머리(설정·교차검증)는 보기 좋게, 특징 가중치는 한 줄에 하나 (git diff 를 읽을 수 있게).
 */
export function formatWeights(w) {
  const lines = ['{'];
  const keys = Object.keys(w);
  keys.forEach((key, ki) => {
    const last = ki === keys.length - 1 ? '' : ',';
    if (key === 'funny' || key === 'vibe') {
      const { weights, ...head } = w[key];
      const inner = JSON.stringify(head).slice(1, -1);
      const entries = Object.entries(weights).map(([f, v]) => `    ${JSON.stringify(f)}: ${v}`);
      lines.push(`  ${JSON.stringify(key)}: {${inner}, "weights": {`, entries.join(',\n'), `  }}${last}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(w[key])}${last}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------
// 보고
// ---------------------------------------------------------------------

const f = (x) => (x == null || !Number.isFinite(x) ? '  -  ' : x.toFixed(3));
function printReport(report, full) {
  for (const t of TARGETS) {
    const r = report[t];
    console.log(`\n[${t}] 사이트 글 ${r.n.site}개 (양성 ${r.n.sitePos}) · 쇼츠 쪽 ${r.n.yt}개 (양성 ${r.n.ytPos}) · 기준점 ${TH[t]} · 내보낸 특징 ${r.features}개`);
    console.log('                            사이트 AUC  P@20   정밀도/재현율(선택)  | 쇼츠 AUC');
    const line = (name, x) => console.log(`  ${name.padEnd(24)} ${f(x.site.auc)}   ${f(x.site.p20)}  ${f(x.site.precision)}/${f(x.site.recall)} (${String(x.site.selected).padStart(3)})  | ${f(x.yt.auc)}`);
    line('키워드 (지금 규칙)', r.keyword);
    line('키워드 + 금지 상한', r.keywordCapped);
    line('학습 점수 (규칙·상한 포함)', r.model);
    line(`섞은 점수 (키워드 ${r.blend.alpha})`, r.blend);
    if (full) {
      for (const b of r.blends) console.log(`    키워드 ${b.alpha.toFixed(1)}: 사이트 ${f(b.site.auc)} P@20 ${f(b.site.p20)} | 쇼츠 ${f(b.yt.auc)} | J ${f(b.J)}`);
      for (const x of r.thresholds) console.log(`    섞은 점수 ≥ ${x.threshold}: 정밀도 ${f(x.precision)} 재현율 ${f(x.recall)} (${x.selected}개)`);
    }
  }
}

/** 설정 비교표 (DEFAULT_CONFIG 를 고른 근거) */
function runGrid(src) {
  const med = sourceMedians(src.posts);
  const variants = [
    ['기본', {}],
    ['규칙 무게 0', { ruleScale: 0 }],
    ['규칙 무게 0.5', { ruleScale: 0.5 }],
    ['규칙 무게 1', { ruleScale: 1 }],
    ['감점 1·가점 0', { ruleScale: { neg: 1, pos: 0 } }],
    ['감점 0.5·가점 0.25', { ruleScale: { neg: 0.5, pos: 0.25 } }],
    ['r: 특징 없이, 규칙 무게 1', { ruleFeatures: false, ruleScale: 1 }],
    ['쇼츠 무게 0.25', { refWeight: 0.25 }],
    ['쇼츠 무게 0.75', { refWeight: 0.75 }],
    ['L2 1e-3', { l2: 1e-3 }],
    ['L2 3e-4', { l2: 3e-4 }],
    ['나이브 베이즈', { kind: 'nb' }],
  ];
  console.log('\n설정 비교 (J = 0.6·쇼츠 AUC + 0.4·사이트 AUC, 섞는 비율은 설정마다 다시 고름)');
  for (const [name, over] of variants) {
    const cfg = { ...DEFAULT_CONFIG, ...over };
    const cells = TARGETS.map((t) => {
      const r = trainTarget(src, t, cfg, med, 5).report;
      return `${t} J ${f(r.blend.J)} 사이트 ${f(r.blend.site.auc)} 쇼츠 ${f(r.blend.yt.auc)} (학습만 ${f(r.model.site.auc)}/${f(r.model.yt.auc)}, 키워드 ${r.blend.alpha})`;
    });
    console.log(`  ${name.padEnd(22)} ${cells.join('  |  ')}`);
  }
}

function parseArgs(argv) {
  const o = { posts: path.join(ROOT, 'data', 'posts.json'), out: path.join(ROOT, 'src', 'model', 'weights.json'), reference: path.join(ROOT, 'src', 'model', 'reference-shorts.json'), negatives: path.join(ROOT, 'src', 'model', 'reference-negatives.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 다음에 값이 필요해요`);
      return v;
    };
    if (a === '--posts') o.posts = path.resolve(val());
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--reference') o.reference = path.resolve(val());
    else if (a === '--negatives') o.negatives = path.resolve(val());
    else if (a === '--stamp') {
      o.stamp = val();
      if (Number.isNaN(Date.parse(o.stamp))) throw new Error(`--stamp 시각이 이상해요: ${o.stamp}`);
    } else if (a === '--report') o.report = true;
    else if (a === '--grid') o.grid = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`모르는 옵션: ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const src = { posts: readPosts(readJson(o.posts)), reference: readJson(o.reference), negatives: readJson(o.negatives) };
  const t0 = Date.now();
  const { weights, report } = trainModels(src, { stamp: o.stamp });
  const text = formatWeights(weights);
  console.log(`학습: 글 ${src.posts.length}개 중 판정 ${weights.data.sitePosts}개 (funny 양성 ${weights.data.funnyPos}, vibe 양성 ${weights.data.vibePos}) + 쇼츠 ${weights.data.shorts} · 음성 ${weights.data.negatives} — ${Date.now() - t0}ms`);
  printReport(report, !!o.report);
  if (o.grid) runGrid(src);
  if (o.dryRun) console.log(`\n(--dry-run: ${o.out} 은 그대로, ${Buffer.byteLength(text)} 바이트)`);
  else {
    // 임시 파일에 다 쓴 뒤 이름을 바꾼다 (쓰다 끊겨 반쪽 weights.json 이 남지 않게)
    const tmp = `${o.out}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, o.out);
    console.log(`\n${path.relative(ROOT, o.out) || o.out} ← ${Buffer.byteLength(text)} 바이트 (trainedAt ${weights.trainedAt}, 섞는 비율 funny ${weights.blend.funny} · vibe ${weights.blend.vibe})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`학습 실패: ${e?.message || e}`);
    process.exit(1);
  });
}
