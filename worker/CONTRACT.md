> **지금은 쓰지 않는 예전 구조입니다.** Workers Paid 로 바꾸면서 수집·관리자까지 Cloudflare 에서 돈다 ([`CLOUD.md`](./CLOUD.md), [`README.md`](./README.md)).
> Worker 는 더 이상 아래 업로드 API(`/api/sync/*`)와 D1 을 쓰지 않는다. 로컬 `src/publish.js` 만 이 규약을 그대로 말한다 (기록용).

# 공개 사이트(Cloudflare Worker) ↔ 내 컴퓨터(로컬 서버) 연동 규약

구성 (무료 플랜):

- **내 컴퓨터** (`src/server.js`, 지금 그대로): 15분마다 수집·판정, 관리자 기능 전부. 수집이 끝날 때마다 결과를 Worker 로 **올린다** (`src/publish.js`).
- **Cloudflare Worker** (`worker/`): 방문자용 **읽기 전용** 사이트. `public/` 화면을 그대로 정적 파일로 내보내고, 아래 API 만 제공한다.
  관리자 API·SSE·수집은 없다. 저장소는 D1 (`DB` 바인딩).
- 공개 주소: `https://simsimhae.<계정의 workers.dev 서브도메인>.workers.dev` (워커 이름 `simsimhae`).
  서브도메인을 `board` 로 바꾸면 `https://simsimhae.board.workers.dev`, 바꾸기 전에는 `https://simsimhae.palebluedot13.workers.dev`.
  주소는 코드에 들어가지 않는다 — 로컬 `.env` 의 `PUBLISH_URL` 만 맞추면 된다.

무료 플랜 제약: 요청당 CPU 10ms. 그래서 Worker 는 무거운 일을 하지 않는다 — 판정·게시판 소속·정렬 점수는 **로컬이 미리 계산해서** 올리고,
Worker 는 걸러서 자르기만 한다. 글 목록 전체는 D1 의 스냅샷 행(JSON, 크면 몇 행으로 나눔)으로 두고 isolate 메모리에 버전별로 캐시한다.

## 인증

- 업로드: `Authorization: Bearer <PUBLISH_TOKEN>` — Worker 비밀 `PUBLISH_TOKEN`, 로컬 `.env` 의 `PUBLISH_TOKEN` 이 같아야 한다. 틀리면 401.
- 므흣 잠금: Worker 비밀 `ADULT_PASSWORD`(로컬 `data/secrets.json` 의 adultPassword 와 같게), 쿠키 서명 비밀 `SESSION_SECRET`.
  쿠키 이름 `hg_adult`, 값 `adult:<만료ms>.<base64url HMAC-SHA256(SESSION_SECRET, "adult:<만료ms>")>`, HttpOnly; SameSite=Strict; Secure; Max-Age 12시간.

## 업로드 API (로컬 → Worker)

### `PUT /api/sync/snapshot` — 공개 글 전체 (매 수집 후, 관리자 변경 후)

```jsonc
{
  "version": "2026-10-17T03:00:00.000Z",   // 만든 시각 (같은 버전이면 Worker 는 무시해도 됨)
  "siteName": "심심풀이",
  "lastCrawlAt": "2026-10-17T02:59:40.000Z",
  "sources": [                              // 방문자에게 보일 출처 (로컬 /api/meta 의 sources 와 같은 기준)
    { "id": "dogdrip", "name": "개드립 인기글", "short": "개드립", "color": "#2b3a55", "homepage": "https://…",
      "active": true, "imageHosts": ["dogdrip.net"], "referer": "https://www.dogdrip.net/" }
  ],
  "posts": [                                // 공개(ok) 글 + 므흣(adult) 글. 걸러진 글·검수 대기 글은 넣지 않는다
    {
      "id": "dogdrip:729980448", "source": "dogdrip", "title": "…", "url": "https://…",
      "postedAt": "…|null", "firstSeenAt": "…", "commentCount": 42, "views": null, "likes": 108, "category": null,
      "status": "ok",                       // "ok" | "adult"
      "alsoOn": [{ "source": "humoruniv", "url": "https://…" }],
      "boards": ["story", "pick", "all", "dogdrip"],   // 이 글이 나오는 게시판 (로컬 boardPosts 와 정확히 같은 결과). 므흣 글은 ["adult"]
      "hot": 0.73,                          // 인기순 점수 (로컬이 계산, 클수록 위). 출처별·므흣 게시판 목록 안에서 센 값
      "hotIn": { "story": 0.81, "pick": 0.77, "all": 0.75 },  // 선택: 여러 출처가 섞이는 게시판별 인기순 점수 (그 게시판 목록 안에서 센 값).
                                            // 있으면 그 게시판에서는 이것을, 없으면 hot 을 쓴다. 이 글의 boards 에 없는 게시판 것은 버린다
      "hasRead": true                       // 미리보기 문서가 올라가 있는지 (없으면 화면이 원문 링크로 안내)
    }
  ]
}
```
응답: `{ "ok": true, "posts": <개수>, "pruned": <지운 미리보기 수>, "skipped": <형식이 틀려 건너뛴 글 수> }` (같은 버전을 다시 올리면 `"unchanged": true` 가 붙고 아무것도 쓰지 않는다).
Worker 는 스냅샷에 없는 글의 미리보기 문서를 지운다. 미리보기는 그 글이 들어갈 스냅샷보다 먼저 올라와도 된다.

