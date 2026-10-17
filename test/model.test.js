// 선별 점수 모델 (src/model/): 가중치 파일 모양, 점수 범위·결정성, 기준 쇼츠·금지 소재, 이상한 입력, 학습 스크립트 결정성,
// filter.js 의 섞은 점수와 푸어오버 대체 기준.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'model-'));
process.env.AI_MODERATION = '0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS_FILE = path.join(ROOT, 'src', 'model', 'weights.json');
const score = await import('../src/model/score.js');
const rules = await import('../src/model/rules.js');
const features = await import('../src/model/features.js');
const train = await import('../src/model/train.js');
const keyword = await import('../src/model/keyword.js');
const filter = await import('../src/filter.js');
const boards = await import('../src/boards.js');
const trainer = await import('../scripts/train-rule-model.js');
const { CRITERIA_VERSION } = await import('../src/criteria.js');

const reference = JSON.parse(readFileSync(path.join(ROOT, 'src', 'model', 'reference-shorts.json'), 'utf8'));
const capsOf = (title) => rules.applyRules(features.ruleText({ title })).caps;
const isInt100 = (v) => Number.isInteger(v) && v >= 0 && v <= 100;

/** 기준 쇼츠 3개 (운영자가 보여준 쇼츠) */
const BASE_SHORTS = ['충청도인이 겪은 역대급 충청도식 프로포즈', '작가와 독자의 기싸움 레전드썰ㄷㄷ', '일본사람이 물어보고 싶었던 한국 표현'];
/** STYLE.md §8 대표 예시 (기준 3개 제외) — 금지 상한에 걸리면 안 된다 */
const STYLE_GOOD = [
  '오빠가 여러명이면 어떻게 불러?', '할머니한테 말실수한 외국인들의 최후', '팽도리랑 함께 살면 겪게되는 일?', '요즘말 너무 어렵다냥', '교수도 못 참은 회심의 드립',
  '번역기로는 전달되지 않는 한국어의 속 뜻', '띄어쓰기의 중요성ㅋㅋ', '한국 신입이 회사를 뒤집어 놓은 이유', '센스도 필요해진 당근 거래', '사내 메신저로 기회 노리는 신입사원의 패기',
  '연구가 필요한 반려견 장수 비결', '매력만점 충청도식 화법?', '일본 사람이 볼 때 귀여운 한국어 표현', '병원 어르신 전용 마법의 말투', '울릉도 죽도 로드뷰만 2010년인 이유',
  '요청사항 들어준 택배기사님', '오늘도 평화로운 당근마켓 8탄',
];
/** STYLE.md §8 탈락 예시 + §6.5 금지 소재로 보이는 글 — 상한에 걸려야 한다 */
const STYLE_BAD = [
  '남친집에서 여자속옷이 나와서 헤어졌는데..', '여자 꼬시려고 모임 2개 운영하는 남자의 최후', '오늘자 해설하다 개빡친 박지성 근황..ㄷㄷ', '시총 1위 뺏겨서 개빡친 삼성전자..ㄷㄷ',
  '식당에서 Mom충 만났을 때 대처 매뉴얼', '와이프가 전재산을 주식으로 날렸습니다', '여자들은 절대 풀 수 없는 문제..?', '리뷰 보고 빡친 사장님', '안쓰면 손해라는 클라우드 서비스?',
  '남편이 친자검사를 요구해서 곤란해요', '축의금 슈킹 레전드', '남자들의 난제', '남자 외모가 영 맘에 안 드는 40대 여자의 소개팅', '경비원 면접 오라는데 걍 안갔다 씨발',
  '7억 횡령한 사립유치원 레전드', '친오빠가 10년 사귀었던 전여친이 나한테 따로 연락한 이유', '회사 경리랑 데이트 한다고 카톡 인증한 디씨인', '과외해줬던 여자애한테 연락옴',
  '아버지를 살린 아들 감동실화',
];
/** 운영자가 "절대 안 됨"이라고 한 소재: 성희롱 · 분노 · 연봉 갈등 · 남녀 일반화 (+ 조사가 끼거나 꼴이 바뀐 연애 갈등·돈 다툼·질병) */
const FORBIDDEN = {
  sexual: ['알바하다가 성희롱 당한 썰', '회식 자리 성추행 레전드'],
  anger: ['진짜 개빡치는 상사 참교육 썰', '열받아서 사장한테 쌍욕 박음'],
  money: ['연봉 때문에 와이프랑 싸웠습니다', '와이프 연봉이 저를 넘어섰네요.', '돈 안 갚는 친구한테 보낸 카톡'],
  gender: ['여자들이 남자 볼 때 특징', '남자들은 절대 모르는 여자 심리'],
  romance: ['남편이 바람을 피웠습니다', '남친이랑 크게 싸웠는데 카톡 봐주세요'],
  heavy: ['아빠가 암 걸렸는데'],
};
/** 낱말 일부만 같은 오탐 — 금지 상한에 걸리면 안 된다 */
const NOT_FORBIDDEN = [
  '우리 고양이 전성기 시절', '변성기 온 아들이 부르는 애국가', '편성기준이 이상한 방송국', '성기사 키우는 법',
  '고추에 바람을 불면?', '바람이 피부에 닿는 느낌', '찬 바람 피해 들어온 고양이', '동생이랑 싸웠는데 엄마 반응',
  '사장님의 대처가 레전드', '근처가 어딘지 모르는 외국인', '퇴근 전 와이프한테 온 카톡', '결혼 전 여친이 보낸 카톡',
  '아기자기한 소품샵', '아기자는 동안 생긴 일', '감정부터 앞서는 강아지', '과정부터 웃긴 요리', '수정부탁드립니다',
  '코인노래방 알바하면서 들은 말', '멕시코인 친구의 한국어', '도서관 대출 연체 레전드', '음식에게 사기당하는 순간들?',
  '고양이의 키보드 테러', '김밥 말기 대회', '택배기사님이 다시 돌아가신 이유', 'usb충전기 리뷰', '착한녀석 레전드', '우리 집 고양이를 소개합니다',
];
/**
 * 쇼츠 양성(reference-shorts.json) 중 일부러 막는 제목 — 금지 낱말(욕설·연봉·월세·외모 평가·요즘 애들·정부)이 그대로 들어 있다.
 * 이 밖의 쇼츠 제목이 상한에 걸리면 규칙의 새 오탐이다.
 */
