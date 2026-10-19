# 브루잉 — 심심할 때 보는 유머 모음

한국 커뮤니티 유머/베스트 게시판의 글을 모아, **정치·혐오·사건사고·뉴스 글은 걸러내고**, **므흣(후방) 글은 비밀번호 잠금 게시판(🔒 그라운즈)으로** 보내는 사이트입니다.
고른 글을 읽어주며 반응하는 **쇼츠 제작**에 맞춰 "쇼츠 적합도" 점수, 쇼츠 후보함, 대본용 텍스트 복사 기능이 있습니다.

## 실행

```bash
npm install
npm start
```

브라우저에서 http://127.0.0.1:3000 을 엽니다. 처음 실행하면 콘솔에 **잠금 게시판 비밀번호**와 **관리자 비밀번호**가 출력됩니다
(`data/secrets.json` 에 저장되며, `.env` 의 `ADULT_PASSWORD` / `ADMIN_PASSWORD` 로 바꿀 수 있어요).
비밀번호는 `secrets.json` 을 처음 만든 실행에만 화면에 보여주고, 그 뒤로는 파일 위치만 알려줍니다. 비밀번호를 바꾸고 다시 시작하면 기존 로그인·잠금 해제는 모두 풀려요.

| 명령 | 설명 |
|---|---|
| `npm start` | 웹 서버 + 실시간 자동 수집 |
| `npm run crawl` | 서버 없이 한 번만 수집하고 결과 요약 출력 |
| `npm run test:source -- dogdrip` | 한 소스 어댑터를 실제 사이트로 검증 |
| `npm test` | 필터·파서 단위 테스트 |
| `npm run worker:dev` / `npm run worker:deploy` | 클라우드 사이트 로컬 시험 / 배포 (아래 **클라우드 사이트**) |
| `npm run cloud:push -- <주소>` | 내 컴퓨터의 글·금지어를 클라우드 사이트로 옮기기 |
| `node scripts/cloud-review.js <주소> queue\|apply` | 검수 대기 글 받기 / Claude 판정 올리기 (API 키 없이 이 컴퓨터에서 검수할 때) |
| `node scripts/pc-routine.js collect\|queue\|prepare\|apply\|status` | PC 판정 루틴: 막힌 출처 수집 올리기 · 판정 파일 만들기 · 둘을 한 번에(예약 작업용) · 판정 올리기 (아래 **PC 판정 루틴**) |

설정은 `.env.example` 을 `.env` 로 복사해서 바꿉니다.

## 화면

- **게시판 칩**: 😄 푸어오버(첫 화면) · 전체 · 출처별 · 🔒 그라운즈. 칩 숫자는 그 게시판 목록의 글 수와 같습니다.
  - **😄 푸어오버**: 공개 글 중 (기간 제한 없이 최근 300개) 쇼츠 유머처럼 "그냥 웃긴" 글만. Claude 판정이 정상이고 쇼츠 점수 65 이상인 글(판정이 없으면 키워드 쇼츠 점수 60 이상, 관리자가 게시하고 후보로 담은 글은 포함).
  - 출처별 칩은 수집 중인 사이트마다 하나씩이고, 수집을 껐어도 공개 글이 남은 출처는 흐리게 보입니다.
- 글마다 **출처 배지**가 붙고, 같은 글이 여러 곳에 올라오면 하나로 묶어 "같은 글:" 배지로 보여줍니다.
- 제목을 누르면 **미리보기**(본문을 이 사이트 안에서 보기). ⚙ 보기 설정에서 "원문 새 탭으로 열기"로 바꿀 수 있습니다.
- 정렬: 최신순 · 인기순(출처별 추천/댓글 순위 + 시간 감쇠) · 쇼츠추천순(관리자에게만)
- 미리보기의 **📋 대본 복사**·**💬 댓글 포함 복사**(관리자에게만): 제목·본문 글자·(베스트 댓글)·출처를 한 번에 복사합니다.
- 미리보기 머리(휴대폰은 화면 아래에 고정)의 **− 100% +**: 본문·댓글의 글자와 그림을 함께 50~150% 로 (가운데 숫자를 누르면 100%). **화면 맞춤**을 켜면 본문 그림·영상 하나하나가 화면 높이 안에 통째로 들어옵니다(글자는 그대로). 브라우저마다 기억하고, 단축키는 `-` `+`(`=`) `0` `F`(한글 자판 `ㄹ`) — 입력칸 안이나 Ctrl/⌘/Alt 조합에서는 동작하지 않습니다. 크기·화면 맞춤을 바꿔도 화면 가운데에 있던 내용이 그대로 가운데에 남습니다.

