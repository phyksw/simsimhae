// 개드립(dogdrip.net) 개드립 게시판 — 인기글 정렬(/dogdrip?sort_index=popular).
// 인기글 목록은 추천이 일정 수 이상 모인 글만 최신순으로 보여주므로(페이지당 20개) 쇼츠 소재 고르기에 알맞다.
// Rhymix(XE) + eden 스킨. 기본 목록은 웹진형(ul.ed.list > li), 테이블형(table.ed.table)도 대비해 둔다.
// robots.txt 의 `User-agent: *` 그룹에 `Crawl-delay: 10` 이 있어 이 사이트 요청은 10초 간격으로 보낸다.
//
// 댓글: AJAX 없이 글 페이지 HTML(#commentbox .comment-list > .comment-item) 안에 들어 있다. 한 페이지에 50개씩이고
// 쪽 번호 없이 열면 "마지막" 댓글 페이지(가장 늦게 달린 몇 개)를 보여주므로, 글을 처음부터 ?cpage=1 로 연다(본문은 같음).
// 댓글이 50개를 넘으면 ?cpage=2 를 한 번 더 받아 최대 100개까지 사이트 순서대로 담는다(대댓글은 부모 바로 뒤, class "depth").
// cpage 는 robots.txt 금지 경로가 아니다. 베스트/인기 댓글 기능은 없다(표시도 없음). 비추천 수는 공개하지 않는다.
// 본문 이미지는 지연로딩·축소판 없이 원본 주소(/dvs/…)가 바로 들어 있고, 에디터가 넣은 width/height 는 실제 크기와 같다
// (Cloudflare Polish 가 Accept 에 따라 WebP 로 주지만 가로x세로는 원본과 같음). 움짤은 <video src=mp4 poster=jpg>.
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.dogdrip.net';
const BOARD = 'dogdrip';
const CRAWL_DELAY_MS = 10_000; // robots.txt Crawl-delay: 10
const MAX_COMMENTS = 100;
const DELETED_RE = /^[[(]?\s*(?:(?:관리자|작성자|운영자)에 의해\s*)?(?:삭제|블라인드\s*처리)\s*(?:된|되었습니다|됨)?\s*댓글(?:입니다)?\.?\s*[\])]?$|^비밀\s*댓글(?:입니다)?\.?$/;

// 개드립은 성인물 자체를 금지하지만 이용자가 제목에 "ㅇㅎ)" "약후" "후방" 등을 붙여 올리는 관행이 있다.
// 말머리·아이콘·클래스 같은 구조적 표시는 없어서 제목 표기만 본다. 실제 제목에서 확인한 형태:
//   "ㅇㅎ) …", "ㅇㅇㅎ) …", "후방주의) …", "(극후방) …", "후방?) …", "약후방)…", "씹덕, 극후방, 이상성욕) …"
// 오탐 제외: "세후"(세금 후), "예약후/계약후", "약후기", "전후방/최후방", "후방 감지 센서/후방 깜빡이/후방 경계/후방추돌" 같은
// 일반 낱말로서의 '후방', 기사식 나이 표기 "A씨(19)".
const NSFW_PATTERNS = [
  /ㅇㅎ|ㅎㅂ|ㅗㅜㅑ|19금|🔞|nsfw/i,
  /(?<![가-힣])약후(?!기)/, // "약후)" "(약후)" "약후방" — "예약후" "계약후" 제외
  /(?<![전최])후방(?=\s*(?:주의|ㅈㅇ|[)\]}>,.!?~:;/|]|$))/, // "후방주의" "후방)" "…후방" (뒤에 일반 낱말이 오면 제외)
  /[(\[{]\s*(?:극|약|초|살짝)?\s*후방/, // "(후방 …" "[극후방"
  /^\s*(?:극|약)?후방\s+(?!(?:추돌|충돌|카메라|감지|센서|주차|깜빡이|경계|지원|부대|기지|산업|십자|인대))/, // 제목 맨 앞 "후방 …"
  /(?<![가-힣A-Za-z0-9])[(\[]\s*19\s*[)\]]/, // "(19)" "[19]" — "A씨(19)" 같은 나이 표기 제외
  /^\s*19\s*[)\]]/, // "19) …"
];
const isNsfwTitle = (title) => NSFW_PATTERNS.some((re) => re.test(title || ''));

const postUrl = (id) => `${BASE}/${id}`;

