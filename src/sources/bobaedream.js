// 보배드림 — "베스트글" 게시판을 원 게시판 "신유머/이슈/움짤"(code=humor)로 거른 목록.
//
// 왜 이 목록인가:
//  - code=strange("유머게시판")는 이름만 유머일 뿐 최신글·추천순 모두 정치/시사 글이 대부분이라 쇼츠 소재로 부적합.
//  - code=humor("신유머/이슈") 원 게시판은 썰·대화 캡처·짤 위주지만 추천 0~2짜리 글이 섞여 있음.
//  - 베스트글(code=best)에 bestbbs=humor 필터를 걸면 신유머 게시판에서 추천을 받아 베스트로 올라간 글만
//    최신순(하루 수십 개, 2026-10-16 하루치만 2페이지 60개 이상)으로 나온다 → 반응이 검증된 썰/캡처류가 많고
//    page 1 이 매일 갱신된다.
//    (필터 없는 베스트글 전체는 정치게시판 글이 많이 섞이므로 쓰지 않는다.)
// 목록의 글 주소는 베스트 사본(view?code=best&No=...)이며, 본문 템플릿은 원 게시판 글과 같다.
// robots.txt: "User-agent: * / Allow: /" (Amazonbot 만 Disallow) — 2026-10-17 확인.
// 이미지: file*.bobaedream.co.kr 은 Referer 없음/보배드림 Referer 는 200, 다른 사이트 Referer 는 403.

// 댓글 (2026-10-17 조사):
//  - 글 페이지 HTML 안(#cmt_list)에 원 게시판 글의 댓글이 "등록순 100개씩" 첫 페이지로 이미 들어 있다
//    (베스트 사본 view?code=best 에서도 원글 code=humor 의 댓글 테이블을 그대로 보여 줌).
//    → 추가 요청 없이 본문 HTML 에서 읽는다. 다른 정렬·다음 페이지는 /board_renew/bulletin/comment_list.php
//      (jQuery .load, GET) 로 오지만 최대 100개라 첫 페이지면 충분해서 쓰지 않는다 (robots.txt 는 전체 Allow).
//  - 베스트 댓글: ul#best_cmt_reply > li.best01~03 (dd#bepl_small_cmt_<번호>), 같은 댓글이 일반 목록에도
//    dd#small_cmt_<번호> 로 다시 나오므로 번호로 중복 제거. 그 사본 뒤에 붙어 있던 답글(li.re)은 베스트 댓글 바로 뒤로 옮긴다.
//  - 삭제된 댓글은 일반 목록에 `<li style="color:gray">&nbsp;삭제된 댓글입니다.</li>` (본문 dd 없음) 로 나와 건너뛴다.
//  - 일반 목록: ul#cmt_reply > li (대댓글은 li.re). 글쓴이 .author, 날짜 .date("26.10.16 18:03"),
//    추천/반대는 .updownbox 의 "추천 N"/"반대 N", 전체 개수는 .commentlistbox .comm2 "(48)".
//  - 사이트 버그: 줄바꿈 앞의 @멘션이 `<span style="color:blue;">@닉<br</span> />` 처럼 깨져 나온다 → 원문에서 고친 뒤 파싱.
//  - 댓글 이미지는 act_cmt_img() 가 #small_img_<번호>(축소판)/#big_img_<번호>(큰 그림)를 바꿔 보여 주는 구조
//    (이 게시판에서는 이미지 첨부 체크박스가 숨겨져 있어 실제 예시는 못 찾음) → 큰 그림 우선으로 모은다.

import * as cheerio from 'cheerio';
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.bobaedream.co.kr';
const BEST_FROM = 'humor'; // 베스트글을 어느 원 게시판으로 거를지 (humor = 신유머/이슈/움짤)

// 사이트가 후방/19 로 표시하는 제목 표기 — 실제 예: "(후방) ...", "후방 ㅡ ...", "(후방 주의)", "[혐오 엽기 후방주의]".
// 보배드림은 자동차 커뮤니티라 "후방카메라/후방추돌/후방 깜빡이/후방 백미러" 같은 말은 제외.
const NSFW_RE =
  /후방(?!\s*(?:카메라|캠|추돌|센서|감지|충돌|주차|블박|블랙박스|램프|등(?!산)|범퍼|시야|경고|안전|모니터|깜빡이|깜박이|백미러|사이드|미러|라이트|브레이크|차량|차로|차선|차|트렁크|와이퍼|유리|타이어|바퀴|레이더|보조|지원|부대|지역|기지|보급|지휘|병참|에서|으로))|ㅎㅂ|ㅇㅎ|약후|므흣|ㅗㅜㅑ|야짤|19금|[[(【]\s*19\s*[\])】]|^\s*19\s*[)\]】]/;