### 관리자 (👤)

- **🔴 실시간 ON/OFF**: 켜면 정해진 간격(5분~1시간)마다 자동 수집하고, 열려 있는 화면에 새 글이 바로 올라옵니다. 끄면 **지금 수집** 버튼으로만 수집합니다.
- **🚫 걸러진 글**: 키워드 필터나 Claude 검수에 걸린 글을 사유와 함께 보여줍니다. **게시하기**를 누르면 공개 목록에 들어가고, **그라운즈로**를 누르면 잠금 게시판으로 옮겨집니다. 공개 글을 **숨기기**도 할 수 있습니다.
- **🎬 후보함**: 쇼츠로 만들 글을 담고 `후보 → 대본 작성 → 촬영 완료` 단계와 메모를 관리합니다. 후보로 담은 글은 오래돼도 지워지지 않습니다.
- **금지어 관리**: 차단 단어 / 그라운즈 단어 / 예외 단어를 추가하면 기존 글까지 제목 기준으로 다시 판정하고, 본문은 다음 미리보기 때 새 규칙으로 다시 검사합니다. `^단어` 처럼 쓰면 단어 맨 앞에서만 찾습니다.
- **출처 상태**: 사이트별 마지막 수집 결과와 오류를 보여줍니다.

## 검열은 어떻게 하나

1. **키워드 필터** (즉시, 무료) — `src/filter-rules.js`
   - 정치(인물·정당·선거·진영 멸칭), 혐오(성별·지역·세대·인종 비하, 일베 용어), 사건사고(사망·범죄), 뉴스·시사(방송사 꼬리표, `[속보]`) → **차단**
   - 후방·ㅇㅎ·약후·노출 단어, 사이트의 후방 말머리 → **그라운즈 잠금 게시판**
   - `한남동`, `홍어삼합`, `노무사`, `자살골`, `후방카메라` 같은 예외 처리, `윤 석 열`처럼 띄어 쓴 회피도 잡습니다.
   - 정치 글이 많이 섞이는 출처(디시 실베 등)는 `strict` 로 더 엄격하게 봅니다.
   - 미리보기로 본문을 연 글은 본문 글자로 한 번 더 검사합니다. 본문은 제목보다 기준이 높아 서로 다른 강한 단어 2개 이상이나 후방·기사 표식이 있어야 걸리고, 사유 앞에 "본문"이 붙습니다.
   - `src/filter.js`·`src/filter-rules.js` 를 고치면 다음 서버 시작 때 저장된 글을 모두 다시 판정합니다.
2. **Claude 검수** (선택, 사용료 있음) — `src/ai.js`
   - `.env` 에 `ANTHROPIC_API_KEY` 를 넣으면 켜집니다. 수집이 끝날 때마다 새 글 제목을 40개씩 묶어 Claude 가 정상/정치/혐오/사건사고/므흣/유머아님 판정과 쇼츠 적합도를 매깁니다.
   - Claude 검수가 켜져 있으면 새 글은 **판정을 통과한 뒤에** 공개됩니다(실패가 이어지면 60분 뒤 키워드 판정만으로 공개).
   - 키워드와 Claude 중 **더 엄격한 판정**을 따르고, 관리자가 직접 지정한 상태가 항상 최우선입니다.
   - 기본 모델은 `claude-opus-5-5`, effort `low` 입니다. 비용을 크게 줄이려면 `AI_MODEL=claude-haiku-5-5`.
   - **클라우드 사이트**에서는 두 가지 중 하나로 합니다.
     - Worker 비밀 `ANTHROPIC_API_KEY` 를 넣으면 클라우드가 수집할 때마다 스스로 판정합니다 (내 컴퓨터가 꺼져 있어도 됨, API 사용료 있음).
     - API 키 없이 내 컴퓨터의 Claude Code 로 검수하려면 `node scripts/cloud-review.js <주소> queue --out queue.json` 으로 대기 글을 받고,
       판정을 `{"model": "claude-code 검수", "items": [{"id", "verdict", "shortsScore", "reason"}]}` 파일로 만들어 `node scripts/cloud-review.js <주소> apply 판정.json` 으로 올립니다.
       관리자 비밀번호로 로그인해서 부릅니다(클라우드에는 `x-admin-key` 가 없음). 검수하지 않은 글은 키워드 판정만으로 공개됩니다.