### `PUT /api/sync/read/:id` — 글 하나의 미리보기 (id 는 encodeURIComponent)

```jsonc
{ "title": "…", "html": "<p>…</p>", "text": "…", "mediaCount": 3,
  "comments": [ /* reader.js cleanComments 결과 그대로 */ ], "commentTotal": 42, "updatedAt": "…" }
```
- `html` 은 로컬 `reader.js` 가 이미 sanitize 한 것이고, 이미지·영상 주소는 `/api/img?s=<출처>&u=<원본>` 상대 경로다 → Worker 의 이미지 프록시로 그대로 동작.
- 크기 상한 1.5MB. 응답 `{ "ok": true }`.

### `GET /api/sync/status` — 업로드 확인용 (Bearer 필요)
`{ "version", "posts", "reads", "updatedAt" }`

## 방문자 API (Worker)

로컬 서버의 같은 이름 API 와 **응답 형태가 같다** (`public/app.js` 를 고치지 않고 쓰도록). 차이점만 적는다.

- `GET /api/meta` → `{ siteName, mode: "public", admin: false, adult: <쿠키>, live: { live: true, lastCrawlAt }, boardCounts: { story, pick, all, adult(잠금 해제 시) }, pickCount, sources: [{ id, name, short, color, homepage, active, count }] }`
- `GET /api/posts?board=&sort=new|hot&page=&size=&q=` → `{ board, sort, page, size, total, hasMore, items }`
  - board: `story` | `pick` | `all` | `<출처 id>` | `adult`(잠금 해제 필요, 아니면 403 `{error:"locked"}`). 그 밖(`filtered`, `shorts`)은 401.
  - sort: `new` = postedAt||firstSeenAt 내림차순, `hot` = 그 게시판 점수(hotIn[board], 없으면 hot) 내림차순, 같으면 최신순 (로컬 인기순과 같은 순서). 다른 값은 new.
  - q: 제목 부분 일치(소문자). size 5~100 (기본 30).
  - items: 스냅샷의 글에서 `boards`·`hot`·`hotIn`·`hasRead` 를 뺀 것 (규약의 필드만).
- `GET /api/posts/:id/read` → `{ post, title, html, text, mediaCount, comments, commentTotal, statusChanged: false }`
  - 므흣 글은 잠금 해제 필요(403 `{error:"locked"}`). 스냅샷에 없으면 404. 미리보기 문서가 없으면 404 `{ error: "미리보기를 준비 중이에요", url }`.
- `POST /api/unlock` `{password}` (JSON 만) → 쿠키 설정, `POST /api/lock` → 쿠키 삭제.
- `GET /api/img?s=&u=` → 로컬 서버와 같은 규칙: 스냅샷 sources 의 imageHosts 에 있는 호스트만, 리다이렉트는 직접 따라가며 매번 확인(최대 3번),
  앞부분 바이트로 이미지/영상 형식 판별(SVG·HTML 거부), Range 통과, `Cache-Control: public, max-age=86400`, `Content-Security-Policy: default-src 'none'; sandbox`.
  Worker 는 Cache API 로 이미지 응답을 캐시해도 된다.
- `GET /api/events` → 404 (공개 사이트엔 실시간 연결 없음. 화면은 `mode: "public"` 이면 2분마다 /api/meta 를 다시 불러 새 글을 알린다)
- 그 밖의 `/api/*` → 404 JSON. 나머지 경로는 정적 파일(`public/`).
- 모든 응답에 로컬 서버와 같은 보안 헤더(CSP, Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff).
  `/api/*` 는 Worker 가 붙이고, Worker 를 거치지 않는 화면 파일은 `public/_headers` 가 붙인다.

## D1 스키마

```sql
CREATE TABLE IF NOT EXISTS snapshot (k TEXT PRIMARY KEY, version TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
```
- 스냅샷 머리는 `k = 'main'` 한 행, 글 목록은 같은 version 의 `k = 'posts/<n>'` 행들(D1 한 행 2MB 상한 때문에 나눔). 모두 한 batch 로 바뀐다.
  Worker 는 요청마다 `k='main'` 의 version 만 확인하고, 버전이 바뀌었을 때만 다시 읽어 isolate 메모리에 캐시.
