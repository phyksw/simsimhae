// 퀘이사존 유머게시판 (https://quasarzone.com/bbs/qb_humor)
//
// ※ 현재 disabled: 공용 fetch(Node undici) 요청은 Cloudflare 가 매번 "403 + cf-mitigated: challenge" 로 막는다.
//   (브라우저 UA·정직한 봇 UA 모두 동일. 같은 시각 curl 은 200.) JS 챌린지를 풀거나 클라이언트 지문을 흉내 내는 건
//   규칙상 하지 않으므로 비활성으로 둔다. 파싱 로직은 curl 로 받은 실제 HTML 로 검증해 두었으니,
//   사이트가 막지 않는 정당한 수집 경로가 생기면 disabled 만 false 로 바꾸면 된다.
//
// - 목록: 인기글 필터(popularity=Y, 추천 10 이상 글만 모아 보여주는 게시판 자체 보기)를 쓴다.
//   기본 최신 목록은 하루 4~5개 정도로 느리고 추천 0~2짜리가 대부분이라, 이미 반응이 검증된 인기글이 쇼츠 소재로 낫다.
// - 서버 렌더링(Laravel Livewire) HTML 이라 목록/본문 모두 정적 HTML 에서 바로 읽힌다.
//   목록 행: .aio-v2 .v2-list > .v2-list-row (data-qc-id = 글 번호). 공지는 별도 .v2-notice-row 라 행 선택자에 안 걸린다.
//   블라인드/비공개 글은 제목 옆 .fa-lock 아이콘 → 건너뛴다.
// - 본문: #new_contents (= .v2-view-body .view-content .note-editor 안). 정확한 작성 시각은 JSON-LD DiscussionForumPosting.datePublished.
// - 이미지: img2.quasarzone.com (예전 글은 img2.quasarzone.co.kr). Referer 없이도 200 (Access-Control-Allow-Origin: *).
//   영상은 대부분 유튜브 iframe(//www.youtube.com/embed/...).
// - robots.txt: User-agent * 은 Allow: / (목록·글 경로 허용, 댓글 API 경로만 금지). 단 "User-agent: ClaudeBot / Disallow: /" 가 있음.
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://quasarzone.com';
const BOARD = 'qb_humor';
const LIST_URL = `${BASE}/bbs/${BOARD}`;

// 사이트에 후방/19 전용 말머리·아이콘이 없어서 작성자가 제목에 붙이는 표기만 잡는다.
const NSFW_RE = /후방|ㅎㅂ|ㅇㅎ|약후|므흣|19금|[[(]\s*19\s*[\])]|\bnsfw\b/i;

const postUrl = (id) => `${BASE}/bbs/${BOARD}/views/${id}`;

function postIdFromHref(href) {
  return new RegExp(`/bbs/${BOARD}/views/(\\d+)`).exec(href || '')?.[1] || null;
}

/** JSON-LD 에서 DiscussionForumPosting(본문 글) 노드를 찾는다 */
function findPosting($) {
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const j = JSON.parse($(el).html() || '');
      const nodes = Array.isArray(j) ? j : j['@graph'] || [j];
      found = nodes.find((n) => n && /Posting|Article/.test(String(n['@type']))) || null;
    } catch {
      /* 무시 */
    }
  });
  return found;
}