## PC 판정 루틴 (운영자 PC 의 Claude 로 최종 선별)

클라우드 사이트는 키워드 필터·점수 모델로 1차 선별만 하고, **최종 판정은 운영자 PC 의 Claude**(구독, API 키 없이)가 합니다.
`scripts/pc-routine.js` 가 그 사이를 이어 줍니다. Windows PowerShell 에서 프로젝트 폴더로 가서:

```powershell
$env:CLOUD_ADMIN_PASSWORD = '<클라우드 관리자 비밀번호>'   # 없으면 data/secrets.json 의 adminPassword (이 PC 서버 비밀번호라 다를 수 있음)
node scripts/pc-routine.js prepare   # 1) collect + queue: 막힌 출처 올리기, review/ 에 batch·그림·INSTRUCTIONS.md (끝 줄 "판정할 파일: …")
#    → Claude Code 에게 "review/INSTRUCTIONS.md 대로 판정해 줘" (판정 파일 review/verdicts-<시각>.json 이 생김)
node scripts/pc-routine.js apply review/verdicts-<시각>.json   # 2) 판정 올리기
node scripts/pc-routine.js status    # 대기 수·최근 판정 시각·올리지 않은 판정 파일·PC 수집 출처 상태
```

| 명령 | 하는 일 |
|---|---|
| `collect` | 막힌 출처(`dogdrip`·`todayhumor`·`ppomppu`)의 목록·미리보기를 이 PC 에서 받아 올리기 |
| `queue` | 판정 대기 글 → `review/batch-<시각>.json` + 그림 + `review/INSTRUCTIONS.md` |
| `prepare` | `collect` 다음 `queue` (예약 작업용). 하나가 실패해도 다른 하나는 하고, 끝에 `판정 대기 N개` 와 `판정할 파일: …` 한 줄. queue 가 실패하면 종료 코드 1 |
| `apply <판정.json>` | 판정 파일을 검사해 틀린 항목만 빼고 올리기 (뺀 수·이유, batch 에서 빠뜨린 글 수를 알림). 올릴 항목이 하나도 없으면 종료 코드 1 |
| `status` | 판정 대기 수, 다시 볼 옛 판정 수, 최근 판정 시각, 아직 올리지 않은 판정 파일(올리는 명령 포함), PC 수집 출처 상태 |

- **collect**: Cloudflare 에서 403 으로 막히는 출처의 목록 2쪽과, 아직 미리보기가 없는 글의 본문(점수 높은 순, 한 번에 최대 20개)을
  이 PC 에서 받아 관리자 전용 `POST /api/admin/ingest` 로 올립니다. 사이트는 자기가 수집한 것과 똑같이 처리합니다(키워드 판정·중복 묶기·점수·출처 상태).
  미리보기는 글에 붙여 두고(3일, 게시판에 남은 글은 계속) 방문자가 열 때 그대로 보여 줍니다. PC 가 13시간 안에 올린 출처는 클라우드의 자동 수집이 건너뜁니다.
  요청 간격은 `src/lib/http.js` 그대로(같은 사이트 1.2초, 개드립 10초). 옵션 `--sources a,b --pages 2 --previews 20`.
  클라우드는 PC 가 받는 출처의 글과 PC 미리보기가 붙은 글은 알람의 미리 준비(prefetch)에서 원문을 받으려 하지 않고(어차피 403), 규칙 재판정 때는 붙어 있는 PC 미리보기로 본문을 다시 검사합니다.
