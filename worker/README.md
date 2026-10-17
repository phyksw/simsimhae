# 클라우드 사이트 (Cloudflare Workers Paid)

수집·필터링·관리자까지 전부 Cloudflare 에서 돕니다. 내 컴퓨터는 꺼져 있어도 됩니다. 설계는 [`CLOUD.md`](./CLOUD.md).

```
브라우저 ──> Worker (index.js)
              ├─ 화면 파일: ASSETS (public/) — Worker 를 거치지 않음
              ├─ /api/img: 이미지 프록시 (Worker 에서 바로)
              └─ 그 밖의 /api/* ──> Durable Object SiteDO('main') — 로컬 src/server.js 와 같은 API
Cron (*/5) ──> SiteDO 알람이 살아 있는지 확인
```

| 파일 | 하는 일 |
|---|---|
| `index.js` | 진입점 (`wrangler.jsonc` 의 `main`). 경로 나누기, 이미지 프록시 연결, cron |
| `site.js` | `SiteDO`: 상태 불러오기·저장, 알람 수집 루프, '지금 수집', 미리보기 미리 준비, API 연결 |
| `storage.js` | DO SQLite 저장소 (글 한 행씩·설정·금지어·미리보기 캐시·로그인 시도·옮기기 대기열) |
| `img.js` | 이미지/영상 프록시 (허용 호스트만, 리다이렉트 재확인, 앞부분으로 형식 판별 후 스트리밍), 요청 수 제한 |
| `http.js` | JSON 응답, 보안 헤더, 크기 제한 본문 읽기 |