const REFERENCE_CAPPED = [
  '서울대에서 쓴다는 어마무시한 욕설', '한국과 다른 미국의 연봉협상', '외모평가 하는 학생을 본 교수', '정부에서 인정한 북극여우? 🙄',
  '요즘 애들의 마인크래프트 하다 슬펐던 이유', '선 정리가 왜 연봉 1억임?', '외국인 세입자가 월세 못 낸다고 보낸 문자', '연봉, 복지가 쩌는데도 퇴사율이 높은 회사??☠️.jpg',
];

test('weights.json: 모양·크기 (학습 스크립트가 만든 파일)', () => {
  const w = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'));
  assert.equal(w.version, trainer.WEIGHTS_VERSION);
  assert.ok(!Number.isNaN(Date.parse(w.trainedAt)) && w.trainedAt === new Date(w.trainedAt).toISOString(), 'trainedAt 은 ISO 시각');
  assert.ok(w.data.sitePosts > 0 && w.data.shorts > 0);
  assert.ok(statSync(WEIGHTS_FILE).size <= 300 * 1024, `300KB 이하 (${statSync(WEIGHTS_FILE).size})`);
  for (const t of ['funny', 'vibe']) {
    const m = w[t];
    assert.ok(['lr', 'nb'].includes(m.kind), t);
    assert.equal(m.calib.z.length, m.calib.s.length);
    for (let i = 1; i < m.calib.z.length; i++) {
      assert.ok(m.calib.z[i] > m.calib.z[i - 1], `${t} 눈금표 logit 은 엄격히 증가`);
      assert.ok(m.calib.s[i] >= m.calib.s[i - 1], `${t} 눈금표 점수는 증가`);
    }
    assert.ok(m.calib.s[0] >= 0 && m.calib.s.at(-1) <= 100);
    const n = Object.keys(m.weights).length;
    assert.ok(n > 100 && n <= (w.config.topK ?? 3000) + 20, `${t} 특징 ${n}개`);
    assert.ok(Object.values(m.weights).every(Number.isFinite));
    assert.ok(w.blend[t] >= 0 && w.blend[t] <= 1, `${t} 섞는 비율`);
    assert.equal(score.MODEL_BLEND[t], w.blend[t]);
    // 교차검증 결과가 같이 들어 있고, 사이트 지표는 키워드 기준선보다 나빠지지 않았다
    assert.ok(w.cv[t].blend.site.auc >= w.cv[t].keyword.site.auc, `${t} 사이트 AUC ${w.cv[t].blend.site.auc} ≥ 키워드 ${w.cv[t].keyword.site.auc}`);
    assert.ok(w.cv[t].blend.yt.auc > w.cv[t].keyword.yt.auc, `${t} 쇼츠 AUC`);
  }
  assert.equal(score.MODEL_INFO.trainedAt, w.trainedAt);
});

