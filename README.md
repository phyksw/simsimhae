# 호네키 쇼츠 장부

호네키 방송 다시보기를 구간별로 정리한 에피소드 장부입니다. 방송마다 몇 시쯤 어떤 이야기가 나오는지,
방송 전체에서 어디쯤인지(타임라인)를 보여 주고, 방문자가 마음에 드는 에피소드를 추천할 수 있습니다.

- 방송별 보기: 날짜순 방송 목록 → 펼치면 방송 타임라인과 에피소드 카드
- 추천 많은 순: 모든 에피소드를 추천 수로 정렬
- 낱말 찾기, 점수 있는 것만 보기

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
