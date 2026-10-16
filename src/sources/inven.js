// 인벤 오픈이슈갤러리 (webzine/2097) — "10추글"(추천 10 이상) 목록에서 [이슈] 말머리를 사이트 쪽에서 제외해 가져온다.
//   목록: https://www.inven.co.kr/board/webzine/2097?my=chu&category=_이슈&p=N  (한 페이지 50개)
//   글:   https://www.inven.co.kr/board/webzine/2097/<글번호>
// - my=chu      : 추천 10 이상 글만 (게시판 상단 "10추글" 버튼). my=chuchu 는 20추(숨은 옵션)인데 이슈글 비중이 더 높다.
// - category=_이슈: 사이트가 제공하는 "이슈 제외" 필터. 남는 말머리: 유머·기타·계층·감동·연예·게임·지식·사진.
// - 목록 날짜는 24시간 이내면 "HH:MM", 그 이전이면 "MM-DD" (시각 없음). 본문의 .articleDate 는 "YYYY-MM-DD HH:MM".
// - 필터 목록은 "최근 글 1만 개" 범위에서만 검색돼 7쪽 안팎(약 3주치)까지만 나오고 그 뒤 쪽은 빈 목록이다 (그 뒤는 sterm '다음검색').
// - 이미지/영상은 upload*.inven.co.kr. 외부 Referer 로는 403, Referer 없음 또는 inven.co.kr Referer 는 200.
// - 본문 이미지는 "...jpg?MW=800" 처럼 가로 800 으로 줄인 축소판 주소로 박혀 있다 (1079x7809 캡처 → 800x5790).
//   MW 를 떼면 원본이 온다. 움짤은 사이트가 mp4 로 바꿔 <video data-src> 로 넣는다 (poster 없음).
// - 댓글은 본문 HTML 에 없고 PwCMT.js 가 AJAX 로 가져온다:
//     POST https://www.inven.co.kr/common/board/comment.json.php  (robots.txt 금지 경로 아님 — /common/admin/ 만 금지)
//     comeidx=2097&articlecode=<글번호>&sortorder=date&act=list&out=json&replynick=&replyidx=0&uploadurl=&imageposition=&titles=100
//   응답: { cmtcount, pagecount:100, bestcomment:{list:[...]}, commentlist:[{__attr__:{titlenum}, list:[...]}] }
//   100개씩 묶음(titlenum 100,200,..,0)인데 기본은 마지막 묶음만 채워 준다. titles=100 을 주면 첫 묶음(1~100번째)도 채워
//   오고, 댓글이 100개 이하일 때는 결과가 같다 → 요청 1번으로 처음 100개.
//   항목: __attr__{cmtidx, cmtpidx(부모; 다르면 답글), state(Y 정상/N 삭제/B 블라인드/C 삭제대기)}, o_name, o_date(KST),
//   o_recommend, o_notrecommend, o_comment(HTML 을 한 번 더 엔티티 인코딩한 문자열; \n 은 줄바꿈).
//   댓글 짤: <div class="cmtimager"><img class="cmtimage" src="...?MW=360"> 또는 <video data-src="...mp4">, 스티커 img, 유튜브 iframe.
//   베스트(bestcomment)는 일반 목록에도 같은 댓글이 또 있어 일반 쪽에서 빼는데, 그 답글들은 베스트 바로 뒤로 옮긴다.
//   블라인드(B) 원댓글에 답글이 수십 개 달리는 일이 흔하다 — 부모가 빠진 답글은 reply:false (엉뚱한 댓글 밑에 붙지 않게).
import * as cheerio from 'cheerio';
import { fetchHtml, fetchText } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia, hostMatches } from '../lib/util.js';

const BASE = 'https://www.inven.co.kr';
const BOARD = `${BASE}/board/webzine/2097`;
const LIST_QUERY = `my=chu&category=${encodeURIComponent('_이슈')}`;