test('점수: 0~100 정수, 같은 입력이면 같은 값 (캐시와 새로 계산이 같다)', () => {
  const titles = reference.slice(0, 400).map((r) => r.title);
  for (const title of titles) {
    const post = { title, source: 'dogdrip', category: null };
    const a = score.modelScore(post);
    const b = score.modelScore({ ...post });
    const e = score.explainScore(post);
    assert.ok(isInt100(a.funny) && isInt100(a.vibe), `${title} ${JSON.stringify(a)}`);
    assert.deepEqual(a, b);
    assert.equal(e.funny, a.funny);
    assert.equal(e.vibe, a.vibe);
    const s = filter.shortsScore(post, { likes: 10, comments: 5 });
    const v = filter.vibeGuess(post);
    assert.ok(isInt100(s) && isInt100(v), `${title} ${s} ${v}`);
    assert.equal(filter.shortsScore(post, { likes: 10, comments: 5 }), s);
  }
});

test('기준 쇼츠 3개는 분위기 점수가 높다 (금지 상한 없음)', () => {
  for (const title of BASE_SHORTS) {
    const caps = capsOf(title);
    assert.deepEqual(caps, { funny: 100, vibe: 100 }, title);
    const m = score.modelScore({ title });
    assert.ok(m.vibe >= 70, `${title} vibe=${m.vibe}`);
    assert.ok(filter.vibeGuess({ title }) >= 70, title);
    assert.ok(filter.shortsScore({ title }) >= 60, `${title} shorts=${filter.shortsScore({ title })}`);
  }
});

test('STYLE.md §8 대표 예시는 금지 상한에 걸리지 않고, §8 탈락·§6.5 금지 소재는 걸린다', () => {
  for (const title of STYLE_GOOD) assert.deepEqual(capsOf(title), { funny: 100, vibe: 100 }, title);
  for (const title of STYLE_BAD) {
    const caps = capsOf(title);
    assert.ok(caps.vibe <= 35, `${title} ${JSON.stringify(caps)}`);
    const m = score.modelScore({ title });
    assert.ok(m.vibe <= caps.vibe && m.funny <= caps.funny, title);
    assert.ok(filter.vibeGuess({ title }) <= caps.vibe, title);
    assert.ok(filter.shortsScore({ title }, { likes: 1 }) <= caps.funny, title);
  }
});

test('성희롱·분노·연봉 갈등·남녀 일반화 제목은 반응이 아무리 좋아도 상한 아래', () => {
  const med = { likes: 5, comments: 5, views: 100 };
  for (const [kind, titles] of Object.entries(FORBIDDEN)) {
    for (const title of titles) {
      const post = { title, source: 'humoruniv', likes: 5000, commentCount: 900, views: 99999 };
      const r = rules.applyRules(features.ruleText(post));
      assert.ok(r.hits.includes(kind), `${title} → ${r.hits}`);
      assert.ok(r.caps.funny <= 45 && r.caps.vibe <= 30, `${title} ${JSON.stringify(r.caps)}`);
      assert.ok(filter.shortsScore(post, med) <= r.caps.funny, title);
      assert.ok(filter.vibeGuess(post) <= r.caps.vibe, title);
      assert.ok(score.modelScore(post).vibe <= 30, title);
    }
  }
  // 오탐 예외: 같은 글자가 들어 있어도 금지 소재가 아닌 것
  for (const title of ['사망여우 근황', '인사팀의 차도살인', '글자수 제한이 만든 대참사', '흉기차 직원 반응', '부산 관광객을 위해 장기자랑', '자살골 넣은 선수 레전드', '동생 몰카 했는데 반응 ㅋㅋ', '할머니 집 냉장고 정체불명 페트병', '돈 없어서 결혼 거절한남자 ㅋㅋ']) {
    const r = rules.applyRules(features.ruleText({ title }));
    for (const id of ['heavy', 'issue', 'sexual', 'money']) assert.ok(!r.hits.includes(id), `${title} → ${id}`);
  }
});