- **queue**: `GET /api/admin/review-queue?withRead=1` 로 판정 없는 최근 7일 글을 선별 점수(`src/model/score.js` 의 점수 모델, 없으면 키워드 점수) 높은 순으로 받아
  `review/batch-<시각>.json`(본문 앞부분·베스트 댓글·반응 수치·그림 파일 전체 경로 `imagePaths`), 본문을 받은 글의 그림(최대 3장씩, 사이트의 `/api/img` 프록시로, 안 되면 이 PC 에서 직접 —
  개드립처럼 요청 간격이 긴 출처는 그 간격(10초)으로 글마다 1장), `review/INSTRUCTIONS.md` 를 만듭니다. 옵션 `--limit 60 --top 20`, 분위기 점수만 매길 때 `--vibe`.
  판정할 글이 없으면 batch·그림 폴더는 만들지 않고 안내만 씁니다. 끝날 때 최근 batch 14개만 남기고 지난 batch·그림·올린 판정 파일을 지웁니다(아직 올리지 않은 판정 파일과 그 짝 batch 는 남김).
  - 본문 채우기: 사이트는 위쪽 `--top` 개를 읽고, PC 미리보기가 있는 글은 그 밖이어도 붙여 줍니다. 그래도 본문이 없는 글(막힌 출처·`--top` 밖·사이트 시간 초과)은
    이 PC 가 출처 어댑터로 직접 읽어 채웁니다 (요청 간격은 collect 와 같고, 출처마다 30개까지, 전체 `--read-budget 180`초(최대 86400) — 지나면 보내던 요청을 끊고 나머지는 본문 없이, `0` 이면 읽지 않음).
    막힌 출처(`dogdrip`·`todayhumor`·`ppomppu`) 것은 미리보기로 사이트에도 올려(collect 와 같은 크기·개수 제한) 방문자 미리보기와 다음 queue 가 그대로 씁니다.
    올린 본문의 검사로 걸러진 글은 batch 에서 빠지고, 올리기가 실패해도 batch 는 만듭니다. 못 읽은 글은 항목의 `readError` 에 까닭이 남습니다.
  - **옛 판정 다시 보기** `--revisit [N]` (기본은 하지 않음, N 기본 30, `prepare` 에도 붙일 수 있음): 판정 기준이 바뀌기 전(잡학 = 유머 아님 등)에 판정된 글 중
    `not_humor` 이거나 정상인데 분위기 점수가 핸드드립 기준(65) 아래인 글을, 점수 모델의 분위기 점수 높은 순으로 N개 batch 뒤에 넣습니다 (`GET /api/admin/review-queue?revisit=1`).
    관리자가 상태나 핸드드립 넣기/빼기를 정한 글, 키워드·본문 판정이 차단·므흣인 글, 금지 소재 상한(`src/model/rules.js`)에 걸린 글, 사본은 빼고,
    항목마다 옛 판정(`previousVerdict`)을 붙입니다. INSTRUCTIONS.md 는 "다시 보기 항목은 새 기준으로 처음부터" 판정하라고 적습니다.
  - 판정 기준 표시: 판정을 올리면(`/api/admin/verdicts`, 사이트의 Claude 검수도) `ai.criteria` 에 지금 기준 표시(`src/criteria.js` 의 `CRITERIA_VERSION`, 지금 `style-2026-10`)가 남습니다.
    표시가 없거나 다른 판정이 "옛 판정" 입니다. 판정 기준 문장(`src/ai.js` `CRITERIA`·`VIBE_TABLE` = `STYLE.md` §7)을 바꾸면 이 값도 바꿉니다.
    판정 올리기는 이미 판정이 있는 글도 덮어씁니다(예전부터 그랬고, 같은 판정 파일을 고쳐 다시 올릴 때 씀). 판정된 글이 다시 판정되지 않게 하는 건 대기열입니다 —
    기본 대기열은 판정 없는 글만, 다시 보기는 지금 기준 표시가 없는 글만 줍니다.
