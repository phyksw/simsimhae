# 공개 사이트 (Cloudflare Worker)

방문자용 **읽기 전용** 사이트입니다. 수집·판정·관리자는 내 컴퓨터(`npm start`)에 그대로 두고, 결과를 이 Worker 로 올립니다.
규약(업로드 API·방문자 API·D1 스키마)은 [`CONTRACT.md`](./CONTRACT.md) 에 있습니다.

| 파일 | 하는 일 |
|---|---|
| `index.js` | 진입점 (`wrangler.jsonc` 의 `main`) |
| `app.js` | 경로 나누기, 방문자 API(`/api/meta`·`/api/posts`·미리보기·잠금), 업로드 API(`/api/sync/*`) |
| `store.js` | D1 저장·읽기, isolate 메모리 캐시 (요청마다 버전만 확인) |
| `img.js` | 이미지/영상 프록시 (허용 호스트만, 리다이렉트 재확인, 앞부분으로 형식 판별 후 스트리밍) |
| `auth.js` | 상수 시간 비교, 잠금 쿠키 HMAC(WebCrypto), 시도 제한 |
| `http.js` | JSON 응답, 보안 헤더, 크기 제한 본문 읽기 |

## 로컬 시험

```bash
npm run worker:dev -- --port 8791 --var PUBLISH_TOKEN:아무거나길게 --var ADULT_PASSWORD:비번 --var SESSION_SECRET:아무거나길게
```

`--var` 대신 프로젝트 맨 위의 `.dev.vars` 파일(`PUBLISH_TOKEN=…` 줄들)을 씁니다 — `npm run worker:dev -- --port 8792` 만으로 됩니다. 이 파일과 `.wrangler/` 폴더는 `.gitignore` 에 들어 있어요.
로컬 D1 기록을 프로젝트 밖에 두려면 `--persist-to <폴더>` 를 붙입니다.

내 컴퓨터 서버와 이어서 보려면: 서버 환경변수(또는 `.env`)에 `PUBLISH_URL=http://127.0.0.1:8792`, `PUBLISH_TOKEN=<.dev.vars 와 같은 값>` 을 넣고 `npm start` 하면 시작하자마자 올리고,
http://127.0.0.1:8792 가 공개 사이트 화면입니다(`PUBLISH_READ_LIMIT=0` 이면 출처 사이트에 미리보기를 가지러 가지 않음).
D1 은 `wrangler.jsonc` 에 id 가 없어도 이 컴퓨터 안의 D1 으로 돕니다. 단위 테스트는 `npm test` (`test/worker.test.js`).

## 처음 배포

```bash
npx wrangler login
npm run worker:deploy                      # D1(simsimhae)은 이때 같은 이름의 것에 연결되거나 새로 만들어진다
npx wrangler secret put PUBLISH_TOKEN      # 로컬 .env 의 PUBLISH_TOKEN 과 같게 (길고 무작위로)
npx wrangler secret put ADULT_PASSWORD     # 로컬 data/secrets.json 의 adultPassword 와 같게
npx wrangler secret put SESSION_SECRET     # 쿠키 서명용 (길고 무작위로)
```

`wrangler.jsonc` 의 D1 에는 일부러 `database_id` 를 적지 않았습니다. 배포할 때 wrangler 가 이 Worker 에 붙은 D1 → 이름이 `simsimhae` 인 D1 순으로 찾고, 없으면 만듭니다.
직접 `npx wrangler d1 create simsimhae` 로 만들어 그 id 를 `database_id` 로 적어도 됩니다. 표는 첫 요청 때 Worker 가 스스로 만듭니다.
주소는 `https://simsimhae.<계정 하위 도메인>.workers.dev` 입니다. 비밀 `PUBLISH_TOKEN` 이 없으면 업로드는 503, `ADULT_PASSWORD`·`SESSION_SECRET` 이 없으면 잠금 해제가 503 입니다.

- **GitHub 에 연결해 자동 배포** (`phyksw/simsimhae`): Cloudflare 대시보드 → Workers & Pages → Create → Import a repository → 저장소 선택
  (이미 만든 Worker 라면 `simsimhae` → Settings → Builds → Connect). Worker 이름은 `simsimhae`, 빌드 명령 없음, 배포 명령 `npx wrangler deploy`, 루트 `/`.
  비밀 3개는 대시보드(Settings → Variables and Secrets, 종류 Secret)나 `wrangler secret put` 으로 넣습니다(배포해도 지워지지 않아요).
  첫 빌드에서 D1 을 만들 권한이 없다고 나오면 대시보드 Storage & Databases → D1 에서 `simsimhae` 를 만들고 다시 배포합니다(이름으로 찾아 연결).
- **하위 도메인 바꾸기** (`palebluedot13` → `board`): 대시보드 → Workers & Pages → 계정의 workers.dev 하위 도메인 "Change".
  계정 안의 모든 Worker 주소가 함께 바뀌고, 반영까지 시간이 걸릴 수 있습니다. `board` 를 이미 누가 쓰고 있으면 고를 수 없어요.
  바꾼 뒤에는 로컬 `.env` 의 `PUBLISH_URL` 을 `https://simsimhae.board.workers.dev` 로 바꾸고 서버를 다시 켭니다. 코드에는 주소가 들어 있지 않아 고칠 것이 없습니다.

## 무료 플랜에서 알아둘 것

- 화면 파일(`public/`)은 Worker 를 거치지 않고 바로 나갑니다(`run_worker_first: ["/api/*"]`, 요청 수 절약).
  그래서 화면 파일의 보안 헤더(CSP 등)는 `public/_headers` 가 붙입니다 (`/*` 아래에 로컬 서버와 같은 CSP·`Referrer-Policy: no-referrer`·`X-Content-Type-Options: nosniff`).
  CSP 를 바꿀 때는 `src/server.js`·`worker/http.js`·`public/_headers` 세 곳을 같이 바꿉니다(테스트가 셋이 같은지 확인). 이 파일은 설정으로만 쓰이고 주소로 내려가지 않습니다.
- `/api/img` 는 요청마다 Worker 호출 1회(하루 10만 회 한도)입니다. 브라우저는 하루 동안 캐시합니다. Worker 의 Cache API 저장은 workers.dev 주소에서는 효과가 없을 수 있고, 자기 도메인을 붙이면 동작합니다.
- 요청당 CPU 10ms: 글 5000개 기준 스냅샷 업로드는 약 10~15ms, 버전이 바뀐 뒤 isolate 의 첫 목록 요청은 약 5ms, 그 밖의 요청은 1ms 안팎입니다.