test('낱말 일부만 같은 제목(전성기·대처가·퇴근 전 와이프·코인노래방·키보드 테러 …)은 금지 상한에 걸리지 않고, 쇼츠 양성 중 상한 걸린 제목은 일부러 막는 것뿐', () => {
  for (const title of NOT_FORBIDDEN) assert.deepEqual(capsOf(title), { funny: 100, vibe: 100 }, `${title} → ${rules.applyRules(features.ruleText({ title })).hits}`);
  const capped = reference
    .map((r) => r.title)
    .filter((title) => {
      const c = capsOf(title);
      return c.funny < 100 || c.vibe < 100;
    });
  assert.deepEqual(capped.sort(), [...REFERENCE_CAPPED].sort());
  // 막아야 할 꼴은 그대로 걸린다
  for (const title of ['남자 성기 크기 평균', '성기능 장애', '내 전 여친이 결혼한대', '전여친한테 연락옴', '비트코인 떡상', '대출 이자 미쳤다', '중고나라 사기당했습니다', '테러 용의자 체포', '말기 암 환자의 버킷리스트', 'mom충 레전드', '한녀 특징', '좋은 앱 소개합니다', '정부 지원금 근황']) {
    const c = capsOf(title);
    assert.ok(c.funny < 100 || c.vibe < 100, title);
  }
});

test('푸어오버: 판정 없는 글은 조사가 끼거나 꼴이 바뀐 금지 소재(바람을 피웠·돈 안 갚는·암 걸렸·연인과 싸웠)도 대체 기준을 넘지 못한다', () => {
  const med = { likes: 20, comments: 10 };
  for (const title of [...FORBIDDEN.romance, ...FORBIDDEN.heavy, '돈 안 갚는 친구한테 보낸 카톡']) {
    for (const source of ['dogdrip', 'humoruniv', 'todayhumor', 'fmkorea']) {
      const post = { id: `${source}:1`, title, source, likes: 20, commentCount: 10, status: 'ok', ai: null, manual: null };
      post.shortsScore = filter.shortsScore(post, med);
      assert.ok(!boards.pickWorthy(post), `${source} ${title} ${post.shortsScore}`);
    }
  }
});

test('푸어오버: 옛 기준 Claude 판정(기준 표시 없음)은 금지 소재 상한도 함께 보고, 지금 기준 판정은 그대로 믿는다', () => {
  const base = { source: 'humoruniv', status: 'ok', manual: null, shortsScore: 0 };
  // 실제 사이트에 옛 기준 ok 로 남아 있던 §6.5 금지 소재 글
  const stuck = ['남편이 친자검사를 요구해서 곤란해요', '축의금 슈킹 레전드..jpg', '남자들의 난제', '경비원 면접 오라는데 걍 안갔다 씨발', '과외해줬던 여자애한테 연락옴', '회사 경리랑 데이트 한다고 카톡 인증한 디씨인', '친오빠가 10년 사귀었던 전여친이 나한테 따로 연락한 이유', '아버지를 살린 아들 감동실화', '나 과자고르고있는데 내앞에서 커플 헤어졌어.jpg'];
  for (const title of stuck) {
    assert.ok(!boards.pickWorthy({ ...base, title, ai: { verdict: 'ok', shortsScore: 72 } }), title);
    assert.ok(boards.pickWorthy({ ...base, title, ai: { verdict: 'ok', shortsScore: 72, criteria: CRITERIA_VERSION } }), `${title} — 지금 기준 판정은 믿는다`);
  }
  assert.ok(boards.pickWorthy({ ...base, title: '요청사항 들어준 택배기사님', ai: { verdict: 'ok', shortsScore: 72 } }), '금지 소재가 아니면 옛 판정도 그대로');
  assert.ok(!boards.pickWorthy({ ...base, title: '요청사항 들어준 택배기사님', ai: { verdict: 'ok', shortsScore: 60, criteria: CRITERIA_VERSION } }));
});

test('형식 표지: "짤" 은 뒤에 한글·영숫자가 오지 않을 때만 f:img (한글 뒤에서는 \\b 경계가 생기지 않는다)', () => {
  for (const title of ['웃긴 짤', '짤모음 투척', '레전드 짤방', '야짤', '짤 모음']) assert.ok(features.extractFeatures({ title }).includes('f:img'), title);
  for (const title of ['짤렸다', '회사에서 짤린 썰']) assert.ok(!features.extractFeatures({ title }).includes('f:img'), title);
});