// 목록 행 안의 아이콘/말머리로 공지·광고·이벤트를 알아본다.
const NOTICE_RE = /공지|이벤트|광고|AD\b/i;

const isNsfw = (...texts) => texts.some((t) => t && NSFW_RE.test(t));

/** 목록 HTML 원문에서 글 번호 → 제목 title 속성(잘리지 않은 제목) 을 뽑는다.
 *  사이트가 title 속성 안의 큰따옴표를 이스케이프하지 않아 cheerio 로는 깨지므로 원문에서 직접 읽는다. */
function rawTitles(text, $) {
  const map = new Map();
  const re = /class="bsubject"[^>]*?href="[^"]*?[?&]No=(\d+)[^"]*"\s+title="([\s\S]*?)"\s+itemprop="name"/g;
  let m;
  while ((m = re.exec(text))) {
    const decoded = cleanText($('<i></i>').html(m[2]).text());
    if (decoded) map.set(m[1], decoded);
  }
  return map;
}

/** "조회 17,992 | 추천 221 | 2026.10.16 (금) 17:43" → ISO */
function parseViewDate(s) {
  const m = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?\s*(?:\([^)]*\))?\s*(\d{1,2}:\d{2}(?::\d{2})?)?/.exec(cleanText(s));
  if (!m) return null;
  return parseKoDate(`${m[1]}.${m[2]}.${m[3]}${m[4] ? ` ${m[4]}` : ''}`);
}

const MAX_COMMENTS = 100;
// "삭제된 댓글입니다." / "관리자에 의해 삭제된 댓글입니다" / "신고 누적으로 블라인드 처리된 댓글입니다" 같은 자리표시 댓글
const DELETED_RE =
  /^[[(]?\s*(?:(?:작성자|관리자|운영자)(?:에 의해|가)\s*|신고\s*누적(?:으로)?\s*)?(?:삭제|블라인드)\s*(?:처리)?\s*(?:된|되었습니다|됨)\s*(?:댓글|코멘트|글)?\s*(?:입니다)?\.?\s*[\])]?$/;

