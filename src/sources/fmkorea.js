// 에펨코리아 "포텐 터짐 최신순"(/best) 중 유머/움짤/이슈 게시판(mid=humor) 글만.
//
// - 목록: https://www.fmkorea.com/best?page=N  (robots.txt 의 `User-agent: *` 그룹에서 /best·/best2·/humor 만 Allow)
//   · 상단 위젯(li_best2_pop1 = 화제순 고정 노출, li_best2_hotdeal1 = 핫딜)과 광고(div.fmad_wrapper), 공지 표는 제외
//   · li_best2_politics1(정치 표시) 행 제외, 다른 게시판(축구·미스터리·게임 등) 글 제외, humor 게시판의 '이슈' 말머리(뉴스) 제외
//   · 목록의 시각은 '포텐 터진 시각'(실제 작성 시각 아님) — read() 가 본문 상단의 실제 작성 시각을 돌려준다.
// - 글 주소: https://www.fmkorea.com/best/<document_srl>  (/best 접두사라 robots Allow 범위)
// - 이미지: image.fmkorea.com, 영상(움짤 mp4): media*.fmkorea.com. 외부 Referer 면 ext.fmkorea.com 으로 302 → Referer 는 fmkorea.
// - 후방 표시: 사이트 차원의 플래그는 없고 제목 말머리("ㅇㅎ)", "약후", "후방주의" 등)로만 표시됨 → 제목 정규식으로 nsfwHint.
// - 댓글: 글 페이지 안에 베스트 댓글 + 마지막 댓글 페이지(최신 ~80개)가 함께 옴 → 추가 요청 없이 그것만 사용.
// - 봇 차단: 짧은 시간에 요청이 몰리면 IP 단위로 HTTP 430 "에펨코리아 보안 시스템"(JS/WASM 챌린지) 페이지가 뜨고
//   수십 분 이상 유지된다. 챌린지는 풀지 않으며, 걸리면 의미 있는 오류(status 430)를 던진다.

import { fetchHtml, HttpError } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.fmkorea.com';
const BOARD_MID = 'humor';
// humor 게시판 말머리: 유머(486622) / 움짤(3331461695) / 이슈(1899663, 뉴스·시사 위주라 쇼츠 소재로 부적합)
const EXCLUDED_CATEGORIES = new Set(['1899663']);
const EXCLUDED_CATEGORY_NAMES = new Set(['이슈']);

// 에펨은 짧은 시간에 요청이 몰리면 IP 단위로 HTTP 430 + JS(WASM) 챌린지 페이지("에펨코리아 보안 시스템",
// Retry-After: 300)를 띄운다. 챌린지는 풀지 않고, 요청 간격을 넉넉히 둬서 걸리지 않게만 한다.
const FM_INTERVAL_MS = Number(process.env.FMKOREA_INTERVAL_MS ?? 4000);

function blockedError(url) {
  const err = new Error(`에펨코리아 봇 차단(HTTP 430 보안 시스템 페이지, 보통 5분 뒤 해제): ${url}`);
  err.status = 430;
  return err;
}

async function fmFetch(url, referer) {
  let r;
  try {
    r = await fetchHtml(url, { referer, interval: FM_INTERVAL_MS, retries: 1 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 430) throw blockedError(url);
    throw e;
  }
  if (/<title>\s*에펨코리아 보안 시스템/.test(r.text)) throw blockedError(url);
  return r;
}

const NSFW_RE = /ㅇㅎ|약후|후방|ㅎㅂ|약ㅎ|ㅇㅎㅂ|므흣|은꼴|19금|[([]\s*19\s*[)\]]|^\s*19\s*\)|\bnsfw\b/i;