test('이상한 입력: null 제목·아주 긴 제목·이모지만·숫자에서 죽지 않고 범위 안, 빠르다', () => {
  const huge = '충청도 사투리 '.repeat(15000);
  const cases = [null, undefined, {}, { title: null }, { title: '' }, { title: 12345 }, { title: '😂😂🤣👍' }, { title: '1234567890' }, { title: huge }, { title: 'ㅋ'.repeat(100000), source: 123, category: {} }, { title: '\u0000\uD800' }];
  for (const c of cases) {
    const t0 = performance.now();
    const m = score.modelScore(c);
    assert.ok(isInt100(m.funny) && isInt100(m.vibe), JSON.stringify(c)?.slice(0, 30));
    if (c) {
      assert.ok(isInt100(filter.shortsScore(c)) && isInt100(filter.vibeGuess(c)));
      assert.ok(isInt100(keyword.keywordShorts(c)) && isInt100(keyword.keywordVibe(c)));
    }
    assert.ok(performance.now() - t0 < 200, `너무 느림 ${JSON.stringify(c)?.slice(0, 30)}`);
  }
  assert.deepEqual(score.modelScore({ title: huge }), score.modelScore({ title: huge.slice(0, 400) }), '앞부분만 본다');
});

test('규칙 가감: 수 하나면 전체에, {neg, pos} 면 감점·가점 따로', () => {
  const r = rules.applyRules(features.ruleText({ title: '빡친 사장님 리뷰 답글' }));
  assert.ok(r.hits.includes('anger') && r.hits.includes('dialogue'));
  assert.equal(r.funny, r.neg.funny + r.pos.funny);
  assert.equal(rules.ruleDelta(r, 'vibe', 1), r.vibe);
  assert.equal(rules.ruleDelta(r, 'vibe', 0) + 0, 0); // -0 도 0
  assert.equal(rules.ruleDelta(r, 'vibe', { neg: 0, pos: 0.5 }), 0.5 * r.pos.vibe);
  assert.equal(rules.ruleDelta(r, 'funny', { neg: 2, pos: 0 }), 2 * r.neg.funny);
});

test('섞은 점수: filter.js 는 키워드 점수와 학습 점수를 weights.json 비율로 섞고 상한을 씌운다', () => {
  for (const title of ['요청사항 들어준 택배기사님', '노트북 추천 좀 해주세요 질문', '리뷰 보고 빡친 사장님']) {
    const post = { title, source: 'todayhumor', likes: 40, commentCount: 12 };
    const med = { likes: 20, comments: 10 };
    const want = train.blendScore(keyword.keywordShorts(post, med), score.modelScore(post).funny, score.MODEL_BLEND.funny, score.ruleCaps(post).funny);
    assert.equal(filter.shortsScore(post, med), want, title);
    assert.equal(filter.vibeGuess(post), train.blendScore(keyword.keywordVibe(post), score.modelScore(post).vibe, score.MODEL_BLEND.vibe, score.ruleCaps(post).vibe));
  }
  assert.equal(train.blendScore(90, 10, 0.25, 100), 30);
  assert.equal(train.blendScore(90, 90, 0.5, 40), 40, '상한');
  assert.equal(train.blendScore(NaN, 50, 0, 100), 50);
});

test('판정 대기열 순서(crawler.selectionScores): 실제 점수 모델을 읽어 by=model, 값은 키워드와 섞지 않은 modelScore 그대로', async () => {
  const crawler = await import('../src/crawler.js');
  crawler.setModelScore(undefined); // src/model/score.js 를 실제로 읽는다
  const posts = [
    ...BASE_SHORTS.map((title, i) => ({ id: `todayhumor:${i}`, source: 'todayhumor', title, likes: 500, commentCount: 80, shortsScore: 0 })),
    // 저장된 섞은 점수(또는 예전 키워드 점수)가 높아도 대기열 순서에는 끼어들지 않는다
    { id: 'todayhumor:9', source: 'todayhumor', title: FORBIDDEN.money[0], likes: 500, commentCount: 80, shortsScore: 99 },
  ];
  const s = await crawler.selectionScores(posts);
  for (const p of posts) {
    const got = s.get(p.id);
    assert.equal(got.by, 'model', p.title);
    assert.deepEqual({ funny: got.funny, vibe: got.vibe }, score.modelScore(p), p.title);
    assert.equal(got.priority, crawler.priorityOf(got));
  }
  assert.ok(s.get('todayhumor:9').funny < 65, '금지 소재는 상한 아래');
  assert.ok(posts.slice(0, 3).every((p) => s.get(p.id).priority > s.get('todayhumor:9').priority), '기준 쇼츠가 금지 소재보다 앞');
});

