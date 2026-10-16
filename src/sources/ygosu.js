// 와이고수(ygosu.com) 엽기자랑 게시판 — "인기" 탭(best_article=Y) 목록.
//
// 구조 메모 (2026-10 조사):
//  - www.ygosu.com 은 ygosu.com 으로 301. 목록 /board/yeobgi/?best_article=Y&page=N (25개/쪽, 기본 썸네일 보기).
//  - 목록 행: table.bd_list tr. 공지는 tr.notice, 광고는 /board/ad/... 링크에 td.tit 없음.
//  - 인기 목록의 날짜 칸(td.date)은 작성 시각이 아니라 인기 등록 시각으로 보인다
//    (예: 23:18 작성 글이 00:07 로 표시). 대신 썸네일 주소 storage2.ygosu.com/?code=S<유닉스초>... 의
//    숫자가 업로드(=작성) 시각과 몇 초 차이로 일치하므로, 날짜 칸과 모순되지 않으면 그 값을 쓴다.
//    단 글을 수정해 썸네일이 다시 만들어지면 수정 시각이 된다 (예: 2151613 작성 13:47:48, 썸네일 14:05:25).
//    정확한 작성 시각은 read() 의 값을 쓸 것.
//  - 본문: #body_contain (.filebox 첨부 상자, .ygosu_banner 광고 제외). 이미지·영상은 storage2.ygosu.com.
//    storage2 는 Referer 없음/ygosu.com 은 200, 다른 사이트 Referer 는 403.
//  - 후방 표시는 사이트 아이콘이 아니라 제목 말머리("ㅇㅎ)", "ㅇㅎ}", "ㅇㅎ>", "약후" 등)뿐.
//    본문 이미지는 <a href=X><img src=X> 로 링크와 같은 원본 주소(축소판 아님), width/height 속성 없음.
//    움짤은 <video class="gif-video" poster="...&variant=poster"><source src="...#t=0.001" type="video/mp4">.
//  - 댓글 (2026-10 조사): 글 HTML 안에 서버가 이미 그려 둔다 — 추가 요청 없음.
//    #best_reply_list_layer > li.bestreply (베스트, 일반 목록에도 같은 댓글이 또 나옴),
//    #reply_list_layer > li.normal_reply | li.inner_reply(대댓글, 부모 바로 뒤) | li(광고, .comment 없음).
//    li 안: .nick(닉네임) .time("14시간 전"/"6일 전" 반올림된 상대 시각뿐 — 글 시각보다 앞서면 글 시각으로 맞춤)
//    .comment#reply_body_<게시판>_<댓글번호> (.reply_nick "@닉", img.yg_con_reply_image 와고콘 /
//    img.reply_upload_image 댓글 짤, .best_reply_badge, 유튜브는 .video_wrap > .video_toggle("토글") + iframe),
//    .vt_good/.vt_bad (추천/반대). 전체 수 #reply_comment_cnt.
//    새로고침·쪽 이동은 POST /action.yg (path=reply/reply_list_action) 인데 robots.txt 가 /action.yg 를
//    Disallow 하므로 쓰지 않는다. 글 HTML 의 reply_info_str(base64 JSON)이 pagesize:0 이고, 조사한 글(댓글
//    43개까지)은 모두 첫 HTML 에 전부 들어 있었다(#reply_paging 숨김).
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://ygosu.com';
const BOARD = 'yeobgi';

// 제목 말머리로 표시된 후방/므흣 글.
//  - "19살", "11/19일" 같은 일반 표현은 잡지 않도록 19/18 은 "19)", "[19]", "(19+)", "19+)" 처럼
//    제목 맨 앞이나 공백 뒤에서 닫는 괄호가 붙은 경우만. 뉴스식 나이 표기 "A씨(19)", "여고생(18)" 은 제외.
//  - "후방 추돌", "후방카메라" 같은 자동차/군사 용어는 후방 표시로 보지 않는다.
const NSFW_RE =
  /ㅇㅎ|ㅎㅂ|약후|후방(?!\s*(?:추돌|충돌|카메라|캠|센서|감지|주차|기지|부대|지원|사령|침투|보급))|약ㅎ|ㅗㅜㅑ|므흣|19금|세미누드|노출\s*주의|수위\s*주의|(?:^|\s)[[({<]?\s*(?:19|18)\s*\+?\s*[)\]}>]/;