// 사이트 사용자들이 제목에 붙이는 후방/19 표기: "ㅇㅎ]", "ㅇㅎ)", "(ㅎㅂ)", "ㅇㅎㅂ?", "19)", "[19]", "(19+)", "후방 ㅡ", "약후", "ㅗㅜㅑ", "므흣"
// (사이트 자체의 성인 아이콘·클래스·말머리는 없다.)
//  - "후방 추돌/후방카메라" 같은 자동차·군사 용어는 빼고, "계약후·예약후"(앞에 한글) 와 "약후기" 는 약후로 보지 않는다.
//  - "(2019)", "119" 처럼 앞에 숫자가 붙은 19 는 잡지 않는다.
const NSFW_RE = new RegExp(
  [
    'ㅇㅎ',
    'ㅎㅂ',
    'ㅗㅜㅑ',
    '므흣',
    '19금',
    '후방(?!\\s*(?:추돌|충돌|카메라|캠|센서|주차|감지|경고|부대|지원|사령|기지|좌석|시야|램프|범퍼|블박|블랙박스))',
    '(?<![가-힣])약후(?!기)',
    '(?:^|[\\s[(])19\\s*(?:\\+|[)\\]])',
  ].join('|'),
);
const NO_THUMB_RE = /gallery_no_image|no_?img/i;

const isNsfwTitle = (t) => NSFW_RE.test(t || '');

const COMMENT_API = `${BASE}/common/board/comment.json.php`;
const MAX_COMMENTS = 100;
const DELETED_RE = /^\s*(?:\[?삭제됨\]?|삭제된\s*(?:댓글|코멘트)|블라인드\s*(?:된|처리된)\s*(?:댓글|코멘트))/;

/** 인벤 업로드 이미지의 축소판 파라미터(MW/MH)를 떼서 원본 주소로. 다른 호스트는 그대로. */
function originalImage(src) {
  if (!src) return src;
  try {
    const u = new URL(src);
    if (!hostMatches(u.hostname, ['inven.co.kr'])) return src;
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (/^(MW|MH)$/i.test(k)) {
        u.searchParams.delete(k);
        changed = true;
      }
    }
    if (!changed) return src;
    return u.toString().replace(/\?$/, '');
  } catch {
    return src;
  }
}

const youtubeId = (src) => /(?:youtube(?:-nocookie)?\.com\/(?:embed|shorts)\/|youtu\.be\/)([\w-]{6,})/.exec(src || '')?.[1] || null;

/** o_comment(엔티티로 한 번 더 감싼 HTML) → { text, images } — 사이트(PwCMT)와 같은 방식으로 풀어서 글자만 뽑는다. */
function parseCommentBody(raw, baseUrl) {
  // 1차: 엔티티 해제 → 실제 HTML 문자열 (PwCMT _decodeEntities 와 같음), 줄바꿈은 <br>
  const html = cheerio.load(`<div id="r">${String(raw ?? '')}</div>`, null, false)('#r').text().replace(/\r?\n/g, '<br>');
  const $ = cheerio.load(`<div id="r">${html}</div>`, null, false);
  const $r = $('#r');
  const images = [];
  const links = [];
  const push = (u) => {
    const abs = originalImage(absUrl(u, baseUrl));
    if (abs && /^https:/.test(abs) && !images.includes(abs)) images.push(abs);
  };
  $r.find('img').each((_, el) => {
    const s = $(el).attr('data-src') || $(el).attr('src');
    if (s && !/^data:/.test(s)) push(s);
  });
  $r.find('video').each((_, el) => {
    const $v = $(el);
    const s = $v.attr('data-src') || $v.attr('src') || $v.find('source').attr('data-src') || $v.find('source').attr('src');
    if (s) push(s);
  });
  $r.find('iframe').each((_, el) => {
    const id = youtubeId($(el).attr('src'));
    if (id) {
      push(`https://img.youtube.com/vi/${id}/hqdefault.jpg`);
      links.push(`https://youtu.be/${id}`);
    }
  });
  $r.find('img, video, iframe, script, style, .cmtimager, .youtubeIframe').remove();
  $r.find('br').replaceWith('\n');
  $r.find('div, p, li').each((_, el) => {
    $(el).append('\n');
  });
  const text = [...$r.text().replace(/\u00a0/g, ' ').split('\n').map((l) => l.replace(/[ \t\u200b]+/g, ' ').trim()), ...links]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, images };
}