test('푸어오버: 판정 없는 글은 섞은 점수 ≥ 대체 기준이고 금지 소재가 아닐 때만', () => {
  const base = { source: 'humoruniv', status: 'ok', ai: null, manual: null };
  assert.ok(boards.pickWorthy({ ...base, title: '요청사항 들어준 택배기사님', shortsScore: boards.PICK_FALLBACK_MIN }));
  assert.ok(!boards.pickWorthy({ ...base, title: '요청사항 들어준 택배기사님', shortsScore: boards.PICK_FALLBACK_MIN - 1 }));
  // 예전 키워드 점수가 높게 저장돼 있어도 금지 소재는 안 들어간다
  assert.ok(!boards.pickWorthy({ ...base, title: '남편이 친자검사를 요구해서 곤란해요', shortsScore: 95 }));
  // Claude 판정이 있으면 그것만 본다
  assert.ok(boards.pickWorthy({ ...base, title: '아무 제목', shortsScore: 0, ai: { verdict: 'ok', shortsScore: 80 } }));
  assert.ok(!boards.pickWorthy({ ...base, title: '요청사항 들어준 택배기사님', shortsScore: 99, ai: { verdict: 'not_humor', shortsScore: 0 } }));
});

// ---------------------------------------------------------------------
// 학습 스크립트
// ---------------------------------------------------------------------

/** 작은 가짜 데이터: 사이트 글 60개(판정 포함) + 쇼츠 양성 30 + 음성 16 */
function fakeData() {
  const goodWords = ['사투리', '외국인', '할머니', '고양이', '택배기사님', '당근 거래', '한국어 표현', '신입사원'];
  const badWords = ['논란', '근황', '정보', '추천 좀', '영상', '사진 모음', '빡친', '연봉'];
  const posts = {};
  for (let i = 0; i < 60; i++) {
    const good = i % 3 === 0;
    const w = good ? goodWords[i % goodWords.length] : badWords[i % badWords.length];
    const id = `${i % 2 ? 'dogdrip' : 'humoruniv'}:${i}`;
    posts[id] = {
      id, source: id.split(':')[0], title: `${w} 이야기 ${i % 7}번째`, category: null, likes: (i * 7) % 50, commentCount: i % 9, views: null,
      firstSeenAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      ai: { verdict: good || i % 5 === 1 ? 'ok' : 'not_humor', shortsScore: good ? 80 : i % 5 === 1 ? 50 : 0, vibe: good ? 85 : i % 5 === 1 ? 40 : 0, reason: '', model: 't', at: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString() },
    };
  }
  const reference = Array.from({ length: 30 }, (_, i) => ({ title: `${goodWords[i % goodWords.length]}의 의외의 이유 ${i}`, channel: ['도롱챠 DOLONGCHA', '코리수의게임세상', '허니가루비', '김블루'][i % 4], views: 1000, url: `https://www.youtube.com/shorts/x${i}`, category: '황당·엉뚱 일상', sourceHint: null }));
  const negatives = Array.from({ length: 16 }, (_, i) => ({ title: `${badWords[i % badWords.length]} 레전드 ${i}`, channel: '짤짤톡톡', views: 10, url: `https://www.youtube.com/shorts/n${i}`, reason: i % 2 ? '대조 채널' : 'X:분노·응징 톤' }));
  return { posts: { posts }, reference, negatives };
}