// 사이트 봇이 올리는 게시판 요약 글 (사람 글이 아님)
const BOT_RE = /^\[\s*와고봇/;

const nsfwOf = (title) => NSFW_RE.test(title || '');

/** 썸네일/이미지 주소의 code=S<10자리 유닉스초> → Date */
function storageTime(src) {
  const m = /[?&]code=S(\d{10})/.exec(src || '');
  if (!m) return null;
  const d = new Date(Number(m[1]) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 인기 목록의 날짜 칸(인기 등록 시각)과 썸네일 업로드 시각으로 작성 시각을 추정.
 * 썸네일 시각이 날짜 칸보다 늦거나 3일 넘게 이르면 믿지 않고 날짜 칸 값을 쓴다.
 */
function guessPostedAt(dateText, thumbSrc) {
  const col = parseKoDate(dateText);
  const t = storageTime(thumbSrc);
  if (!t) return col;
  if (!col) return t.getTime() <= Date.now() + 5 * 60e3 ? t.toISOString() : null;
  const colMs = new Date(col).getTime();
  // "26.10.16" 처럼 날짜만 있으면 그날 끝(KST 23:59:59)까지 허용
  const dayOnly = !/\d{1,2}:\d{2}/.test(dateText || '');
  const upper = colMs + (dayOnly ? 864e5 : 10 * 60e3);
  const lower = colMs - 3 * 864e5;
  const ms = t.getTime();
  if (ms <= upper && ms >= lower && ms <= Date.now() + 5 * 60e3) return t.toISOString();
  return col;
}

const postUrl = (id) => `${BASE}/board/${BOARD}/${id}`;

const MAX_COMMENTS = 100;
const DELETED_RE = /^(?:삭제된\s*댓글|관리자에\s*의해\s*삭제|블라인드\s*처리)/;

// cheerio 의 replaceWith(문자열)은 HTML 로 해석하므로 글자는 이스케이프해서 넣는다
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 댓글에 삽입된 영상(iframe) 주소 → 글로 남길 링크 (유튜브 embed 는 youtu.be 로) */
function embedLink(src, pageUrl) {
  const u = absUrl(src, pageUrl);
  if (!u) return null;
  const yt = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(u);
  return yt ? `https://youtu.be/${yt[1]}` : u;
}

/** .comment 요소 → 순수 텍스트 (줄바꿈 유지, "@닉" 은 앞에 붙여 둠) */
function commentText($, $c, pageUrl) {
  const $x = $c.clone();
  // HTML 소스의 줄바꿈("<br />\n")은 공백일 뿐이므로, <br>·블록 끝만 표시해 두었다가 줄바꿈으로 바꾼다
  const NL = '\uE000';
  // 유튜브 등 삽입 영상: <div class="video_wrap">…<span class="video_toggle">토글</span><iframe src=…></div>
  // → 영상 주소만 한 줄로 남긴다 ("토글" 단추 글자는 버림)
  const toLink = (src) => {
    const link = src ? embedLink(src, pageUrl) : null;
    return link ? `${NL}${escHtml(link)}${NL}` : ' ';
  };
  $x.find('.video_wrap').each((_, el) => {
    $(el).replaceWith(toLink($(el).find('iframe[src], embed[src]').first().attr('src')));
  });
  $x.find('iframe[src], embed[src]').each((_, el) => {
    $(el).replaceWith(toLink($(el).attr('src')));
  });
  $x.find('script, style, .best_reply_badge, .reply_yg_con_info, .video_toggle, img, video').remove();
  $x.find('.reply_nick').each((_, el) => {
    $(el).replaceWith(`${escHtml($(el).text().trim())} `);
  });
  // 와고콘 껍데기 <div class="tw:inline-block"><img><div 정보></div></div> 처럼 그림을 빼고 비어 버린 칸은
  // 블록 끝 줄바꿈을 만들지 않게 공백으로 (사이트 화면에서도 글과 같은 줄에 붙는 inline-block)
  $x.find('div, span').each((_, el) => {
    const $el = $(el);
    if (!$el.text().trim() && !$el.find('br').length) $el.replaceWith(' ');
  });
  $x.find('br').replaceWith(NL);
  $x.find('p, div, li').each((_, el) => {
    $(el).append(NL);
  });
  return $x
    .text()
    .replace(/[\s\u00a0]+/g, ' ')
    .replaceAll(NL, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u200b]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 댓글 li 의 댓글 번호 (.comment#reply_body_<게시판>_<번호>). 댓글이 아닌 li(광고 칸 등)는 undefined */
function commentIdOf($li) {
  const $c = $li.find('.body_wrap .comment').first();
  if (!$c.length) return undefined;
  return /_(\d+)$/.exec($c.attr('id') || '')?.[1] || null;
}

/** 댓글 li 하나 → Comment (댓글이 아니면 null) */
function parseCommentLi($, li, pageUrl, { best }) {
  const $li = $(li);
  const $c = $li.find('.body_wrap .comment').first();
  if (!$c.length) return null; // 광고 칸 등
  const id = commentIdOf($li);
  // 와고콘·댓글 짤(img), 혹시 움짤이 영상으로 바뀌어 오면 그 포스터(video[poster])
  const images = $c
    .find('img[src], video[poster]')
    .map((_, el) => absUrl($(el).attr($(el).is('video') ? 'poster' : 'src'), pageUrl))
    .get()
    .filter(Boolean);
  const text = commentText($, $c, pageUrl);
  if (!text && !images.length) return null;
  if (DELETED_RE.test(text) && !images.length) return null;
  const vote = (cls) => {
    const t = cleanText($li.find(`.vote_wrap .${cls}`).first().text());
    return /\d/.test(t) ? parseCount(t) : null;
  };
  return {
    id,
    comment: {
      author: cleanText($li.find('.profile_wrap .nick').first().text()) || null,
      text,
      likes: vote('vt_good'),
      dislikes: vote('vt_bad'),
      best: !!best,
      reply: !best && $li.hasClass('inner_reply'),
      postedAt: parseKoDate(cleanText($li.find('.profile_wrap .time').first().text())),
      images: [...new Set(images)],
    },
  };
}

/**
 * 글 HTML 안의 베스트 댓글 + 일반 댓글 (베스트와 겹치는 일반 댓글은 뺀다).
 * 일반 목록의 대댓글(li.inner_reply)은 부모 바로 뒤에 오는데, 부모가 베스트라 일반 목록에서 빠지면
 * 앞 댓글 밑에 엉뚱하게 붙어 보이므로 그 대댓글은 베스트 댓글 바로 뒤로 옮긴다 (etoland 와 같은 방식).
 */
function parseComments($, pageUrl) {
  const best = [];
  const bestIds = new Set();
  $('#best_reply_list_layer > li').each((_, li) => {
    const r = parseCommentLi($, li, pageUrl, { best: true });
    if (!r || (r.id && bestIds.has(r.id))) return;
    if (r.id) bestIds.add(r.id);
    best.push(r);
  });
  const normal = [];
  const repliesOfBest = new Map(); // 베스트 댓글 번호 → 그 아래 대댓글들
  let parentBestId = null; // 지금 이어지는 대댓글들의 부모가 베스트면 그 번호
  $('#reply_list_layer > li').each((_, li) => {
    const $li = $(li);
    const isReply = $li.hasClass('inner_reply');
    if (!isReply) {
      const pid = commentIdOf($li);
      if (pid !== undefined) parentBestId = pid && bestIds.has(pid) ? pid : null; // 광고 칸은 건너뜀
    }
    const r = parseCommentLi($, li, pageUrl, { best: false });
    if (!r) return;
    if (r.id && bestIds.has(r.id)) {
      // 베스트 목록 쪽 사본에는 대댓글의 "@닉" 이 빠져 있다 → 일반 목록 사본의 글로 바꿔 누구에게 한 말인지 남긴다
      const b = best.find((x) => x.id === r.id);
      if (b && r.comment.text) b.comment.text = r.comment.text;
      return;
    }
    if (isReply && parentBestId) {
      if (!repliesOfBest.has(parentBestId)) repliesOfBest.set(parentBestId, []);
      repliesOfBest.get(parentBestId).push(r.comment);
    } else normal.push(r.comment);
  });
  const out = [];
  for (const b of best) out.push(b.comment, ...((b.id && repliesOfBest.get(b.id)) || []));
  out.push(...normal);
  return out.slice(0, MAX_COMMENTS);
}

export default {
  id: 'ygosu',
  name: '와이고수 엽기자랑 (인기)',
  short: '와고',
  color: '#a85d0c',
  homepage: `${BASE}/board/${BOARD}/?best_article=Y`,
  domains: ['ygosu.com'],
  imageHosts: ['ygosu.com'], // storage2.ygosu.com(이미지·영상·썸네일), image.ygosu.com(아이콘)
  referer: `${BASE}/`,
  strictness: 'strict',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const p = Math.max(1, Number(page) || 1);
    const listUrl = `${BASE}/board/${BOARD}/?best_article=Y${p > 1 ? `&page=${p}` : ''}`;
    const { $, url } = await fetchHtml(listUrl, { referer: `${BASE}/` });
    const items = [];
    const seen = new Set();
    $('table.bd_list tr').each((_, tr) => {
      const $tr = $(tr);
      if ($tr.hasClass('notice') || $tr.find('img[alt="공지사항"], img[alt="광고"]').length) return;
      const $tit = $tr.find('td.tit').first();
      if (!$tit.length) return; // 광고 행 등
      const $a = $tit.find('a[href]').first();
      const href = absUrl($a.attr('href'), url) || '';
      const m = new RegExp(`/board/${BOARD}/(\\d+)`).exec(href);
      if (!m) return;
      const postId = m[1];
      if (seen.has(postId)) return;
      const title = cleanText($a.text()).replace(/\s*\[\d+\]\s*$/, '');
      if (!title || BOT_RE.test(title)) return;
      seen.add(postId);

      // 썸네일: 행 안의 storage*.ygosu.com 이미지 (칸 위치에 의존하지 않음. 등급/아이콘은 image.ygosu.com,
      // 글 이미지가 없으면 noimg 자리표시 → null)
      const thumbRaw = $tr
        .find('img[src]')
        .map((_, el) => $(el).attr('src'))
        .get()
        .find((s) => /^(?:https?:)?\/\/storage\d*\.ygosu\.com\//.test(s));
      const thumbnail = thumbRaw ? absUrl(thumbRaw, url) : null;
      const dateText = cleanText($tr.find('td.date').text());
      const likesText = cleanText($tr.find('td.vote').text());

      items.push({
        postId,
        title,
        url: postUrl(postId),
        author: cleanText($tr.find('td.name a').last().text()) || null,
        postedAt: guessPostedAt(dateText, thumbnail),
        commentCount: parseCount($tit.find('.reply_cnt').text()) ?? 0,
        views: parseCount($tr.find('td.read').text()),
        likes: /\d/.test(likesText) ? parseCount(likesText) : 0,
        category: null,
        nsfwHint: nsfwOf(title),
        thumbnail,
      });
    });
    return items;
  },

  async read(postUrlIn) {
    const { $, url } = await fetchHtml(postUrlIn, { referer: `${BASE}/board/${BOARD}/?best_article=Y` });
    const $body = $('#body_contain').first().clone();
    $body
      .find('script, style, noscript, ins, .ygosu_banner, [data-yg-ad-initial], [data-yg-banner-position], .filebox, .option')
      .remove();
    // 맨 앞의 빈 <ul></ul> 같은 빈 껍데기 정리
    $body.children('ul').each((_, el) => {
      if (!$(el).children().length && !cleanText($(el).text())) $(el).remove();
    });
    normalizeMedia($, $body, url);

    const $h3 = $('.board_top .tit h3').first().clone();
    $h3.find('em').remove();
    const title =
      cleanText($('meta[property="og:title"]').attr('content')) || cleanText($h3.text()).replace(/\s*\[\d+\]\s*$/, '');
    const dateText = cleanText($('.board_top .info .date').first().text());
    const dm = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/.exec(dateText);
    const postedAt = dm ? parseKoDate(dm[1]) : null;

    // 댓글 시각은 반올림된 상대 시각("10일 전" = 9.5~10.5일 전)뿐이라 지금-N일 로 바꾸면 글보다 앞설 수 있다
    // (예: 9.55일 전 글에 단 댓글이 "10일 전" → 글 작성 10시간 전). 글 작성 시각보다 이르면 글 시각으로 맞춘다.
    const comments = parseComments($, url);
    const postMs = postedAt ? Date.parse(postedAt) : NaN;
    if (Number.isFinite(postMs)) {
      for (const c of comments) if (c.postedAt && Date.parse(c.postedAt) < postMs) c.postedAt = postedAt;
    }

    return {
      title,
      html: ($body.html() || '').trim(),
      author: cleanText($('.board_top .nickname a').first().text()) || null,
      postedAt,
      nsfwHint: nsfwOf(title),
      comments,
      commentTotal: parseCount($('#reply_comment_cnt').first().text()),
    };
  },
};
