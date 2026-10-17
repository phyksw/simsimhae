import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, shortsScore, titleKey } from '../src/filter.js';

const status = (title, src) => classify({ title }, src).status;

test('평범한 유머·썰은 통과', () => {
  for (const t of [
    '충청도인이 겪은 역대급 충청도식 프로포즈',
    '작가와 독자의 기싸움 레전드썰ㄷㄷ',
    '일본사람이 물어보고 싶었던 한국 표현',
    '웹소설 출판사들이 새드엔딩을 싫어하는 이유',
    '한 남자가 편의점에서 겪은 일',
    '홍어삼합 처음 먹어본 외국인 반응',
    '노무사 시험 합격 썰',
    '요리하다가 대참사 남 ㅋㅋㅋ',
    '자살골 넣은 선수 레전드',
    '자동차 후방카메라 설치 후기',
    '정권 지르기 배우는 고양이',
    '젖은 고양이 말리기',
    '한남동 맛집 사장님 드립',
    '오늘은 라면이라도 먹어야지',
  ]) {
    assert.equal(status(t), 'ok', t);
  }
});

test('정치·혐오·사건사고는 차단', () => {
  for (const t of ['윤 석 열 근황', '이재명 대표 발언', '요즘 대통령 선거 분위기', '한남들 특징 ㅋㅋ', '트럼프 밈 모음', '고속도로 사고로 3명 사망', '홍어 드립 ㅋㅋ', '틀딱들 특징']) {
    assert.equal(status(t), 'blocked', t);
  }
});

test('엄격 소스는 약한 정치 단어 하나로도 차단', () => {
  assert.equal(status('요즘 대통령 근황'), 'ok');
  assert.equal(status('요즘 대통령 근황', { strictness: 'strict' }), 'blocked');
});

test('후방·노출은 잠금 게시판으로', () => {
  for (const t of ['후방) 헬스장 누나', '비키니 입은 강아지', '몸매 좋은 치어리더', '[ㅇㅎ] 오늘의 짤']) {
    assert.equal(status(t), 'adult', t);
  }
  assert.equal(classify({ title: '평범한 제목', nsfwHint: true }).status, 'adult');
  assert.equal(classify({ title: '평범한 제목', category: '후방주의' }).status, 'adult');
});

test('본문으로도 판정 (본문은 제목보다 기준이 높다)', () => {
  const S = { strictness: 'strict' };
  // 서로 다른 strong 단어 2개 이상이면 본문만으로도 차단
  const v = classify({ title: '오늘 본 거' }, S, { body: '국민의힘 당대표가 민주당 대표한테 말하길' });
  assert.equal(v.status, 'blocked');
  assert.ok(v.reasons.every((r) => r.startsWith('본문 ')), v.reasons.join());
  // 예전 호출 형태(post.body)도 같은 본문 기준으로
  assert.equal(classify({ title: '오늘 본 거', body: '국민의힘 당대표가 민주당 대표한테 말하길' }).status, 'blocked');
  // 명확한 표식은 하나로 충분
  assert.equal(classify({ title: '오늘 본 거' }, {}, { body: '[후방] 사진 많음' }).status, 'adult');
  assert.equal(classify({ title: '오늘 본 거' }, {}, { body: '(서울=뉴스1) 홍길동 기자 = [단독] 어쩌구' }).status, 'blocked');
  // 일상 문장·strong 단어 하나·weak 단어는 본문만으로는 걸리지 않는다
  for (const [t, body] of [
    ['회식 메뉴 정하는 법', '사장님이 투표로 정하자고 해서'],
    ['우리 고양이 근황', '고양이 키운지 벌써 3년'],
    ['새 직장 첫 출근 후기', '일찍 가야한다고 생각해서'],
    ['할머니', '할머니가 수박 들고 마중'],
    ['우리', '우리 국민의 힘으로 이겼다'],
    ['엄마가', '정부 지원금 받으러 갔다가'],
    ['강아지', '강아지가 공원에서 누나 따라가다가… 화보 찍는 줄'],
    ['오늘 본 거', '국민의힘 당대표가 말하길'],
    ['썰', '아빠가 성폭행 뉴스 보다가 채널 돌림'],
  ]) {
    assert.equal(classify({ title: t }, S, { body }).status, 'ok', `${t} / ${body}`);
  }
  // 제목 판정은 본문이 있어도 그대로, 사유에 "본문" 이 붙지 않는다
  const tv = classify({ title: '이재명 근황' }, {}, { body: '아무 내용' });
  assert.equal(tv.status, 'blocked');
  assert.ok(!tv.reasons.some((r) => r.startsWith('본문 ')));
});