test('학습: 같은 입력이면 같은 가중치 파일 (스크립트 두 번), 글 파일은 {posts:{}}·배열 모두', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'train-'));
  const d = fakeData();
  const f = (n, v) => {
    const p = path.join(dir, n);
    writeFileSync(p, JSON.stringify(v));
    return p;
  };
  const postsObj = f('posts.json', d.posts);
  const postsArr = f('posts-array.json', Object.values(d.posts.posts));
  const ref = f('ref.json', d.reference);
  const neg = f('neg.json', d.negatives);
  const run = (posts, out) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'train-rule-model.js'), '--posts', posts, '--reference', ref, '--negatives', neg, '--out', out], { encoding: 'utf8', timeout: 120e3 });
  const log = run(postsObj, path.join(dir, 'w1.json'));
  assert.match(log, /학습: 글 60개 중 판정 60개/);
  run(postsObj, path.join(dir, 'w2.json'));
  run(postsArr, path.join(dir, 'w3.json'));
  const w1 = readFileSync(path.join(dir, 'w1.json'), 'utf8');
  assert.equal(readFileSync(path.join(dir, 'w2.json'), 'utf8'), w1, '같은 입력 → 같은 파일');
  assert.equal(readFileSync(path.join(dir, 'w3.json'), 'utf8'), w1, '배열 모양도 같은 결과');
  const w = JSON.parse(w1);
  assert.equal(w.trainedAt, '2026-10-02T00:59:00.000Z', '가장 늦은 Claude 판정 시각');
  assert.equal(w.data.sitePosts, 60);
  assert.ok(Object.keys(w.funny.weights).length > 0 && Object.keys(w.vibe.weights).length > 0);
  // 라이브러리로 불러도 같다 (--stamp 를 주면 그 시각)
  const src = { posts: trainer.readPosts(d.posts), reference: d.reference, negatives: d.negatives };
  const a = trainer.trainModels(src, { stamp: '2026-01-01T00:00:00Z' });
  const b = trainer.trainModels(src, { stamp: '2026-01-01T00:00:00Z' });
  assert.equal(trainer.formatWeights(a.weights), trainer.formatWeights(b.weights));
  assert.equal(a.weights.trainedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(JSON.parse(trainer.formatWeights(a.weights)).funny.weights, w.funny.weights);
  // 쇼츠 쪽 양성이 음성보다 높게 매겨진다 (작은 데이터에서도 방향은 맞다)
  assert.ok(a.report.vibe.model.yt.auc > 0.5, `yt AUC ${a.report.vibe.model.yt.auc}`);
});