/**
 * 댓글 API 응답 → Comment[] (베스트 먼저, 그다음 사이트 순서, 중복은 베스트 쪽만).
 * 화면은 reply 를 "바로 위 댓글의 답글(↳)" 로 그리므로, 부모가 목록에서 빠지면 답글이 엉뚱한 댓글 밑에 붙는다:
 *  - 부모가 베스트라서 일반 목록에서 뺀 경우 → 그 답글들은 해당 베스트 바로 뒤로 옮긴다 (reply:true, best:false).
 *  - 부모가 삭제·블라인드(N/B/C) 등으로 빠진 경우 → 붙일 부모가 없으니 reply:false 로 둔다.
 */
function parseCommentJson(j, baseUrl) {
  const toComment = (c) => {
    const a = c?.__attr__ || {};
    if (a.state && a.state !== 'Y') return null; // N 삭제 / B 블라인드 / C 삭제 대기
    const { text, images } = parseCommentBody(c.o_comment, baseUrl);
    if (DELETED_RE.test(text) && !images.length) return null;
    if (!text && !images.length) return null;
    return {
      author: cleanText(c.o_name) || null,
      text,
      likes: parseCount(c.o_recommend),
      dislikes: parseCount(c.o_notrecommend),
      postedAt: parseKoDate(c.o_date),
      images,
    };
  };
  const parentOf = (a) => (a?.cmtpidx != null && a.cmtpidx !== a.cmtidx ? a.cmtpidx : null);

  // 일반 목록 (사이트 순서 = 부모 다음에 그 답글들)
  const regular = [];
  for (const block of j?.commentlist || []) {
    for (const c of block?.list || []) regular.push({ id: c?.__attr__?.cmtidx, pid: parentOf(c?.__attr__), c });
  }

  const best = [];
  const bestIds = new Set();
  for (const c of j?.bestcomment?.list || []) {
    const id = c?.__attr__?.cmtidx;
    if (id == null || bestIds.has(id)) continue;
    const x = toComment(c);
    if (!x) continue;
    bestIds.add(id);
    best.push({ id, top: parentOf(c.__attr__) == null, x });
  }

  const out = [];
  const placed = new Set(); // 베스트 뒤로 옮긴 답글
  for (const b of best) {
    out.push({ ...b.x, best: true, reply: false });
    if (!b.top) continue;
    for (const r of regular) {
      if (r.pid !== b.id || bestIds.has(r.id)) continue;
      placed.add(r.id);
      const x = toComment(r.c);
      if (x) out.push({ ...x, best: false, reply: true });
    }
  }
  const shownTop = new Set(); // 일반 목록에 실제로 넣은 원댓글
  for (const r of regular) {
    if (out.length >= MAX_COMMENTS) break;
    if (bestIds.has(r.id) || placed.has(r.id)) continue;
    const x = toComment(r.c);
    if (!x) continue;
    if (r.pid == null) shownTop.add(r.id);
    out.push({ ...x, best: false, reply: r.pid != null && shownTop.has(r.pid) });
  }
  return out.slice(0, MAX_COMMENTS);
}