test('므흣: 짧은 단어가 일상 표현에 걸리지 않음', () => {
  for (const t of ['이건 꼭 봐야한다', '오늘은 무조건 먹어야한다', '이제 해야한다 ㅋㅋ', '출근해야 해서 못 간다는 친구', '이제 군대 가야하게 생김',
    '기생충 (2019) 다시 봤는데', '코로나19) 걸렸던 썰', '계약후 잠수탄 집주인', '탈모약후기', '찌찌뽕 하는 초딩들', '지하철 쩍벌남 참교육',
    '가슴 골절된 썰', '성인 용돈 얼마 줘야 됨?', '성인용 기저귀 차고 출근한 썰', '남성 관계자 증언', '인성 관계없이 실력만']) {
    assert.equal(status(t), 'ok', t);
  }
  for (const c of ['코로나19', '2019 회고']) assert.equal(classify({ title: '오늘 일기', category: c }).status, 'ok', c);
  for (const t of ['[약후] 비키니 누나', '약후) 레깅스', '19) 뇌가 가슴에…', '야한 짤 모음 꼭 봐야한다', 'ㅋㅋ야한 짤', '버스 쩍벌녀', '가슴골 ㄷㄷ',
    '성인용품점 후기', '(19) 수위 높음', '[19] 짤', '미국 고등학생들 성관계도 레전드', '여자랑 ㅅㅅ했다고 우쭐하지 말아야 하는 이유.',
    '일본에서 야하다고 난리난 광고', '리얼돌...내부 공개', '야해서 못 보는 짤', '너무 야하게 생긴 고양이']) {
    assert.equal(status(t), 'adult', t);
  }
  for (const c of ['19', '19금', '약후']) assert.equal(classify({ title: '오늘 일기', category: c }).status, 'adult', c);
});

test('뉴스: 대괄호 빠진 꼬리표·.New·헤드라인 말줄임·뉴스 갤 말머리', () => {
  const S = { strictness: 'strict' };
  for (const t of ["단독] 아시안게임 동메달 만으로 아파트 당첨…'메달 특공' 논란", '속보]부천 공장 화재로 소방관 1명 심정지-4명 부상',
    '양육비 감소는 불가하다는 법원.New', '유해진 신변보호 해제…‘배우 특혜’ 논란', '（속보）오늘 날씨']) {
    assert.equal(status(t, S), 'blocked', t);
  }
  assert.equal(classify({ title: '아무 제목', category: '새갤' }).status, 'blocked');
  for (const t of ['박보영이 폭로한 이광수 인성', '이지혜씨 성심당 싹쓰리 논란 해명해주세요', '뉴진스...NewJeans 컴백 반응', '서울 지하철 유실물 82만건…절반도 못 돌아가']) {
    assert.equal(status(t, S), 'ok', t);
  }
  assert.equal(classify({ title: '요즘 유튜브 컨텐츠', category: '사회' }).status, 'ok');
});

test('사건사고: 죽인·징역·심정지·폭행, 과장 표현은 통과', () => {
  const S = { strictness: 'strict' };
  for (const t of ['치킨집 사장 폭행한 만취아줌마', '조카 숯불에 구워 죽인 81살 무당', '징역 10년 나온 010번호 피싱범', '부천 공장 화재로 소방관 1명 심정지',
    '무기징역 선고받은 살인범', '남편을 죽였다는 아내 구속']) {
    assert.equal(status(t, S), 'blocked', t);
  }
  for (const t of ['모기 죽인 썰', '분위기 죽였다 ㅋㅋ', '귀여운 죄로 징역 100년', '심정지 올 뻔한 귀여움', '고양이한테 폭행당하는 강아지', '마약김밥 먹어본 후기', '맛이 죽인다']) {
    assert.equal(status(t, S), 'ok', t);
  }
});

test('정치 인물·기관, MAGA 는 문맥으로만', () => {
  const S = { strictness: 'strict' };
  for (const t of ['유승민, 경찰 발표에 대한 입장문', '김세의 눈물: "나 정신병 생겼다"', '가로세로연구소 김세의 근황', '충격적 폭로에 국토위 \'술렁\'',
    '지독한 국방부에 찍혀 커리어 망친 장교', '미국 마가 인플루언서 근황', '요즘 여성징병제 네이트판 반응.jpg']) {
    assert.equal(status(t, S), 'blocked', t);
  }
  for (const t of ['할머니가 세연이한테 한 말', 'magazine 표지', '드라마가 현실이 됐다는 하정우네 집안 족보', '미국 마가린 근황', '엄마가 인플루언서 됨']) {
    assert.equal(status(t, S), 'ok', t);
  }
});

