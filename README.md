# 호네키 쇼츠 장부

호네키 방송 다시보기를 구간별로 정리한 에피소드 장부입니다. 방송마다 몇 시쯤 어떤 이야기가 나오는지,
방송 전체에서 어디쯤인지(타임라인)를 보여 주고, 방문자가 마음에 드는 에피소드를 추천할 수 있습니다.

- 방송별 보기: 날짜순 방송 목록 → 펼치면 방송 타임라인과 에피소드 카드
- 추천 많은 순: 모든 에피소드를 추천 수로 정렬
- 낱말 찾기, 주제 고르기, 점수 있는 것만 보기
- AI 쇼츠 추천 탭(주소 `#ai`): 재미·이해·완결 점수를 매긴 에피소드를 평균 점수대별로 묶어 보기

## 구성

| 경로 | 내용 |
|---|---|
| `public/` | 정적 화면(`index.html` · `app.js` · `style.css`)과 데이터(`data/episodes.json` · `data/ids.json`) |
| `worker/index.js` | Cloudflare Worker — 정적 화면 제공 + 추천 API |
| `wrangler.jsonc` | Worker 설정(Durable Object `VotesDO` 에 추천 수 저장) |

## 추천 API

- `GET /api/votes` → `{ counts: { 에피소드id: 수 }, mine: [내가 추천한 id] }`
- `POST /api/vote` (JSON `{ "id": "에피소드id", "on": true|false }`) → `{ n, mine }`

방문자는 IP 를 그대로 저장하지 않고, 저장소 안에서 처음 만든 무작위 값과 섞은 해시로만 구분합니다(같은 에피소드는 한 번만 추천,
1분에 30번까지).

## 배포

```bash
npm install
npx wrangler deploy
```

로컬 시험은 `npx wrangler dev`.

## 되돌리기

판마다 git 태그를 단다.

| 태그 | 내용 |
|---|---|
| `ledger-v1` | 첫 공개판 |
| `ledger-v2` | 문장 다듬기, 눌러서 자세히 보기 |
| `ledger-v3` | 검색 버튼, 큰 주제로 묶기 |
| `ledger-v4` | 구간마다 같은 글이 붙던 것 바로잡기, 주제 이름(경제·IT·세상 이야기 / 일본 유학), AI 쇼츠 추천 탭 |

```bash
# 저장소 내용을 원하는 판(예: ledger-v3)으로 되돌려 새 커밋으로 남기기
git checkout ledger-v3 -- .
git commit -m "ledger-v3 로 되돌리기"
npx wrangler deploy
```

배포만 바로 되돌릴 때는 Cloudflare 대시보드(Workers → simsimhae → Deployments)에서 이전 배포를 고르거나 `npx wrangler rollback`.