test('학습 스크립트: 판정이 든 글이 모자라거나 양성이 없으면 파일을 쓰지 않고 실패한다 (판정 없는 공개 목록을 넘겨 모든 점수가 0 이 되지 않게)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'train-guard-'));
  try {
    const d = fakeData();
    const f = (n, v) => {
      const p = path.join(dir, n);
      writeFileSync(p, JSON.stringify(v));
      return p;
    };
    const ref = f('ref.json', d.reference);
    const neg = f('neg.json', d.negatives);
    const out = path.join(dir, 'w.json');
    const items = Object.values(d.posts.posts).map(({ ai, ...p }) => p); // eslint-disable-line no-unused-vars
    // 공개 /api/posts 응답 모양({items:[…]}, 판정 없음)과 판정 없는 글 파일
    for (const posts of [{ items }, { posts: { 'a:1': { id: 'a:1', title: '제목', source: 'a' } } }, items]) {
      let err = null;
      try {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'train-rule-model.js'), '--posts', f('p.json', posts), '--reference', ref, '--negatives', neg, '--out', out], { encoding: 'utf8', stdio: 'pipe', timeout: 120e3 });
      } catch (e) {
        err = e;
      }
      assert.ok(err && err.status === 1, '종료 코드 1');
      assert.match(String(err.stderr), /학습 실패: 판정이 든 글이 0개뿐이에요/);
      assert.ok(!existsSync(out), '파일을 쓰지 않는다');
    }
    // 양성이 하나도 없으면
    const noPos = Object.values(d.posts.posts).map((p) => ({ ...p, ai: { ...p.ai, verdict: 'not_humor', shortsScore: 0, vibe: 0 } }));
    assert.throws(() => trainer.trainModels({ posts: noPos, reference: d.reference, negatives: d.negatives }), /funny 양성/);
    // 가중치 검사
    assert.equal(trainer.weightsProblem(JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'))), null);
    assert.match(trainer.weightsProblem({ funny: { calib: { z: [null, null], s: [null, null] }, weights: {} }, vibe: {} }), /funny 눈금표에 숫자가 아닌 값/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('score.js: weights.json 모양이 이상하면 서버를 멈추지 않고 학습 점수 없이 키워드 점수로 물러난다 (MODEL_READY false, 섞는 비율은 키워드만)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bad-model-'));
  try {
    for (const name of ['score.js', 'features.js', 'rules.js', 'train.js']) copyFileSync(path.join(ROOT, 'src', 'model', name), path.join(dir, name));
    const w = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'));
    for (const t of ['funny', 'vibe']) {
      w[t].calib = { z: w[t].calib.z.map(() => null), s: w[t].calib.s.map(() => null) };
      w[t].weights = {};
    }
    writeFileSync(path.join(dir, 'weights.json'), JSON.stringify(w));
    const warn = console.warn;
    const warned = [];
    console.warn = (s) => warned.push(String(s));
    let m;
    try {
      m = await import(pathToFileURL(path.join(dir, 'score.js')).href);
    } finally {
      console.warn = warn;
    }
    assert.equal(m.MODEL_READY, false);
    assert.deepEqual({ ...m.MODEL_BLEND }, { funny: 1, vibe: 1 }, '키워드 점수만 쓴다');
    assert.deepEqual(m.modelScore({ title: '충청도식 프로포즈' }), { funny: 0, vibe: 0 });
    assert.deepEqual(m.ruleCaps({ title: '연봉 협상 레전드' }), { funny: 45, vibe: 30 }, '금지 소재 상한은 그대로');
    assert.ok(warned.some((s) => s.includes('weights.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(score.MODEL_READY, true, '실제 weights.json 은 쓸 수 있다');
});

test('겹 나누기: 크롤러가 같은 글로 묶은 사본(dupOf)은 제목이 조금 달라도 같은 묶음·같은 겹, 다른 글의 겹은 사본이 있든 없든 그대로', () => {
  const ok = { verdict: 'ok', shortsScore: 80, vibe: 90 };
  const no = { verdict: 'not_humor', shortsScore: 0 };
  const posts = [
    { id: 'a:1', source: 'a', title: '택시 탈 때 존나 이해 안되는 반응', ai: ok },
    { id: 'b:1', source: 'b', title: '택시 탈 때 ㅈㄹ 이해 안되는 반응', dupOf: 'a:1', ai: ok },
    { id: 'c:1', source: 'c', title: '존나 심각하다는 굴 근황', ai: no },
    { id: 'd:1', source: 'd', title: 'ㅈㄴ 심각하다는 "굴" 근황 ㅋㅋㅋㅋㅋㅋㅋ', dupOf: 'c:1', ai: no },
    // 대표 글(e:1)은 판정이 없어 학습에 없어도 사본끼리는 묶인다
    { id: 'f:1', source: 'f', title: '중국 여성 육상 선수들', dupOf: 'e:1', ai: ok },
    { id: 'g:1', source: 'g', title: '중국 여성 육상 선수들 사진', dupOf: 'e:1', ai: ok },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `h:${i}`, source: 'h', title: `서로 다른 제목 ${i}번째 이야기`, ai: i % 3 ? no : ok })),
  ];
  const data = train.makeDataset({ posts });
  const folds = train.assignFolds(data.site, 5);
  const at = (id) => data.site.findIndex((e) => e.id === id);
  for (const [x, y] of [['a:1', 'b:1'], ['c:1', 'd:1'], ['f:1', 'g:1']]) {
    assert.equal(data.site[at(x)].join, data.site[at(y)].join, `${x} ${y}`);
    assert.equal(folds[at(x)], folds[at(y)], `${x} ${y}`);
  }
  assert.equal(data.site[at('h:3')].group, features.cleanTitle('서로 다른 제목 3번째 이야기').replace(/\s/g, ''));
  // 사본 묶음이 없는 것처럼(dupOf 를 지운 글) 나눠도 사본이 아닌 글의 겹은 같다 (겹이 통째로 다시 섞이지 않는다)
  const plain = train.makeDataset({ posts: posts.map(({ dupOf, ...p }) => p) }); // eslint-disable-line no-unused-vars
  const plainFolds = train.assignFolds(plain.site, 5);
  const copies = new Set(['a:1', 'b:1', 'c:1', 'd:1', 'f:1', 'g:1']); // 묶음 안에서는 대표 제목의 겹으로 옮겨 갈 수 있다
  plain.site.forEach((e, i) => {
    if (!copies.has(e.id)) assert.equal(folds[at(e.id)], plainFolds[i], e.id);
  });
  assert.deepEqual(train.joinGroups([['x', '1'], ['y', '1'], ['z', '2']]), new Map([['x', 'x'], ['y', 'x'], ['z', 'z']]));
});

test('학습 데이터: 판정 없는 글·예전 판정(분위기 점수 없음)은 빼고, 겹 나누기는 결정적', () => {
  const p = (id, ai) => ({ id, title: `제목 ${id}`, source: 'dogdrip', ai });
  const posts = [p('a', null), p('b', { verdict: 'ok', shortsScore: 80 }), p('c', { verdict: 'ok', shortsScore: 80, vibe: 90 }), p('d', { verdict: 'hate', shortsScore: 0 })];
  const data = train.makeDataset({ posts }, {});
  assert.deepEqual(data.site.map((e) => e.id), ['c', 'd']);
  assert.deepEqual(data.site.find((e) => e.id === 'c').hard, { funny: 1, vibe: 1 });
  assert.deepEqual(train.assignFolds(data.site, 5), train.assignFolds(data.site, 5));
});