test('2글자 단어가 다른 단어 속에 끼어도 차단하지 않음', () => {
  for (const t of ['싱글벙글 AI가 평가한 남자 관상별 군대선임 티어', '사망여우에게 처맞고도 정신 못차림', '고양이 키운지 1년 된 후기', '얼마나 귀여운지 보세요',
    '메갈로돈이 실존했다면', '페미닌룩 입고 출근한 남편', '노무라 증권 보고서', '익사이팅한 출근길', '시신경 손상된 사람', '거대선박', '트럼프 카드로 탑 쌓기']) {
    assert.equal(status(t), 'ok', t);
  }
  for (const t of ['운지 드립', 'ㅋㅋ운지', '메갈 근황', '대선 후보 토론', '이번대선 근황', '노무현 드립', '익사 사고', '시신 발견']) {
    assert.equal(status(t), 'blocked', t);
  }
});

test('띄어 쓴 두 단어를 붙여서 잡지 않음 (회피형은 계속 잡음)', () => {
  for (const t of ['왼쪽 발이 저린 이유', '한쪽 발 이렇게 들고', '수박 들고 뛰는 아저씨', '할매 미용실 후기', '그게 정의 당연한거 아님?', '이해 찬성합니다',
    '정박 아니야', '드론 추락 사고 ㅋㅋ', '망한 가게 재기해서 대박난 사장님']) {
    assert.equal(status(t), 'ok', t);
  }
  assert.equal(status('김치 남은 거 처리법', { strictness: 'strict' }), 'ok');
  for (const t of ['윤.석.열이', '윤석 열이 또', '노 무현', '쪽 발 이 새끼들', '국민의 힘 지지율']) {
    assert.equal(status(t), 'blocked', t);
  }
});

test('엄격 소스: 다른 단어 속 약한 정치 단어는 통과', () => {
  const S = { strictness: 'strict' };
  for (const t of ['북한산 등산 후기', '영화 시사회 다녀온 후기', '정당방위 인정된 레전드', '단풍 장관이네', '최대공약수 못 구하는 대학생', '사내 정치 레전드',
    '보수적인 부모님 설득하는 법', '퐁퐁으로 설거지하는 고양이']) {
    assert.equal(status(t, S), 'ok', t);
  }
  for (const t of ['장관이 사퇴한 이유', '법무부 장관이 한 말']) assert.equal(status(t, S), 'blocked', t);
});

test('기호·전각 문자로 끼운 회피형도 잡음', () => {
  for (const t of ['윤ㆍ석ㆍ열 근황', '윤…석…열 근황', '윤♡석♡열 근황', '이「재」명 근황', '윤・석・열 근황', '국민ㆍ의힘 근황']) {
    assert.equal(status(t), 'blocked', t);
  }
  for (const t of ['KBS 드라마 웃긴 장면', '후방카메라 달았다']) assert.equal(status(t), 'ok', t);
  for (const t of ['ㅎㅂ 짤', 'ㅇㅎ) 누나']) assert.equal(status(t), 'adult', t);
});

test('쇼츠 점수: 썰·반응류가 질문·핫딜보다 높다', () => {
  const good = shortsScore({ title: '작가와 독자의 기싸움 레전드썰' });
  const bad = shortsScore({ title: '노트북 추천 좀 해주세요 질문' });
  assert.ok(good > 70, `good=${good}`);
  assert.ok(bad < 30, `bad=${bad}`);
  assert.ok(shortsScore({ title: '사투리 반응', likes: 500 }, { likes: 20 }) > shortsScore({ title: '사투리 반응', likes: 5 }, { likes: 20 }));
});

test('중복 제목 키', () => {
  assert.equal(titleKey('[펌] 작가와 독자의 기싸움 ㅋㅋㅋ'), titleKey('작가와 독자의 기싸움!!'));
});

test('성범죄·괴롭힘 소재는 차단 (장난 몰카는 통과)', () => {
  const S = { strictness: 'strict' };
  for (const t of ['알바하다가 성희롱 당한 썰', '지하철 성추행범 잡은 썰', '학폭 가해자 근황', '스토커한테 시달린 썰', '데이트폭력 신고했더니']) {
    assert.equal(classify({ title: t }, S).status, 'blocked', t);
  }
  for (const t of ['몰카 레전드 ㅋㅋ (예능)', '동생 몰카 했는데 반응 ㅋㅋ']) assert.equal(classify({ title: t }, S).status, 'ok', t);
});