/** 글 페이지의 PwCMT 설정을 읽어 댓글 API 를 한 번 부른다. */
async function fetchComments($, html, pageUrl) {
  // 글 머리의 "댓글(N)" — 0 이면 요청하지 않는다
  const shown = parseCount(cleanText($('a[onclick*="i-comment-list"]').first().text()).replace(/^댓글/, ''));
  if (shown === 0) return { comments: [], commentTotal: 0 };

  const init = /PwCMT\.constructor\(\{([\s\S]*?)\}\);/.exec(html)?.[1] || '';
  const comeidx = /comeidx\s*:\s*'([^']*)'/.exec(init)?.[1] || '2097';
  const articlecode = /articlecode\s*:\s*(\d+)/.exec(init)?.[1] || /\/(\d+)(?:[?#]|$)/.exec(pageUrl)?.[1];
  const commentPos = /commentPos\s*:\s*'([^']*)'/.exec(init)?.[1] || '';
  if (!articlecode || commentPos) return { comments: undefined, commentTotal: shown ?? null }; // 다른 댓글 방식(overank 등)

  const body = new URLSearchParams({
    comeidx,
    articlecode,
    sortorder: 'date',
    act: 'list',
    out: 'json',
    replynick: '',
    replyidx: '0',
    uploadurl: '',
    imageposition: '',
    titles: '100', // 댓글 100개 초과 시 접혀 있는 첫 묶음(1~100번째)도 채워 받는다
    videoloading: 'lazy',
  });
  const r = await fetchText(COMMENT_API, {
    method: 'POST',
    body: body.toString(),
    referer: pageUrl,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json, text/javascript, */*; q=0.01',
      origin: BASE,
    },
  });
  const j = JSON.parse(r.text);
  if (Number(j?.message) !== 1) throw new Error(`인벤 댓글 응답 오류: ${String(j?.message).slice(0, 80)}`);
  return { comments: parseCommentJson(j, pageUrl), commentTotal: parseCount(j.cmtcount) ?? shown ?? null };
}

/** 목록의 "HH:MM" 은 '24시간 이내' 라는 뜻이라, 오늘 시각으로 해석해서 미래가 되면 하루 전으로 돌린다. */
function listDate(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  const iso = parseKoDate(s);
  if (iso && /^\d{1,2}:\d{2}$/.test(s) && new Date(iso).getTime() > Date.now()) {
    return new Date(new Date(iso).getTime() - 864e5).toISOString();
  }
  return iso;
}

export default {
  id: 'inven',
  name: '인벤 오픈이슈갤러리 (10추)',
  short: '인벤',
  color: '#c8102e',
  homepage: `${BOARD}?${LIST_QUERY}`,
  domains: ['inven.co.kr'],
  imageHosts: ['inven.co.kr', 'img.youtube.com', 'ytimg.com'],
  referer: `${BASE}/`,
  // 이슈 말머리는 빼지만 유머/기타/계층에도 정치·젠더 떡밥 글이 자주 섞여 올라온다.
  strictness: 'strict',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const p = Math.max(1, Number(page) || 1);
    const { $, url } = await fetchHtml(`${BOARD}?${LIST_QUERY}&p=${p}`, { referer: `${BOARD}` });
    if (!$('div.board-list table').length) {
      throw new Error(`인벤 목록 구조(div.board-list table)를 찾지 못함 — 차단 페이지이거나 구조가 바뀜: ${url}`);
    }
    // 목록이 비어 있어도(사이트가 최근 글 1만 개 범위에서만 필터 목록을 7쪽 안팎까지 보여줌) 오류는 아니다.
    const items = [];
    const seen = new Set();
    $('div.board-list table tbody tr').each((_, tr) => {
      const $tr = $(tr);
      // 공지/고정글(운영팀 공지·이벤트)
      if ($tr.hasClass('notice') || $tr.find('.notice-icon').length) return;
      const $a = $tr.find('a.subject-link').first();
      const href = absUrl($a.attr('href'), url);
      const postId = /\/board\/webzine\/2097\/(\d+)/.exec(href || '')?.[1];
      if (!postId || seen.has(postId)) return;

      const category = cleanText($a.find('.category').first().text()).replace(/^\[|\]$/g, '') || null;
      // 사이트 필터가 풀려도 이슈 말머리는 받지 않는다
      if (category === '이슈' || category === '공지' || category === '광고' || category === '이벤트') return;

      const $cmt = $tr.find('.con-comment').first();
      const commentCount = parseCount($cmt.attr('data-opinion-bbs-opi')) ?? parseCount($cmt.text());

      // 댓글수 [N] 은 링크 밖의 별도 span 이라 제목에 붙지 않는다. 사용자가 쓴 "썰 모음 [2]" 같은 편수 표기는 지우지 않고,
      // 혹시 마크업이 바뀌어 댓글수와 같은 꼬리표가 붙어 들어올 때만 뗀다.
      const $title = $a.clone();
      $title.find('.category').remove();
      let title = cleanText($title.text());
      const tail = /\s*\[(\d+)\]$/.exec(title);
      if (tail && commentCount != null && Number(tail[1]) === commentCount) title = title.slice(0, tail.index).trim();
      if (!title) return;
      seen.add(postId);

      let thumbnail = absUrl($tr.find('td.thumb img').first().attr('src'), url);
      if (thumbnail && NO_THUMB_RE.test(thumbnail)) thumbnail = null;

      items.push({
        postId,
        title,
        url: `${BOARD}/${postId}`,
        author: cleanText($tr.find('td.user .layerNickName').first().text()) || null,
        postedAt: listDate($tr.find('td.date').first().text()),
        commentCount: commentCount ?? null,
        views: parseCount($tr.find('td.view').first().text()),
        likes: parseCount($tr.find('td.reco').first().text()),
        category,
        nsfwHint: isNsfwTitle(title),
        thumbnail,
      });
    });
    return items;
  },

  async read(postUrl) {
    const { $, url, text: pageHtml } = await fetchHtml(postUrl, { referer: `${BOARD}?${LIST_QUERY}` });
    const title = cleanText($('.articleTitle h1').first().text() || $('.articleTitle').first().text());
    const $body = $('#powerbbsContent').first();
    if (!$body.length) {
      throw new Error(`인벤 본문(#powerbbsContent)을 찾지 못함 — 삭제·블라인드되었거나 구조가 바뀜: ${postUrl}`);
    }
    $body.find('script, style, noscript, ins, iframe[src*="/ads/"], [id^="inven-ad"], .inven-ad').remove();
    normalizeMedia($, $body, url);
    // 지연로딩용 속성 정리 (src 로 옮겨졌음)
    $body.find('img, video, source').each((_, el) => {
      const $el = $(el);
      if ($el.attr('src')) $el.removeAttr('data-src').removeAttr('loading');
    });
    // 축소판(?MW=800) 대신 원본. <a href="원본.jpg"><img src="축소판"> 이면 링크 쪽 원본을 쓴다.
    $body.find('img').each((_, el) => {
      const $img = $(el);
      const href = $img.parent('a').attr('href');
      if (href && /\.(?:jpe?g|png|gif|webp)(?:\?|$)/i.test(href)) {
        try {
          if (hostMatches(new URL(href).hostname, ['inven.co.kr'])) $img.attr('src', href);
        } catch {}
      }
      const src = $img.attr('src');
      if (src) $img.attr('src', originalImage(src));
      // 원본으로 바꿨으니 박혀 있는 크기는 지운다 (화면 CSS 가 max-width:100%, height:auto 로 맞춤)
      $img.removeAttr('width').removeAttr('height');
    });
    $body.find('video').removeAttr('width').removeAttr('height');

    const author = cleanText($('.articleWriter').first().text()) || null;
    const postedAt = parseKoDate(cleanText($('.articleDate').first().text()));
    const category = cleanText($('.articleCategory').first().text()).replace(/^\[|\]$/g, '');
    const html = ($body.html() || '').trim();

    // 댓글: 실패해도 본문은 돌려준다
    let comments;
    let commentTotal = null;
    try {
      ({ comments, commentTotal } = await fetchComments($, pageHtml, url));
    } catch (e) {
      console.warn(`[inven] 댓글 가져오기 실패 ${postUrl}: ${e.message}`);
    }

    return {
      title,
      html,
      author,
      postedAt,
      category: category || null,
      nsfwHint: isNsfwTitle(title),
      comments,
      commentTotal,
    };
  },
};
