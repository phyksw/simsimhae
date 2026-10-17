# 선별 점수 모델 (룰베이스 + 학습 점수)

Claude 판정(운영자 PC)이 오기 전까지, 그리고 판정 대기열 순서를 정할 때 쓰는 제목 기반 점수. 기준은 `STYLE.md` (쇼츠 "궤").

| 파일 | 하는 일 |
|---|---|
| `rules.js` | 손으로 쓴 규칙 묶음. 감점(성적·무거운 소재·분노·연애 갈등·돈·남녀/나라 일반화·시사·홍보 …)과 가점(사투리·외국인·말장난·대화·의외의 이유·동물 …). 금지 소재 묶음은 **상한(cap)** 이 있다 |
| `features.js` | 제목 특징 (문자 1~3-gram·단어·형식 표지·출처·말머리). 학습과 점수 매기기가 같은 함수를 쓴다 |
| `train.js` | 학습·교차검증·눈금표 도구 (순수 JS). 고른 설정 `DEFAULT_CONFIG` 와 그 근거 숫자 |
| `score.js` | `modelScore(post)` → `{funny, vibe}` 0~100 정수, `ruleCaps(post)`, `explainScore(post)`(근거 특징) |
| `keyword.js` | 예전 키워드 점수 (`filter-rules.js` 의 SHORTS_SIGNALS·VIBE_SIGNALS) |
| `weights.json` | `scripts/train-rule-model.js` 가 만든 가중치 (특징 상위 3,000개씩, 약 150KB) |

점수 = 눈금표(학습 logit + 가점 규칙 × 0.5) → 금지 소재 상한. 0~100 은 Claude 점수와 같은 눈금이라 65·70 기준을 그대로 쓴다.
`src/filter.js` 의 `shortsScore`·`vibeGuess` 가 키워드 점수와 이 점수를 `weights.json` 의 `blend` 비율(키워드 몫)로 섞고 상한을 다시 씌운다.
`src/crawler.js` 의 판정 대기열 우선순위(`selectionScores`)는 섞지 않은 `modelScore` 를 쓴다 (키워드와 이중으로 섞이지 않는다).

## 다시 학습하기

```
node scripts/train-rule-model.js --report            # data/posts.json (읽기만) → src/model/weights.json
node scripts/train-rule-model.js --posts <판정 사본> --report   # 판정이 든 다른 글 파일로 ({posts:{…}} · {posts:[…]} · [글] 모두 받음)
node scripts/train-rule-model.js --grid --dry-run    # 설정 비교표 (1~2분)
```

- 새 기준 판정에는 `ai.criteria` 표시(`src/criteria.js` 의 `CRITERIA_VERSION`, 지금 `style-2026-10`)가 붙는다 (PC 판정 루틴·사이트의 Claude 검수 모두).
  표시가 없는 판정은 옛 기준이다. 옛 판정 중 새 기준이면 통과할 만한 글(유머 아님·분위기 70 미만, 금지 상한 없음)은
  `node scripts/pc-routine.js prepare --revisit` 으로 새 기준 판정을 받을 수 있다.
  (학습 스크립트는 아직 표시로 판정을 가르지 않는다 — 옛 판정도 같은 무게로 쓴다.)
- **주의: 클라우드 판정은 `data/posts.json` 에 들어오지 않는다.** 운영 구성에서는 PC 판정 루틴의 `apply`(기본 사이트 = 클라우드)와
  사이트의 Claude 검수가 판정을 클라우드 DO 에만 저장한다. 그래서 기본 입력(`data/posts.json`, 클라우드로 옮기기 전의 로컬 사본)으로
  다시 돌리면 같은 입력이라 같은 `weights.json` 이 나온다 — 새 기준 판정(`--revisit` 포함)으로 다시 학습하려면 판정이 든 사본을 `--posts` 로 넘겨야 한다.
  지금은 판정을 내려받는 명령이 없다: 관리자로 로그인한 채 `GET /api/posts?board=<출처 id>&size=100&page=N`(출처마다, 관리자 응답에 `ai` 가 있다)과
  `board=filtered`·`board=adult` 를 끝까지 받아 글 목록 하나(`[글]`)로 합친다. 클라우드는 보관 기간이 지난 글을 지우므로,
  학습 전에 `data/posts.json` 의 옛 판정과 id 로 합친다 (같은 id 면 클라우드 쪽). 판정이 든 글이 50개보다 적거나 양성이 하나도 없으면
  학습 스크립트가 파일을 쓰지 않고 실패한다 (판정 없는 공개 `/api/posts` 응답을 넘겨 모든 점수가 0 이 되지 않게).
- 사이트 글의 겹은 같은 제목끼리 나누고, 크롤러가 같은 글로 묶은 사본(`dupOf`)은 대표 제목의 겹으로 맞춘다 (제목이 조금 다른 같은 글이 학습·시험 겹에 갈라지지 않게, 다른 글의 겹은 그대로).
- `weights.json` 모양이 이상하면(눈금표가 숫자가 아님·가중치가 비었음) `score.js` 가 서버를 멈추지 않고 학습 점수 없이 키워드 점수로 물러난다
  (`MODEL_READY` false, 섞는 비율은 키워드만, 판정 대기열 순서도 키워드 점수).

- 같은 입력이면 같은 파일이 나온다 (`trainedAt` = 입력 글의 가장 늦은 Claude 판정 시각, `--stamp` 로 바꿀 수 있다).
- 보고의 "사이트"는 Claude 판정이 있는 글의 5겹 교차검증(겹 밖 예측), "쇼츠"는 `reference-shorts.json`(양성)과
  `reference-negatives.json`(빠진 쇼츠·대조 채널, 음성)의 5겹 교차검증이다. 섞는 비율은 J = 0.6·쇼츠 AUC + 0.4·사이트 AUC 가 가장 큰 값
  (사이트 AUC 가 키워드 기준선보다 낮으면 안 되고, J 가 0.002 안쪽으로 같으면 키워드 몫이 큰 쪽).
- 사이트 라벨은 예전 기준의 Claude 판정이라 궤와 어긋나는 글이 섞여 있다 (STYLE.md §6). 그래서 쇼츠 쪽 지표에 무게를 둔다.

## 규칙을 고칠 때

- 기준 쇼츠 3개와 STYLE.md §8 대표 예시는 상한에 걸리면 안 되고, §8 탈락 예시·§6.5 금지 소재 글은 걸려야 한다 (`test/model.test.js`).
- `reference-shorts.json` 전체에서 상한에 걸리는 제목은 시험의 허용 목록(연봉·월세·욕설·외모 평가·요즘 애들·정부처럼 일부러 막는 낱말)만이어야 한다.
  낱말 일부가 같은 오탐(대처가·아기자기·퇴근 전 와이프·코인노래방·멕시코인·키보드 테러·과정부터·전성기 …)은 앞뒤를 막아 둔다 (`test/model.test.js` 의 오탐 목록).
- 규칙을 바꾸면 `r:묶음` 특징도 바뀌므로 다시 학습한다.
- `filter.js` 를 고치면 로컬 서버는 규칙 지문이 바뀌어 시작할 때 `rejudgeAll` 을 한 번 돈다 (키워드 재판정·본문 검사 표시 초기화, Claude 호출 없음).
  클라우드 지문은 `filter.js` 판정 함수의 번들 안 글자로 만들므로, `src/model/` 에 `fold`·`normalize`·`compile` 같은 같은 이름의
  최상위 함수를 두지 않는다 (번들러가 이름을 바꿔 클라우드 전체 재판정이 일어난다).