/** 댓글 본문 요소 → 순수 텍스트 (br → 줄바꿈, 줄마다 공백 정리) */
function commentText($, $dd) {
  const $c = $dd.clone();
  $c.find('script, style, img, [id^="small_img_"], [id^="big_img_"]').remove();
  let out = '';
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') out += n.data.replace(/\s+/g, ' ');
      else if (n.type === 'tag') {
        if (n.name === 'br') out += '\n';
        else {
          const block = /^(p|div|li)$/.test(n.name);
          if (block && out && !out.endsWith('\n')) out += '\n';
          walk(n.children || []);
          if (block && !out.endsWith('\n')) out += '\n';
        }
      }
    }
  };
  walk($c.contents().get());
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t ​]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 댓글 li 하나 → Comment (본문 dd 를 못 찾거나 삭제된 댓글이면 null) */
function parseComment($, li, { best = false, baseUrl }) {
  const $li = $(li);
  const $dd = $li.find(best ? 'dd[id^="bepl_small_cmt_"]' : 'dd[id^="small_cmt_"]').first();
  if (!$dd.length) return null;
  const id = /(\d+)$/.exec($dd.attr('id') || '')?.[1] || null;
  const text = commentText($, $dd);

  // 댓글 첨부 그림: 큰 그림(#big_img_) 우선, 없으면 축소판/본문 안 img. 레벨 아이콘(img.level)은 제외.
  const images = [];
  const $big = $li.find('[id^="big_img_"] img');
  const $imgs = $big.length ? $big : $li.find('dd img, [id^="small_img_"] img').not('.level');
  $imgs.each((_, el) => {
    const $el = $(el);
    const u = absUrl($el.attr('data-original') || $el.attr('data-src') || $el.attr('src'), baseUrl);
    if (u && !/\/(level|renew\/images|images\/common)\//.test(u) && !images.includes(u)) images.push(u);
  });

  if (!text && !images.length) return null;
  if (DELETED_RE.test(text) && !images.length) return null;

  const updown = $li.find('.updownbox').first().text();
  const likes = /추천\s*([\d,]+)/.exec(updown)?.[1];
  const dislikes = /반대\s*([\d,]+)/.exec(updown)?.[1];
  const $author = $li.find('dt .author').first();
  return {
    id,
    comment: {
      author: cleanText($author.text()) || null,
      text,
      likes: likes != null ? parseCount(likes) : null,
      dislikes: dislikes != null ? parseCount(dislikes) : null,
      best,
      reply: !best && $li.hasClass('re'),
      postedAt: parseKoDate($li.find('dt .date').first().text()),
      images,
    },
  };
}

/** 글 페이지 HTML 원문에서 댓글 목록(베스트 먼저) + 전체 댓글 수 */
function parseComments(rawHtml, $page, baseUrl) {
  const start = rawHtml.indexOf('id="cmt_list"');
  if (start < 0 && !$page('#cmt_list').length) return { comments: [], commentTotal: null };
  // 깨진 멘션 태그 `@닉<br</span> />` → `@닉</span><br />` (그대로 파싱하면 "<br<" 요소가 생기고 " />" 가 글자로 남는다)
  const $ = /<br<\/span>/i.test(rawHtml) ? cheerio.load(rawHtml.replace(/<br<\/span>\s*\/?>/gi, '</span><br />')) : $page;
  const $list = $('#cmt_list').first();

  const totalText = cleanText($list.find('.commentlistbox .comm2').first().text());
  // 베스트 댓글은 맨 앞(best:true)에 두고, 일반 목록에 다시 나오는 같은 댓글(사본)은 뺀다.
  // 일반 목록에서 답글(li.re)은 원댓글 바로 뒤에 붙어 나오므로, 원댓글이 베스트라서 빠지면 그 답글들이 화면(app.js)에서
  // 바로 앞의 엉뚱한 댓글에 달린 것처럼 보인다 (실측: 1040312 답글 16개 중 12개, 1040430 21개 중 16개).
  // → 베스트로 올라간 원댓글의 답글은 그 베스트 댓글 바로 뒤로 옮긴다 (답글끼리는 사이트 순서 유지).
  const bests = [];
  const bestById = new Map();
  $list.find('#best_cmt_reply > li').each((_, li) => {
    const r = parseComment($, li, { best: true, baseUrl });
    if (!r || (r.id && bestById.has(r.id))) return;
    const b = { comment: r.comment, replies: [] };
    if (r.id) bestById.set(r.id, b);
    bests.push(b);
  });
  const regular = [];
  const seen = new Set(bestById.keys());
  let parentBest = null; // 지금 이어지는 답글들의 원댓글이 베스트로 옮겨졌으면 그 베스트
  $list.find('#cmt_reply > li').each((_, li) => {
    const $li = $(li);
    const isReply = $li.hasClass('re');
    const r = parseComment($, li, { baseUrl });
    if (!isReply) {
      // 삭제 자리표시(<li style="color:gray">삭제된 댓글입니다.</li>, 본문 dd 없음)도 새 원댓글로 친다
      const id = r?.id ?? /(\d+)$/.exec($li.find('dd[id^="small_cmt_"]').first().attr('id') || '')?.[1];
      parentBest = (id && bestById.get(id)) || null;
    }
    if (!r || (r.id && seen.has(r.id))) return;
    if (r.id) seen.add(r.id);
    (isReply && parentBest ? parentBest.replies : regular).push(r.comment);
  });
  const out = [];
  for (const b of bests) out.push(b.comment, ...b.replies);
  out.push(...regular);
  const total = /\d/.test(totalText) ? parseCount(totalText) : null;
  return { comments: out.slice(0, MAX_COMMENTS), commentTotal: total ?? (out.length ? null : 0) };
}

const IMG_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|avif)(?:[?#].*)?$/i;

/** 축소판 → 원본 크기: 트위터 이미지(name=small/900x900/large 등) 는 name=4096x4096 으로.
 *  name=orig 는 format 이 원본 형식과 다르면 404 (실측: jpg 원본에 format=png&name=orig → 404) 라서 쓰지 않고,
 *  4096x4096 은 어떤 format 이든 200 + 원본 크기(4096 이하) 그대로다. large 는 2048 로 줄여서 긴 캡처가 작아진다. */
function originalImageUrl(src) {
  try {
    const u = new URL(src);
    if (/(^|\.)twimg\.com$/i.test(u.hostname) && /^\/media\//.test(u.pathname)) {
      const name = u.searchParams.get('name');
      if (name && name !== 'orig' && name !== '4096x4096') {
        u.searchParams.set('name', '4096x4096');
        return u.toString();
      }
      // 옛 형식 ".../media/XXX.jpg:small" — 확장자가 형식을 정하므로 :orig 가 안전
      const m = /^(.*\.(?:jpe?g|png|webp|gif)):(?!orig$)\w+$/i.exec(u.pathname);
      if (!name && m) {
        u.pathname = `${m[1]}:orig`;
        return u.toString();
      }
    }
  } catch {}
  return src;
}

export default {
  id: 'bobaedream',
  name: '보배드림 신유머 베스트',
  short: '보배',
  color: '#1e4f9c',
  homepage: `${BASE}/list?code=best&bestbbs=${BEST_FROM}`,
  domains: ['bobaedream.co.kr'],
  // file1~N.bobaedream.co.kr(첨부), image.bobaedream.co.kr(아이콘) + 퍼온 글이 외부 주소로 박아 넣는 이미지
  // (실제 관찰: pbs.twimg.com 트위터 이미지, encrypted-tbn0.gstatic.com 구글 이미지 썸네일,
  //  image.fmkorea.com 펨코 퍼온 짤 — 보배드림 Referer 면 ext.fmkorea.com 으로 302 후 같은 이미지 200,
  //  media.slrclub.com SLR클럽 퍼온 짤 — Referer 유무와 무관하게 200)
  // 여기 없는 외부 호스트는 reader 가 프록시 없이 no-referrer 로 직접 띄운다.
  imageHosts: ['bobaedream.co.kr', 'twimg.com', 'gstatic.com', 'fmkorea.com', 'slrclub.com'],
  referer: `${BASE}/`,
  strictness: 'strict', // 보배드림은 유머/이슈 게시판에도 정치·시사 글이 많이 섞인다
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const p = Math.max(1, Number(page) || 1);
    const listUrl = `${BASE}/list?code=best&bestbbs=${BEST_FROM}&page=${p}`;
    const { $, text, url } = await fetchHtml(listUrl, { referer: `${BASE}/` });
    const fullTitles = rawTitles(text, $);
    const items = [];
    const seen = new Set();

    $('#boardlist tbody tr').each((_, tr) => {
      const $tr = $(tr);
      // tr.best = 게시판 상단에 매 페이지 반복되는 기간 베스트 1~5위 위젯, notice = 공지
      if ($tr.hasClass('best') || $tr.hasClass('notice')) return;
      const $a = $tr.find('a.bsubject').first();
      const href = absUrl($a.attr('href'), url);
      if (!href) return;
      const u = new URL(href);
      const code = u.searchParams.get('code');
      const no = u.searchParams.get('No');
      if (!code || !/^\d+$/.test(no || '')) return;

      // 공지/이벤트/광고 행: 아이콘 alt, 번호 칸 텍스트, 제목 말머리로 거른다
      const icons = $tr.find('img').map((_, el) => $(el).attr('alt') || '').get().join(' ');
      const numCell = cleanText($tr.find('td').first().text());
      if (NOTICE_RE.test(icons) || NOTICE_RE.test(numCell)) return;

      const category = cleanText($tr.find('td.category').attr('title') || $tr.find('td.category').text()) || null;
      // bestbbs 필터가 풀려 정치게시판 베스트가 섞이는 경우 대비
      if (category && /정치/.test(category)) return;

      const shown = cleanText($a.text());
      const full = fullTitles.get(no);
      // 댓글 수는 제목 링크 밖의 별도 <a>(.totreply) 에 있어 제목 문자열에는 꼬리표가 붙지 않는다.
      // 그래서 끝의 "(19)", "[19]", "(2)" 같은 숫자는 글쓴이가 단 표시(후방·편 번호)이므로 지우지 않는다.
      const title = full && full.length >= shown.replace(/\.+$/, '').length ? full : shown;
      // 말머리처럼 대괄호/괄호로 감싼 공지·광고·이벤트만 거른다 ("광고 찍다 생긴 일" 같은 일반 글은 살림)
      if (!title || /^\s*[[(【]\s*(공지|광고|이벤트|AD)\s*[\])】]/i.test(title)) return;

      const postId = no;
      if (seen.has(postId)) return;
      seen.add(postId);

      const $author = $tr.find('.author').first();
      const likesText = cleanText($tr.find('td.recomm').text());
      const reply = $tr.find('.totreply').first().text();

      items.push({
        postId,
        title,
        url: `${BASE}/view?code=${code}&No=${no}`,
        author: cleanText($author.attr('title') || $author.text()) || null,
        postedAt: parseKoDate($tr.find('td.date').first().text()),
        commentCount: reply ? parseCount(reply) : 0, // 댓글 링크가 없으면 댓글 0개
        views: parseCount($tr.find('td.count').first().text()),
        likes: /\d/.test(likesText) ? parseCount(likesText) : null,
        category,
        nsfwHint: isNsfw(title) || /후방|성인/.test(category || ''),
        thumbnail: null,
      });
    });
    return items;
  },

  async read(postUrl) {
    const { $, text: rawHtml, url } = await fetchHtml(postUrl, { referer: `${BASE}/list?code=best&bestbbs=${BEST_FROM}` });
    const $body = $('.bodyCont').first();
    if (!$body.length) throw new Error('본문 영역(.bodyCont)을 찾지 못함 — 삭제·블라인드되었거나 구조가 바뀜');
    // 댓글은 본문 정리(요소 제거) 전에 페이지 원문에서 읽는다 (본문 밖 #cmt_list 라 본문과 겹치지 않음)
    let comments = [];
    let commentTotal = null;
    try {
      ({ comments, commentTotal } = parseComments(rawHtml, $, url));
    } catch {
      comments = [];
    }

    // 스크립트/광고/주석 제거
    $body.find('script, style, noscript, ins, iframe[src*="googleads"], iframe[src*="doubleclick"]').remove();
    $body
      .find('*')
      .addBack()
      .contents()
      .filter((_, n) => n.type === 'comment')
      .remove();
    // 이미지 확대용 팝업 링크(<a href="#inlineContent">)는 벗겨 내고 이미지만 남긴다
    $body.find('a.defaultDOMWindow, a[href="#inlineContent"]').each((_, a) => {
      $(a).replaceWith($(a).contents());
    });
    $body.find('[onclick], [onerror], [onload], [onmouseover]').each((_, el) => {
      for (const k of ['onclick', 'onerror', 'onload', 'onmouseover']) $(el).removeAttr(k);
    });
    $body.find('img[alt="클릭하시면 원본 이미지를 보실 수 있습니다."]').attr('alt', '');
    $body.find('img[style]').each((_, el) => {
      const st = ($(el).attr('style') || '').replace(/cursor\s*:\s*pointer;?/i, '').trim();
      if (st) $(el).attr('style', st);
      else $(el).removeAttr('style');
    });
    normalizeMedia($, $body, url);
    // 이미지 잘림/축소판 방지:
    //  - <a href="원본.jpg"><img src="축소판"></a> 이면 원본 주소로 (보배드림 자체 첨부는 src 가 이미 원본)
    //  - 트위터 이미지 name=900x900/small/large 등 축소판 → name=4096x4096 (실제 예: 1040383 "name=900x900")
    //  - width/height 속성은 원본보다 작게 박혀 있을 수 있어 지운다 (화면은 max-width:100%; height:auto)
    $body.find('a[href] img').each((_, el) => {
      const $img = $(el);
      const $a = $img.closest('a[href]');
      const href = absUrl($a.attr('href'), url);
      if (!href || $a.find('img').length !== 1 || href === $img.attr('src')) return;
      try {
        if (IMG_EXT_RE.test(new URL(href).pathname)) $img.attr('src', href);
      } catch {}
    });
    $body.find('img[src], video[poster], video[src], source[src]').each((_, el) => {
      const $el = $(el);
      for (const k of ['src', 'poster']) {
        const v = $el.attr(k);
        if (v) $el.attr(k, originalImageUrl(v));
      }
    });
    $body.find('img, video').removeAttr('width').removeAttr('height');

    const $subject = $('.writerProfile dt strong').first().clone();
    $subject.find('em').remove(); // 댓글수 꼬리표 [48]
    let title = cleanText($subject.text()) || cleanText($('.writerProfile dt[title]').first().attr('title'));
    if (!title) title = cleanText(($('meta[property="og:title"]').attr('content') || '').replace(/\s*\|\s*보배드림.*$/, ''));

    // 사이트 클래스 이름이 "proflieInfo"(오타) 라서, 바뀌어도 글쓴이 상자 안의 nickName 으로 찾는다
    const author = cleanText($('.writerProfile .nickName').first().text()) || null;
    const postedAt = parseViewDate($('.writerProfile .countGroup').first().text());

    return {
      title,
      html: ($body.html() || '').trim(),
      author,
      postedAt,
      nsfwHint: isNsfw(title),
      comments,
      commentTotal,
    };
  },
};