- **INSTRUCTIONS.md** 는 이 파일 하나만 읽은 Claude 가 혼자 끝낼 수 있게 씁니다: 할 일 순서(이미 올린 batch 건너뛰기, 20개씩 판정하며 결과 파일 다시 쓰기, apply 한 번),
  `src/model/STYLE.md` §7 판정 문장·점수표 그대로(파일이 없으면 `src/ai.js` 의 `CRITERIA`·`VIBE_TABLE`), §8 예시와 사이트 글에서 나온 탈락 예,
  batch 항목에서 볼 것(제목·본문 앞부분·베스트 댓글·그림 파일), 결과 파일 이름과 apply 가 검사하는 모양, 게시판 기준 점수(`src/boards.js` 에서 읽음).
  사이트의 Claude 검수(`src/ai.js`)도 같은 §7 문장을 씁니다 (바꾸면 새 글부터 새 기준, 이미 판정된 글은 다시 보내지 않음 — 옛 판정은 위 `--revisit` 으로 PC 가 다시 봅니다).
- **apply**: 판정 파일 `{"model": "claude-code 검수", "items": [{"id", "verdict", "shortsScore", "vibe", "reason"}]}` 을 검사합니다 —
  `verdict` 는 `ok|politics|hate|dark|adult|not_humor`, `shortsScore`·`vibe` 는 0~100 숫자(ok 면 둘 다 필수, ok 가 아니면 0 으로), `reason` 은 60자에서 자름, 같은 id 는 처음 것만.
  짝 batch 에 없는 id 는 `뺌: <id> — batch 에 없는 글` 로 빼고(이미 있는 판정을 덮지 않게), 틀린 항목은 `뺌: <id> — <이유>` 로 알리고 나머지를 64KB 씩 나눠 올립니다.
  끝에 핸드드립 조건(ok + shortsScore·vibe 기준 점수, `src/boards.js`)에 드는 글 수와 제목을 한 줄로 찍습니다.
  판정 파일은 UTF-8(BOM 있어도 됨)이나 UTF-16(BOM 있음)이어야 하고, PowerShell 5.1 의 `Set-Content` 기본(CP949)으로 쓴 파일은 한글이 깨지지 않게 거절합니다.
  올린 판정 파일은 `review/state.json` 의 `appliedFiles`(최근 200개, 밀려난 것은 `appliedUpTo` 기준선으로 — 그보다 오래된 판정 파일은 올린 것으로 침)에 남아,
  다음 `queue`·`prepare` 가 "아직 올리지 않은 판정 파일" 을 안내 맨 앞에 적습니다 (콘솔에도 같은 올리는 명령을, 폴더·사이트가 기본이 아니면 `--dir`·`--site` 까지 붙여 찍습니다).
  다른 사이트에서 받은 batch 의 판정 파일은 "먼저 할 일" 에 넣지 않고 따로 알리고, 올릴 항목이 하나도 없던(모두 형식 오류·읽지 못함) 판정 파일은 `failedFiles` 에 남아
  고쳐 저장하기 전까지 "먼저 할 일" 에서 빠집니다(`status` 의 `올리지 못한 판정 파일`). `state.json` 이 없거나 깨졌으면 가장 최근 판정 파일 하나만 "아직 올리지 않음" 으로 봅니다.
- **점수 모델 다시 학습**: `node scripts/train-rule-model.js --report` (기본 `data/posts.json`, 읽기만) 또는
  판정이 든 글 파일로 `node scripts/train-rule-model.js --posts <판정 사본> --report` → `src/model/weights.json`.
  클라우드에 올린 판정(`apply`·`--revisit` 포함)은 클라우드에만 쌓이고 `data/posts.json` 에는 들어오지 않으므로, 새 판정으로 학습하려면 판정이 든 사본을 따로 만들어 넘겨야 합니다
  (만드는 법과 주의는 `src/model/MODEL.md` 의 "다시 학습하기"). 판정 글이 50개보다 적으면 학습 스크립트는 파일을 쓰지 않고 실패합니다.