function postIdFrom(href) {
  if (!href) return null;
  const m = /document_srl=(\d+)/.exec(href) || /^(?:https?:\/\/[^/]+)?\/(?:[a-z_0-9]+\/)?(\d{5,})(?:[/?#]|$)/i.exec(href);
  return m ? m[1] : null;
}

/** 목록 regdate: 보이는 글자("5 시간 전")와 HTML 주석 안의 "18:51" 을 함께 써서 분 단위로 맞춘다. */
function parseListDate($, $el) {
  if (!$el.length) return null;
  const html = $el.html() || '';
  const comment = cleanText(/<!--([\s\S]*?)-->/.exec(html)?.[1] || '');
  const visible = cleanText($el.clone().contents().filter((_, n) => n.type === 'text').text());
  if (comment && /^\d{1,2}:\d{2}$/.test(comment) && /(초|분|시간)\s*전|방금|^\d{1,2}:\d{2}/.test(visible)) {
    return parseKoDate(comment);
  }
  return parseKoDate(visible) || parseKoDate(comment);
}

export function parseList($, pageUrl) {
  const items = [];
  const seen = new Set();
  $('.fm_best_widget li.li').each((_, li) => {
    const $li = $(li);
    const cls = $li.attr('class') || '';
    // 상단 화제글 위젯 · 핫딜 · 정치 표시 행 제외
    if (/li_best2_pop1|li_best2_hotdeal1|li_best2_politics1/.test(cls)) return;

    const $a = $li.find('h3.title a').first();
    const href = $a.attr('href');
    const postId = postIdFrom(href);
    if (!postId || seen.has(postId)) return;

    // 게시판·말머리: <span class="category"><a href="/humor">유머</a> - <a href="...category=3331461695">움짤</a></span>
    const $cat = $li.find('.category a');
    const boardHref = $cat.first().attr('href') || '';
    const boardMid = /^\/([a-z_0-9]+)\/?$/i.exec(boardHref)?.[1] || /mid=([a-z_0-9]+)/i.exec(boardHref)?.[1] || null;
    if (boardMid !== BOARD_MID) return;
    const $sub = $cat.eq(1);
    const subId = /category=(\d+)/.exec($sub.attr('href') || '')?.[1] || null;
    const subName = cleanText($sub.text()) || null;
    if ((subId && EXCLUDED_CATEGORIES.has(subId)) || (subName && EXCLUDED_CATEGORY_NAMES.has(subName))) return;

    const $title = $a.find('.ellipsis-target');
    let title = cleanText(($title.length ? $title : $a).text());
    title = title.replace(/\s*\[\d+\]\s*$/, '').trim();
    if (!title) return;

    const $thumb = $li.find('img.thumb').first();
    const thumbSrc = $thumb.attr('data-original') || $thumb.attr('src') || '';
    const thumbnail = thumbSrc && !/transparent\.gif/.test(thumbSrc) ? absUrl(thumbSrc, pageUrl) : null;

    seen.add(postId);
    items.push({
      postId,
      title,
      url: `${BASE}/best/${postId}`,
      author: cleanText($li.find('.author').first().text()).replace(/^\/\s*/, '') || null,
      postedAt: parseListDate($, $li.find('.regdate').first()),
      commentCount: parseCount($a.find('.comment_count').text()) ?? 0,
      views: null, // 목록에 조회수 없음
      likes: parseCount($li.find('.pc_voted_count .count').first().text()),
      category: subName || cleanText($cat.first().text()) || null,
      nsfwHint: NSFW_RE.test(title),
      thumbnail,
    });
  });
  return items;
}

/** 움짤(mp4) 래퍼를 단순한 <video> 로 바꾼다 (원래는 opacity:0 + 비율 유지용 padding 이라 사이트 CSS 없이는 깨짐). */
function simplifyVideos($, $body, baseUrl) {
  $body.find('.auto_media_wrapper').each((_, w) => {
    const $w = $(w);
    const $v = $w.find('video').first();
    const src = $v.find('source[src]').first().attr('src') || $v.attr('src');
    if (!src) {
      $w.remove();
      return;
    }
    const abs = absUrl(src, baseUrl);
    const poster = absUrl($v.attr('poster'), baseUrl);
    const silent = /video-without-sound/.test($v.attr('class') || '') || $v.is('[muted]');
    const attrs = ['controls', 'playsinline', 'preload="metadata"'];
    if (silent) attrs.push('muted', 'loop');
    if (poster) attrs.push(`poster="${poster.replace(/"/g, '&quot;')}"`);
    const w2 = Number($v.attr('width'));
    if (w2) attrs.push(`width="${w2}"`);
    $w.replaceWith(`<p><video ${attrs.join(' ')}><source src="${abs.replace(/"/g, '&quot;')}" type="video/mp4"></video></p>`);
  });
}

/** 댓글 xe_content → 순수 텍스트 (<br>/<p> 는 줄바꿈) */
function commentText($, $c) {
  const $x = $c.clone();
  $x.find('script, style, img, video, iframe').remove();
  $x.find('br').replaceWith('\n');
  $x.find('p, div').each((_, el) => {
    $(el).append('\n');
  });
  return $x
    .text()
    .split('\n')
    .map((l) => l.replace(/[\s ​]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 댓글: 글 페이지에 베스트 댓글(li.comment_best, 최대 몇 개)과 '마지막 댓글 페이지'(최신 ~80개)가 함께 들어 있다.
 * 앞쪽 댓글 페이지(cpage=1..)는 /index.php?...&cpage= 라 robots 에서 막혀 있고 요청도 늘어나므로 가져오지 않는다.
 */
function parseComments($, pageUrl) {
  const best = [];
  const normal = [];
  const seen = new Set();
  $('ul.fdb_lst_ul > li.fdb_itm').each((_, li) => {
    const $li = $(li);
    const cls = $li.attr('class') || '';
    const isBest = /\bcomment_best\b/.test(cls);
    const cid = /comment_(\d+)/.exec($li.attr('id') || '')?.[1] || null;
    // 베스트 댓글 묶음이 두 번 들어있거나, 베스트 댓글이 일반 목록에도 다시 나오는 경우
    if (cid && seen.has(cid)) return;
    const $content = $li.find('.comment-content .xe_content').first();
    if (!$content.length) return;
    const $tmp = $content.clone();
    // 대댓글 앞의 "부모 닉네임" 링크 제거
    $tmp.find('a.findParent').remove();
    normalizeMedia($, $tmp, pageUrl);
    const images = $tmp
      .find('img[src], video[src], video source[src]')
      .map((__, el) => $(el).attr('src'))
      .get()
      .filter((s) => /^https?:\/\//.test(s) && !/transparent\.gif|\/modules\/point\/icons\//.test(s));
    const text = commentText($, $tmp);
    if (!text && !images.length) return;
    if (/^(삭제|블라인드)\s*(된|처리된)\s*댓글/.test(text) && !images.length) return;
    const c = {
      author: cleanText($li.find('.meta .member_plate').first().text()) || null,
      text,
      likes: parseCount($li.find('.voted_count').first().text()),
      dislikes: parseCount($li.find('.blamed_count').first().text()),
      best: isBest,
      reply: /\bre\b/.test(cls) || $content.find('a.findParent').length > 0,
      postedAt: parseKoDate(cleanText($li.find('.meta .date').first().text())),
      images,
    };
    if (isBest) {
      if (cid) seen.add(cid);
      best.push(c);
    } else {
      if (cid) seen.add(cid);
      normal.push(c);
    }
  });
  return [...best, ...normal].slice(0, 100);
}

export function parseArticle($, pageUrl) {
  const $body = $('article .xe_content').first();
  $body.find('script, style, ins, noscript, meta, .fmad_wrapper, .ad_wrapper, [id^="fm_read_vote"]').remove();
  $body.find('iframe[src*="loader.fmkorea.com"]').remove();
  simplifyVideos($, $body, pageUrl);
  normalizeMedia($, $body, pageUrl);
  // 지연로딩 자리표시자만 남은 img 제거
  $body.find('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || /classes\/lazy\/img\/transparent\.gif/.test(src)) $(el).remove();
  });
  $body.find('[data-file-download-url]').removeAttr('data-file-download-url');
  // 본문 끝의 서버 주석 제거
  $body.contents().each((_, n) => {
    if (n.type === 'comment') $(n).remove();
  });

  const title = cleanText($('.top_area .np_18px_span').first().text() || $('.top_area h1').first().text());
  const author = cleanText($('.btm_area .side').not('.fr').find('.member_plate').first().text()) || null;
  const postedAt = parseKoDate(cleanText($('.top_area .date').first().text()));
  const sideText = cleanText($('.btm_area .side.fr').first().text());
  const commentTotal = parseCount(/댓글\s*([\d,]+)/.exec(sideText)?.[1] ?? null);
  return {
    title,
    html: ($body.html() || '').trim(),
    author,
    postedAt,
    nsfwHint: NSFW_RE.test(title),
    comments: parseComments($, pageUrl),
    commentTotal,
  };
}

export default {
  id: 'fmkorea',
  name: '에펨코리아 포텐(유머)',
  short: '펨코',
  color: '#2d5bb3',
  homepage: `${BASE}/best`,
  domains: ['fmkorea.com'],
  imageHosts: ['fmkorea.com'], // image.fmkorea.com, media5jvqbd.fmkorea.com 등
  referer: `${BASE}/`,
  strictness: 'strict', // 이슈/시사성 유머·정치 비꼼 글이 자주 섞임
  // 조사 중 목록·글 7회 요청(약 2.5분) 만에 IP 가 HTTP 430 JS/WASM 챌린지에 걸렸고 1시간 가까이 풀리지 않았다.
  // 챌린지를 풀지 않는 한 안정 수집이 어려워 기본은 꺼 둔다. 차단이 풀린 뒤 FMKOREA_ENABLE=1 로 켜서 시험할 수 있다
  // (그때는 수집 간격을 길게, 페이지 수를 적게).
  disabled: process.env.FMKOREA_ENABLE !== '1',
  disabledReason:
    process.env.FMKOREA_ENABLE === '1'
      ? null
      : '봇 차단: 짧은 시간 몇 번 요청하면 IP 단위로 HTTP 430 "에펨코리아 보안 시스템" JS/WASM 챌린지가 뜨고 오래 유지됨 (챌린지 우회 안 함). FMKOREA_ENABLE=1 로 켤 수 있음',

  async list(page = 1) {
    const listUrl = page > 1 ? `${BASE}/best?page=${page}` : `${BASE}/best`;
    const { $, url } = await fmFetch(listUrl, page > 1 ? `${BASE}/best` : undefined);
    if (!$('.fm_best_widget').length) {
      throw new Error(`에펨코리아 목록 구조를 찾지 못함 (봇 차단 페이지일 수 있음): ${url}`);
    }
    return parseList($, url);
  },

  async read(postUrl) {
    const { $, url } = await fmFetch(postUrl, `${BASE}/best`);
    if (!$('article .xe_content').length) {
      throw new Error(`에펨코리아 본문을 찾지 못함 (삭제됐거나 봇 차단 페이지일 수 있음): ${url}`);
    }
    return parseArticle($, url);
  },
};