API 핸들러는 로컬과 같은 코드입니다: `src/api.js` (경로·응답 모양), `src/crawler.js`·`src/reader.js`·`src/filter.js`·`src/store.js`.
로컬은 파일(data/*.json), 클라우드는 DO 저장소를 씁니다 — `package.json` 의 `"imports"."#platform"` 이 Node 에서는 `src/platform/node.js`,
Workers 번들에서는 `src/platform/cloud.js` 를 고릅니다. 새 출처는 `src/sources/index.js` 목록에 한 줄 추가합니다.

## 로컬 시험

프로젝트 맨 위의 `.dev.vars` 에 비밀을 넣습니다 (`.gitignore` 에 들어 있어요):

```
ADMIN_PASSWORD=아무거나길게
ADULT_PASSWORD=비번
SESSION_SECRET=아무거나길게
# 시험 중에 출처 사이트로 수집하지 않으려면 (기본은 켜짐, 15분 — 첫 요청 1초 뒤 바로 전체 출처를 수집한다)
CRAWL_INTERVAL_MIN=0
# 수집을 시험할 때는 출처를 좁혀서 (예: SOURCES=dogdrip,humoruniv), 미리 준비는 적게
# PREFETCH_PER_RUN=1
```

```bash
npm run worker:dev -- --port 8791 --persist-to ../simsimhae-local
```

- 예전 공개 사이트용 `.dev.vars`(`PUBLISH_TOKEN` 만 있는 것)를 그대로 쓰면 `ADMIN_PASSWORD` 가 없어 로그인할 수 없습니다 (그때는 자동 수집도 시작하지 않아요).
- 다른 파일을 쓰려면 `--env-file <파일>` (그때 `.dev.vars` 는 읽지 않음). 시작 화면의 `Your Worker has access to` 표에 변수 이름이 나오는지 먼저 확인하세요.
  `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` 를 함께 주면 `--env-file` 도 읽지 않아 변수가 하나도 없는 상태로 뜹니다.

http://127.0.0.1:8791 이 클라우드와 같은 화면입니다. cron 은 `--test-scheduled` 를 붙이고 `/__scheduled?cron=*/5+*+*+*+*` 로 불러 봅니다.
단위 테스트는 `npm test` (`test/cloud.test.js` = SiteDO, `test/worker.test.js` = Worker 진입점·설정).

## 배포

```bash
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD      # 관리자 로그인 (길고 무작위로 — 관리자 화면이 인터넷에 열린다)
npx wrangler secret put ADULT_PASSWORD      # 므흣 게시판 비밀번호
npx wrangler secret put SESSION_SECRET      # 쿠키 서명용 (길고 무작위로)
npx wrangler secret put ANTHROPIC_API_KEY   # (선택) 넣으면 Claude 검수가 켜진다
npm run worker:deploy
```

- 비밀이 없으면 그 비밀이 필요한 로그인·잠금 해제는 503 입니다 (무작위로 만들지 않아요). 비밀번호를 바꾸면 기존 로그인은 풀립니다.
- `ADMIN_PASSWORD` 가 없으면 실시간 수집도 시작하지 않습니다 (관리자 화면에서 끌 수 없으니). 넣으면 다음 cron(5분 안)이나 첫 요청 때 이어서 돕니다.
- GitHub 자동 배포(Workers Builds)도 그대로 `npx wrangler deploy` 입니다. 첫 배포 때 DO 마이그레이션(`v1`, SQLite)이 함께 적용됩니다.
- 배포 직후 실시간 수집은 켜진 상태(15분)입니다. 처음엔 꺼 두려면 대시보드 변수 `CRAWL_INTERVAL_MIN=0` 을 넣고, 관리자 화면에서 켭니다.

## 내 컴퓨터 데이터 옮기기

```bash
npm run cloud:push -- https://simsimhae.board.workers.dev
```

`data/posts.json`(글·출처 상태·실시간 설정)과 `data/custom-rules.json`(금지어)을 관리자 비밀번호로 로그인해서 나눠 올리고, 다 받은 뒤 한 번에 바꿉니다.
클라우드에 그동안 모인 글은 사라집니다. 비밀번호는 물어보거나 환경변수 `CLOUD_ADMIN_PASSWORD` 로 넘깁니다. 옮긴 뒤에는 내 컴퓨터 서버의 실시간 수집을 꺼 두세요.

## Claude 검수

- **클라우드에서 자동으로**: Worker 비밀 `ANTHROPIC_API_KEY` 를 넣으면 알람(수집)마다 새 글을 Claude 로 판정합니다. 내 컴퓨터는 필요 없고 API 사용료가 듭니다.
  판정을 기다리는 새 글은 판정 뒤에 공개됩니다 (계속 실패하면 60분 뒤 키워드 판정만으로).
- **내 컴퓨터의 Claude Code 로 (API 키 없이)**: 클라우드에는 `x-admin-key` 가 없어서 관리자 로그인으로 부르는 도우미를 씁니다.
  ```bash
  node scripts/cloud-review.js https://simsimhae.board.workers.dev queue --out queue.json   # 판정 없는 최근 글
  node scripts/cloud-review.js https://simsimhae.board.workers.dev apply verdicts.json      # {"model":"claude-code 검수","items":[{"id","verdict","shortsScore","reason"}]}
  ```
  비밀번호는 `CLOUD_ADMIN_PASSWORD` 또는 입력. 판정 파일은 64KB 아래로 나눠 올립니다. 키가 없으면 새 글은 키워드 판정만으로 바로 공개되고, 나중에 올린 판정이 더 엄격하면 그때 숨겨집니다.

## 설정 (대시보드 Variables 또는 `wrangler.jsonc` 의 `vars`)

로컬 `.env` 와 같은 이름을 씁니다: `CRAWL_INTERVAL_MIN`, `PAGES_PER_SOURCE`, `RETENTION_DAYS`, `SOURCES`, `DISABLE_SOURCES`, `CRAWL_MIN_INTERVAL_MS`,
`CRAWL_SOURCE_BUDGET_SEC`, `PREVIEW_MAX_WAIT_SEC`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_PER_RUN`, `AI_MAX_TRIES`, `IMG_RATE_PER_MIN`, `IMG_MAX_BYTES`, `FMKOREA_ENABLE`. 클라우드에만 있는 것:

| 이름 | 기본 | 뜻 |
|---|---|---|
| `READ_CACHE_HOURS` | 12 | 미리보기를 DO 저장소에 두는 시간 |
| `PREFETCH_PER_RUN` | 12 | 수집 한 번에 미리 준비하는 미리보기 수 (소소한 이야기 → 소소한 웃음, 0 이면 안 함) |
| `CRAWL_REQUEST_BUDGET` | 800 | 알람 한 번의 출처 사이트 요청 상한 (미리 준비는 여기서 멈춤) |

## 한도·동작 메모

- 수집은 DO 알람 안에서 돕니다 ('지금 수집'도 알람으로). 알람마다 다음 알람을 먼저 걸어 두어, 수집이 실패해도 다음 수집이 남습니다.
  방금(간격의 절반 안에) 수집했으면 다시 돌지 않습니다. cron 은 5분마다 알람이 사라졌는지만 봅니다.
- '지금 수집'은 기다리는 동안 간격 변경·옮기기의 다시 예약에 밀리지 않습니다. 수집 도중 DO 가 재시작되면 알람이 다시 돌리고(최대 3번), cron 도 남은 요청을 바로 잡습니다.
- 같은 사이트 요청 간격(`CRAWL_MIN_INTERVAL_MS`, dogdrip 10초 등)은 대기열 하나로 지키되, 수집 목록 요청이 방문자 미리보기보다 먼저 나갑니다.
  미리보기는 `PREVIEW_MAX_WAIT_SEC`(20초)보다 오래 기다려야 하면 기다리지 않고 원문 링크로 안내하고, 출처 하나의 목록 수집은 `CRAWL_SOURCE_BUDGET_SEC`(120초)에서 끊습니다.
- 미리 준비는 알람 한 번에 `PREFETCH_PER_RUN` 의 두 배까지만 시도하고 4분 안에서만 합니다. 이번 수집에서 목록을 못 받은 출처는 건너뛰고, 실패 기록은 실패할 때마다 저장합니다.
- 저장소 쓰기가 실패해도 읽기(GET)는 그대로 응답하고 밀린 변경은 다음에 다시 저장합니다. 쓰기 요청은 500 으로 알리고 메모리를 저장된 상태로 되돌립니다.
- 옮기기(`/api/admin/import`)는 본문을 읽기 전에 관리자 쿠키를 확인하고, 한 요청에 4MB 까지 받습니다 (`cloud:push` 는 2MB, `--chunk-mb` 최대 3). 다른 요청은 64KB.
- 이미지 프록시는 `IMG_MAX_BYTES`(80MB)를 원본이 알려 준 길이로 먼저 보고, 길이가 없거나 압축된 응답은 흘리면서 세어 넘으면 끊습니다.
- `limits.cpu_ms` 300000 (요청·알람 하나의 CPU 시간). 수집 한 번의 출처 요청은 목록 2쪽 × 출처 수 + 미리 준비 몇 개로 1000 을 넘지 않습니다.
- 저장 값 하나 2MB 한도: 글은 한 행에 하나씩, 너무 큰 미리보기는 저장하지 않습니다 (`storage.js`).
- 로그인 시도 제한은 DO 저장소에 남아 DO 가 메모리에서 내려가도 풀리지 않습니다. 쿠키는 Secure·HttpOnly·SameSite=Strict, 관리자 POST 는 JSON 만.
- 없는 경로: `/api/events`(실시간 연결)·`/api/sync/*`·`/api/admin/publish` 는 클라우드에 없습니다(404). 화면은 `/api/meta` 의 `mode: "cloud"` 를 보고 주기적으로 확인합니다.

## 예전 공개 사이트(D1)에서 바뀐 것

- D1 스냅샷·업로드 API(`/api/sync/*`)는 쓰지 않습니다. `wrangler.jsonc` 에서 D1 바인딩을 뺐고, 바인딩이 남아 있어도 코드는 보지 않습니다.
  대시보드의 D1 데이터베이스 `simsimhae` 와 비밀 `PUBLISH_TOKEN` 은 새 사이트가 잘 도는 것을 본 뒤 지워도 됩니다.
- 내 컴퓨터 `.env` 의 `PUBLISH_URL`·`PUBLISH_TOKEN` 은 비워 두세요 (남아 있으면 로컬 서버가 없어진 업로드 API 로 올리려다 오류를 표시합니다).
- 예전 잠금 해제 쿠키는 형식이 달라 한 번 다시 비밀번호를 넣어야 합니다.