- 공통: `--site <주소>`(기본 `https://simsimhae.palebluedot13.workers.dev`), `--dir <폴더>`(기본 `review/`, git 에 올리지 않음). 비밀번호는 화면에 찍지 않습니다.
  batch 는 받은 사이트를 기억합니다: 기본 사이트가 아니면 INSTRUCTIONS.md 의 올리는 명령에 `--site` 가 붙고, `apply` 는 batch 를 받은 사이트가 아닌 곳에는 올리지 않습니다 (시험 사이트의 판정이 운영 사이트에 들어가지 않게).
- **예약 작업**: `scripts/pc-routine-task.md` 의 지시문을 Claude 예약 작업에 붙여 넣으면 `prepare → 판정 → 결과 파일 → apply → status` 를 돌고 보고합니다
  (실패하면 멈추고 보고, 비밀번호는 출력하지 않음). 하루 2번 이상(12시간 간격 이하)이면 막힌 출처도 끊기지 않습니다 (PC 가 꺼져 있으면 13시간 뒤부터 클라우드가 다시 직접 시도).

## 출처 추가·수정

`src/sources/<id>.js` 파일 하나가 한 사이트입니다. 규약은 `src/sources/_template.js` 를 보세요.
파일을 만든 뒤 `src/sources/index.js` 목록에 한 줄(import 와 `ADAPTERS`) 추가해야 등록되고(Cloudflare 번들에는 폴더를 읽을 수 없어 정적 목록), `npm run test:source -- <id>` 로 검증합니다.
목록에 빠뜨리면 `npm test` 가 알려 줍니다.
사이트 구조가 바뀌어 수집이 깨지면 관리자 화면의 **출처 상태**에 오류가 뜹니다.

일간베스트·루리웹·메갈리아·워마드는 의도적으로 수집하지 않습니다.

## 클라우드 사이트 (Cloudflare Workers Paid)

수집·판정·관리자 화면까지 전부 **Cloudflare** 에서 돕니다. 내 컴퓨터는 꺼져 있어도 되고, 화면·API 는 이 컴퓨터의 서버(`npm start`)와 같습니다.
관리자는 사이트의 👤 버튼으로 로그인합니다. 자세한 구조·설정·한도는 [`worker/README.md`](worker/README.md), 설계는 [`worker/CLOUD.md`](worker/CLOUD.md).

```
방문자·관리자 ──▶ Worker (simsimhae) ──▶ Durable Object (글·설정·금지어·미리보기 저장, 알람으로 실시간 수집)
                                   ◀── Cron 5분마다 알람 확인
```

### 주소

`https://simsimhae.<workers.dev 서브도메인>.workers.dev` — 워커 이름이 `simsimhae`, 뒤쪽은 Cloudflare 계정의 workers.dev 서브도메인입니다
(지금은 `palebluedot13` → `https://simsimhae.palebluedot13.workers.dev`. 주소는 `worker.dev` 가 아니라 `workers.dev` 예요).
서브도메인은 대시보드 **Workers & Pages** 의 workers.dev **Subdomain** 에서 바꿉니다(예: `board` → `https://simsimhae.board.workers.dev`, 예전 주소는 더는 열리지 않음).

### 처음 한 번 (이 컴퓨터에서)

1. `npx wrangler login` (이미 했다면 건너뜀)
2. 비밀 넣기 — 관리자 화면이 인터넷에 열리므로 길고 무작위로:
   `npx wrangler secret put ADMIN_PASSWORD`, `ADULT_PASSWORD`, `SESSION_SECRET`, (선택) `ANTHROPIC_API_KEY`.
   `ADMIN_PASSWORD` 가 없으면 로그인할 수 없고 자동 수집도 시작하지 않습니다.