function postIdFrom($a) {
  const srl = $a.attr('data-document-srl');
  if (srl && /^\d+$/.test(srl)) return srl;
  const href = $a.attr('href') || '';
  return /(?:^|\/|document_srl=)(\d{5,})(?:[/?#&]|$)/.exec(href.replace(/^https?:\/\/[^/]+/, ''))?.[1] || null;
}

// 웹진형 목록 (기본)
function parseWebzine($, pageUrl) {
  const items = [];
  $('ul.ed.list > li').each((_, li) => {
    const $li = $(li);
    if ($li.hasClass('notice') || $li.find('.badge-notice').length) return; // 공지
    if ($li.find('#npl-list, .badge-ad-sm-v2').length) return; // 광고 슬롯
    const $a = $li.find('a.title-link').first();
    const postId = postIdFrom($a);
    if (!postId) return;
    const title = cleanText($a.text());
    if (!title) return;
    const $meta = $li.find('.list-meta').first();
    const thumb = $li.find('img.webzine-thumbnail').first();
    items.push({
      postId,
      title,
      url: postUrl(postId),
      author: cleanText($meta.find('a[class*="member_"]').first().text()) || null,
      postedAt: parseKoDate(cleanText($meta.find('.fa-clock').first().parent().text())),
      commentCount: parseCount($a.closest('h5').find('span.text-primary').first().text()) ?? 0,
      views: null, // 목록·본문 어디에도 조회수를 표시하지 않음
      likes: parseCount($meta.find('.fa-thumbs-up').first().parent().next('span').text()),
      category: null,
      nsfwHint: isNsfwTitle(title),
      thumbnail: absUrl(thumb.attr('src') || thumb.attr('data-list-thumbnail-original'), pageUrl),
    });
  });
  return items;
}

// 테이블형 목록 (list_type=table 이 세션에 남아 있을 때 대비)
function parseTable($) {
  const items = [];
  $('table.ed.table tbody tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.hasClass('notice') || $tr.find('#npl-list, .badge-ad-sm-v2, .badge-notice').length) return;
    const $a = $tr.find('td.title a[data-document-srl]').first();
    const postId = postIdFrom($a);
    if (!postId) return;
    const title = cleanText($a.find('.title-link').first().text() || $a.text());
    if (!title) return;
    items.push({
      postId,
      title,
      url: postUrl(postId),
      author: cleanText($tr.find('td.author a[class*="member_"]').first().text()) || null,
      postedAt: parseKoDate(cleanText($tr.find('td.time').text())),
      commentCount: parseCount($a.find('span.text-primary').first().text()) ?? 0,
      views: null,
      likes: parseCount($tr.find('td.voteNum').text()),
      category: null,
      nsfwHint: isNsfwTitle(title),
      thumbnail: null,
    });
  });
  return items;
}

// 같은 글 주소에 댓글 쪽 번호만 붙인다 (#comment 같은 조각은 버림)
function withCpage(url, n) {
  const u = new URL(url);
  u.hash = '';
  u.searchParams.set('cpage', String(n));
  return u.toString();
}

// 댓글 본문 → 순수 텍스트 (문단·<br> 은 줄바꿈으로, 디시콘 같은 이미지는 빼고)
function commentText($, $x) {
  const $c = $x.clone();
  $c.find('img, video, iframe, script, style').remove();
  // 소스 HTML 의 줄바꿈("</p>\n<p>")은 화면에 안 보이는 공백이므로 먼저 공백으로 바꾼다
  $c.find('*')
    .addBack()
    .contents()
    .each((_, n) => {
      if (n.type === 'text') n.data = n.data.replace(/[\r\n\t]+/g, ' ');
    });
  $c.find('br').replaceWith('\n');
  $c.find('p, div, li, blockquote, h1, h2, h3, h4, h5, h6').each((_, el) => {
    $(el).append('\n');
  });
  return $c
    .text()
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 한 댓글 페이지의 댓글들 (사이트 순서). seen 으로 페이지 사이 중복(쪽 경계에서 밀린 댓글)을 거른다.
function parseComments($, pageUrl, seen) {
  const out = [];
  let $items = $('#commentbox .comment-list .comment-item');
  if (!$items.length) $items = $('.comment-list .comment-item');
  $items.each((_, el) => {
    const $c = $(el);
    const id = $c.attr('id') || null;
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    const $x = $c.find('.xe_content').first();
    if (!$x.length) return; // 삭제·비밀 댓글 자리표시
    const text = commentText($, $x);
    const images = [];
    $x.find('img').each((_, im) => {
      const $im = $(im);
      const s = absUrl($im.attr('data-src') || $im.attr('src'), pageUrl);
      if (s && /^https?:/.test(s) && !images.includes(s)) images.push(s);
    });
    if (!text && !images.length) return;
    if (!images.length && DELETED_RE.test(text)) return;
    const $bar = $c.find('.comment-bar').first();
    const author =
      cleanText($bar.find('h6 a[class*="member_"]').first().text()) || cleanText($bar.find('h6').first().text()) || null;
    const $act = $c.find('.action').first();
    const count = (icon) => {
      const $n = $act.find(`i.fa-${icon}`).first().parent().find('.count').first();
      return $n.length ? parseCount($n.text()) : null;
    };
    out.push({
      author,
      text,
      likes: count('thumbs-up'),
      dislikes: count('thumbs-down'), // 개드립은 비추천 수를 표시하지 않음 → 보통 null
      best: false,
      reply: /(^|\s)depth\d*(\s|$)/.test($c.attr('class') || ''),
      postedAt: parseKoDate(cleanText($bar.find('.flex-right span').first().text())),
      images,
    });
  });
  return out;
}

// 댓글 쪽 번호 목록에서 마지막 쪽 번호 (쪽 나눔이 없으면 1)
function commentPageCount($) {
  let max = 1;
  $('#commentbox .pagination li').each((_, li) => {
    const n = Number(cleanText($(li).text()));
    if (Number.isInteger(n) && n > max) max = n;
  });
  return max;
}

export default {
  id: 'dogdrip',
  name: '개드립 인기글',
  short: '개드립',
  color: '#2e4361', // 사이트 theme-color
  homepage: `${BASE}/${BOARD}?sort_index=popular`,
  domains: ['dogdrip.net'],
  // 본문 이미지는 www.dogdrip.net/dvs/…, 움짤·mp4·썸네일은 rc.dogdrip.net
  imageHosts: ['dogdrip.net'],
  // Referer 없음/개드립 Referer 는 200, 외부 Referer 는 403 → 개드립 Referer 를 붙인다
  referer: `${BASE}/`,
  strictness: 'strict', // 정치·시사·젠더 글이 인기글에 자주 섞임
  crawlDelayMs: CRAWL_DELAY_MS, // 같은 사이트 요청 간격 (PC 판정 루틴이 그림을 직접 받을 때도 지킨다)
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const qs = new URLSearchParams({ sort_index: 'popular' });
    if (page > 1) qs.set('page', String(page));
    const { $, url } = await fetchHtml(`${BASE}/${BOARD}?${qs}`, { interval: CRAWL_DELAY_MS });
    let items = parseWebzine($, url);
    if (!items.length) items = parseTable($);
    const seen = new Set();
    return items.filter((it) => !seen.has(it.postId) && seen.add(it.postId));
  },

  async read(url) {
    // 쪽 번호 없이 열면 마지막 댓글 페이지가 나오므로 첫 댓글 페이지로 연다 (본문은 똑같이 들어 있음)
    const res = await fetchHtml(withCpage(url, 1), { interval: CRAWL_DELAY_MS });
    const { $ } = res;

    // 댓글은 본문 정리(요소 제거) 전에 읽어 둔다
    const seen = new Set();
    let comments = parseComments($, res.url, seen);
    const commentTotal = parseCount($('#commentbox .comment-header').first().text());
    if (commentPageCount($) >= 2 && comments.length < MAX_COMMENTS) {
      try {
        const r2 = await fetchHtml(withCpage(res.url, 2), { interval: CRAWL_DELAY_MS, referer: res.url });
        comments = comments.concat(parseComments(r2.$, r2.url, seen));
      } catch {
        // 두 번째 댓글 페이지는 없어도 된다
      }
    }
    comments = comments.slice(0, MAX_COMMENTS);
    const $wrap = $('.article-wrapper').has('.article-head').first();
    const $scope = $wrap.length ? $wrap : $('body');
    const $body = $scope
      .find('.rhymix_content.xe_content, .xe_content')
      .filter((_, el) => /(^|\s)document_\d+_\d+/.test($(el).attr('class') || ''))
      .first();

    $body.find('script, style, noscript, ins, .ddnad, .ddnad-wrapper, [data-oad-unit]').remove();
    // 에디터가 남긴 내부용 속성 정리
    $body.find('[data-ll-status]').removeAttr('data-ll-status');
    normalizeMedia($, $body, res.url);
    $body.find('video').each((_, v) => {
      const $v = $(v);
      if (!$v.attr('src')) {
        const s = $v.find('source[src]').first().attr('src');
        if (s) $v.attr('src', s);
      }
      $v.attr('controls', '');
      $v.attr('playsinline', '');
      $v.attr('preload', 'metadata');
    });

    const $head = $scope.find('.article-head').first();
    let title = cleanText($head.find('h4').first().text());
    if (!title) title = cleanText(($('meta[property="og:title"]').attr('content') || '').replace(/\s*-\s*DogDrip\.Net.*$/i, ''));
    const author = cleanText($head.find('.title-toolbar a[class*="member_"]').first().text()) || null;
    // "1 시간 전" / "3 일 전" 같은 상대 시간만 표시됨 (절대 날짜 메타 없음)
    const dateText = cleanText($head.find('.title-toolbar .fa-clock').first().closest('span').next('span').text());

    return {
      title,
      html: $body.html() || '',
      author,
      postedAt: parseKoDate(dateText),
      nsfwHint: isNsfwTitle(title),
      comments,
      commentTotal, // "N개의 댓글" 머리글 (없으면 null → 목록의 댓글 수를 씀)
    };
  },
};
