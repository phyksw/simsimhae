# 클라우드 전체 이전 설계 (Cloudflare Workers Paid)

사용자가 Workers Paid 로 바꿨다. 이제 **수집·필터링·관리자까지 전부 Cloudflare 에서** 돌고, 사용자 PC 는 꺼져 있어도 된다.
지금의 "PC 가 수집해서 올리기" 구조(worker/CONTRACT.md, src/publish.js)는 이 이전이 끝나면 쓰지 않는다.

## 구성

```
브라우저 ──> Worker (worker/index.js)
              ├─ 정적 화면: ASSETS (public/)
              ├─ /api/img : 이미지 프록시 (상태 없음, Worker 에서 바로) — 출처별 imageHosts·referer 는 src/sources 어댑터에서 직접
              └─ 그 밖의 /api/* ──> Durable Object "SiteDO" (이름 'main' 하나)
                                     = 지금의 src/server.js 한 프로세스와 같은 역할
                                     ├─ 상태: 메모리(src/store.js) + DO SQLite 저장소에 영속
                                     ├─ 알람: 실시간 ON 이면 intervalMin 마다 crawlAll() (수집 → 키워드 판정 → [API 키 있으면 Claude] → 점수·묶음)
                                     ├─ 미리보기: 열 때 원문에서 가져와 sanitize, DO 저장소에 캐시 (+ 알람 때 소소한 이야기·웃긴 것만 일부 미리 준비)
                                     └─ API: src/server.js 와 같은 경로·같은 응답 모양 (관리자 포함)
Cron (*/5) ──> Worker scheduled() ──> SiteDO 알람이 살아 있는지 확인(없으면 다시 건다)
```

## 원칙

1. **같은 코드를 두 곳에서**: src/ 의 모듈(sources/*, lib/*, filter*, crawler, reader, boards, ai, store)은 로컬(npm start)과 Workers 양쪽에서 돈다.
   - 모듈 최상위에서 `node:fs`·`path`·`process.cwd` 같은 파일 시스템 접근을 하지 않는다. 파일이 필요한 곳(로컬 저장, 비밀 파일, 관리자 금지어 파일)은
     **저장소 백엔드**로 바꾼다: `store.setBackend({ load(), saveAll(db), savePosts(ids), saveKv(k, v), loadKv(k) ... })` 같은 형태.
     로컬 백엔드 = 지금처럼 data/*.json, 클라우드 백엔드 = DO `ctx.storage.sql`.
   - `src/sources/index.js` 는 폴더를 읽지 않고 정적 import 목록(registry)으로 바꾼다 (새 소스는 목록에 한 줄 추가).
   - 설정(config)은 `process.env` 에서 읽되 Workers 에서는 env 바인딩을 주입한다 (`configure(env)` 등). 비밀은 Worker 비밀로:
     `ADMIN_PASSWORD`, `ADULT_PASSWORD`, `SESSION_SECRET`, (선택) `ANTHROPIC_API_KEY`, `AI_MODEL`.
2. **응답 모양은 로컬 서버와 같다** → public/app.js 는 `meta.mode === 'cloud'` 일 때만 조금 다르게 동작:
   관리자 버튼 보임(로그인), SSE 대신 주기적 /api/meta 확인(관리자 30초, 방문자 2분), 공개 사이트 업로드 표시 없음.
3. **SSE 는 없다** (`/api/events` → 404). `/api/sync/*`, `/api/admin/publish` 도 클라우드에는 없다.
4. **한도**: wrangler.jsonc 에 `limits.cpu_ms` (최대 300000), cron `*/5 * * * *`, DO 는 SQLite 저장소(`new_sqlite_classes` 마이그레이션).
   수집 한 번의 하위 요청 수(목록 2쪽 × 11곳 + 미리보기·댓글)는 1000 이하로. 같은 사이트 요청 간격(lib/http.js throttle)은 그대로 지킨다.
   DO 메모리 128MB, 저장 값 하나 2MB 이하 — 글은 행 하나에 하나씩.
5. **보안**: 관리자 화면이 인터넷에 열린다. 로그인 시도 제한, 쿠키 Secure·HttpOnly·SameSite=Strict, 비밀번호 바꾸면 쿠키 무효(지금 로직 유지),
   관리자 POST 는 JSON 만(CSRF). 로그·오류 응답에 비밀이 나오지 않게.
6. **옮기기**: 관리자 전용 `POST /api/admin/import` — 로컬 data/posts.json(글·출처 상태·설정) + data/custom-rules.json 을 받아 DO 상태를 통째로 바꾼다.
   `scripts/push-to-cloud.js <url>` 이 로컬 파일을 읽어 관리자 비밀번호(x-admin-key 대신 로그인 쿠키나 Authorization 헤더)로 올린다. 크면 나눠서.
7. 로컬 실행(npm start)과 기존 테스트는 계속 동작해야 한다.