3. `npm run worker:deploy` — 또는 GitHub(`phyksw/simsimhae`) 자동 배포(Workers Builds, 배포 명령 `npx wrangler deploy`)라면 `main` 에 올리기.
4. `npm run cloud:push -- https://simsimhae.<서브도메인>.workers.dev` — 이 컴퓨터의 글·금지어·실시간 설정을 클라우드로 옮깁니다(클라우드 쪽 상태는 통째로 바뀜).
5. 옮긴 뒤 이 컴퓨터 서버는 끄거나 실시간 수집을 꺼 두고(같은 사이트를 두 곳에서 수집하지 않게), `.env` 의 `PUBLISH_URL`·`PUBLISH_TOKEN` 은 지웁니다.
6. 사이트에서 👤 로 로그인해 실시간 ON·간격(최소 3분)·**출처 상태**를 확인합니다.

배포 전에 이 컴퓨터에서 미리 보려면 `worker/README.md` 의 "로컬 시험"(`npm run worker:dev`)을 보세요.
예전 "내 컴퓨터가 수집해서 올리는" 공개 사이트(`worker/CONTRACT.md`, `src/publish.js`, D1 `simsimhae`, 비밀 `PUBLISH_TOKEN`)는 이제 쓰지 않습니다.

## 운영 전에 꼭 확인할 것

- **저작권**: 글·이미지의 저작권은 원작성자와 원 사이트에 있습니다. 이 사이트는 제목과 링크를 기본으로 보여주고, 미리보기는 요청할 때 원문에서 가져와 잠시 캐시만 합니다(저장하지 않음). 쇼츠에서 글을 읽어줄 때도 출처를 밝히고, 원작자가 삭제를 요청하면 따르는 게 안전합니다.
- **각 사이트의 이용약관과 robots.txt**: 일부 사이트는 자동 수집을 금지합니다. 출처별 상태와 robots.txt 조사 결과를 보고 쓸 소스를 고르세요(`SOURCES` / `DISABLE_SOURCES`).
- **요청 간격**: 같은 사이트에 1.2초 이상 간격을 두고, 사이트당 목록 2페이지만 가져옵니다. 수집 간격을 너무 짧게 하지 마세요.
- **잠금 게시판**: 비밀번호는 서버에서 확인하고, 잠긴 상태에서는 므흣 글 목록 자체를 보내지 않습니다. 성인 인증을 대신하지는 않으니 공개 운영 시 연령 확인 방식을 따로 고려하세요.
- **외부 공개**: 이 컴퓨터의 서버는 기본이 내 컴퓨터에서만 열리는 `127.0.0.1` 입니다. 위의 **클라우드 사이트** 로 공개하면 이 서버를 외부에 열 필요가 없어요.
  이 서버를 직접 외부에 열려면 `HOST=0.0.0.0` 과 HTTPS 리버스 프록시를 쓰세요.
  - 프록시가 `X-Forwarded-For`·`X-Forwarded-Proto` 를 넘기게 하고, 프록시가 같은 컴퓨터가 아니면 `TRUST_PROXY` 에 그 주소를 넣으세요(기본 `loopback`). 그래야 비밀번호 시도 제한·이미지 프록시 제한이 방문자마다 따로 걸립니다.
  - 인증 쿠키의 `Secure` 는 HTTPS 요청일 때만 붙습니다. `COOKIE_SECURE=1` 이면 항상, `0` 이면 붙이지 않습니다.
  - 이미지 프록시(`/api/img`)는 접속자당 분당 요청 수·동시 연결 수·응답 크기를 제한합니다(`IMG_RATE_PER_MIN`, `IMG_MAX_CONCURRENT`, `IMG_MAX_CONCURRENT_PER_IP`, `IMG_MAX_BYTES`). 넘으면 429·413 을 돌려줍니다.
- **Claude 검수 한도**: 수집 1회에 최대 `AI_MAX_PER_RUN`(200)개만 보내고, 판정에 실패한 글은 점점 늦게 최대 `AI_MAX_TRIES`(6)번까지 다시 보낸 뒤 키워드 판정만으로 둡니다.