/** 목록 HTML → ListItem[] (네트워크 없이 시험할 수 있게 분리) */
export function parseList($, url) {
  // 공지 글 번호 (혹시 목록 행으로도 섞여 나올 때 거르기 위해)
  const noticeIds = new Set(
    $('.v2-notice-row a[href]')
      .map((_, a) => postIdFromHref($(a).attr('href')))
      .get()
      .filter(Boolean),
  );

  const items = [];
  const seen = new Set();
  $('.aio-v2 .v2-list .v2-list-row').each((_, row) => {
    const $row = $(row);
    const $a = $row.find('.tit a.subject-link').first();
    const href = absUrl($a.attr('href'), url);
    const postId = postIdFromHref(href);
    if (!postId || noticeIds.has(postId) || seen.has(postId)) return;
    // 블라인드/비공개(자물쇠), 공지/이벤트 배지 행 제외
    if ($row.find('.tit .fa-lock').length) return;
    if ($row.is('.is-notice, .v2-notice-row') || $row.find('.v2-list-row__badge, .v2-notice-badge').length) return;
    seen.add(postId);

    const title = cleanText($a.text()).replace(/\s*\[\d+\]\s*$/, '');
    if (!title) return;
    const category = cleanText($row.find('.v2-list-row__cate').first().text()) || null;
    const $thumb = $row.find('.v2-list-row__thumb img').first();
    const thumb = $thumb.attr('data-src') || $thumb.attr('data-original') || $thumb.attr('src');

    items.push({
      postId,
      title,
      url: postUrl(postId),
      author:
        cleanText($row.find('.user-nick-label').first().text()) ||
        cleanText($row.find('.user-nick-wrap').attr('data-nick')) ||
        null,
      postedAt: parseKoDate($row.find('.v2-list-row__time').first().text()),
      // 댓글 0 이면 꼬리표가 display:none 이지만 숫자 "0" 은 그대로 들어 있다
      commentCount: parseCount($row.find('.qc-count-comment').first().text()) ?? 0,
      views: parseCount($row.find('.qc-count-hit').first().text()), // "1.1천" / "1.1만" 표기
      likes: parseCount($row.find('.qc-count-good').first().text()),
      category,
      nsfwHint: NSFW_RE.test(title) || (category ? NSFW_RE.test(category) : false),
      thumbnail: thumb && !/^data:/.test(thumb) ? absUrl(thumb, url) : null,
    });
  });
  return items;
}

/** 글 HTML → Article (네트워크 없이 시험할 수 있게 분리) */
export function parseView($, url) {
  let $body = $('#new_contents').first();
  if (!$body.length) $body = $('.v2-view-body .view-content .note-editor').first();
  if (!$body.length) $body = $('.v2-view-body .view-content').first();

  // 본문 안의 스크립트·광고 조각 제거
  $body.find('script, style, noscript, ins.adsbygoogle, [id^="banner-"]').remove();
  normalizeMedia($, $body, url);

  const posting = findPosting($);
  const title =
    cleanText($('h1.v2-view-head__title').first().text()) ||
    cleanText(posting?.headline) ||
    cleanText($('meta[property="og:title"]').attr('content'));
  const author =
    cleanText($('.v2-view-head__nick .user-nick-label').first().text()) ||
    cleanText(posting?.author?.name) ||
    cleanText($('meta[name="author"]').attr('content')) ||
    null;
  const postedAt =
    parseKoDate(posting?.datePublished) || parseKoDate($('.v2-view-head__time').first().text()) || null;

  return {
    title,
    html: ($body.html() || '').trim(),
    author,
    postedAt,
    nsfwHint: NSFW_RE.test(title),
  };
}

export default {
  id: 'quasarzone',
  name: '퀘이사존 유머게시판',
  short: '퀘존',
  color: '#c2410c', // 퀘이사존 주황(#ff9900)을 흰 글씨가 읽히도록 어둡게
  homepage: `${LIST_URL}?popularity=Y`,
  domains: ['quasarzone.com'],
  imageHosts: ['quasarzone.com', 'quasarzone.co.kr'],
  referer: `${BASE}/`,
  strictness: 'normal',
  disabled: true,
  disabledReason:
    'Cloudflare 봇 챌린지: Node fetch 요청이 매번 403(cf-mitigated: challenge)으로 막힘. 챌린지 풀기/지문 위장은 하지 않음. 파싱 로직은 실제 HTML 로 검증 완료.',

  async list(page = 1) {
    const { $, url } = await fetchHtml(`${LIST_URL}?popularity=Y&page=${page}`, { referer: LIST_URL });
    return parseList($, url);
  },

  async read(pageUrl) {
    const { $, url } = await fetchHtml(pageUrl, { referer: LIST_URL });
    return parseView($, url);
  },
};
