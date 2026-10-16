// 디시인사이드 실시간 베스트(dcbest) 어댑터.
//
// 목록: https://gall.dcinside.com/board/lists/?id=dcbest&_dcbest=<탭>&page=<n>  (50개/쪽, 최신순)
//   _dcbest 값은 사이트 list.js 의 탭 비트 합: 실베=1, 실베라이트=3, 실베나이트=5 (조합: 4=실베+라이트, 9=전부).
//   - 실베(1): 기본 탭. 뉴스 펌·정치·사건사고 비중이 큼.
//   - 실베라이트(3): "화제성은 덜하지만 가볍게 즐길 수 있는 콘텐츠" — 싱갤 썰/짤이 더 많음.
//   - 실베나이트(5): 전부 [ㅇㅎ] 말머리 그라비아·몸매짤. 쇼츠 소재가 아니라서 기본값에서 제외.
//   기본값은 4(실베+라이트). 잠금 게시판용 ㅇㅎ 글까지 받으려면 9 로 바꾸면 되고, 그 글들은 제목의 [ㅇㅎ] 로 nsfwHint 가 잡힌다.
// 행 구조: tr.ub-content[data-no][data-type=icon_btimebest|icon_lbtimebest], 제목 앞 <strong>[싱갤]</strong> 은 원본 갤러리 약칭.
//   공지(data-type=icon_notice, 번호칸 "공지")와 설문 행(data-no 없음)은 제외.
// 본문: .write_div. 이미지·움짤(mp4)·동영상은 dcimg*/dccdn*/dcm*.dcinside.co.kr 등에서 오며 Referer(gall.dcinside.com) 없으면 403.
//   이미지 응답은 Content-Type: application/octet-stream + Content-Disposition: attachment 이므로 프록시 쪽에서 형식 판별 필요.
// 첨부 동영상은 <iframe src="/board/movie/movie_view?no=N"> 로 들어오므로 그 페이지를 한 번 더 받아 <video> 로 바꾼다 (글당 최대 4개).
// 본문 이미지 원본: 본문 <img> 는 dcimg*.dcinside.co.kr/viewimage.php?id=…&no=… 인데, 원본 가로가 850px 를 넘으면
//   가로 850px 로 줄인(재압축한) 축소판이다. 그런 이미지에만 onclick="imgPop('https://image.dcinside.com/viewimagePop.php?no=<원본>')"
//   이 붙고, 그 팝업이 띄우는 https://image.dcinside.com/viewimage.php?id=&no=<원본> 이 원본 파일(= 첨부 download.php 와 같은 바이트)이다.
//   → 그 주소로 src 를 바꾼다. 예) 1280x720 PNG: 본문 850x478(150KB) → 원본 1280x720(626KB).
//   움짤은 <video data-src="gif"><source src="mp4"> 이고 mp4 는 GIF 와 같은 크기(850 이하)라 mp4 를 그대로 쓴다.
// 댓글: 본문 HTML 에는 없고 jQuery AJAX 로 따로 온다 (/_js/comment.js 의 viewComments).
//   POST https://gall.dcinside.com/board/comment/  (X-Requested-With: XMLHttpRequest, Referer: 글 주소, 글 페이지 쿠키)
//   폼: id, no, cmt_id, cmt_no(=id/no), e_s_n_o(글 페이지 hidden input), comment_page=<쪽>, sort=D(등록순), _GALLTYPE_(=G) …
//   응답 JSON {total_cnt, comments:[{no, name, ip, reg_date:"10.15 22:42:10", depth(0|1), del_yn, nicktype, memo, vr_player…}], pagination}
//   한 쪽에 댓글 100행(+ 광고성 "댓글돌이" nicktype=COMMENT_BOY 몇 개). 대댓글(depth 1, c_no=부모 번호)은 부모 바로 뒤에 온다.
//   쪽 번호는 끝에서부터 센다: 등록순으로 늘어선 전체 행을 뒤에서부터 100행씩 끊어 1쪽 = 가장 최근 100행, 마지막 쪽 = 가장 오래된 행
//   (실베 글은 원본 갤러리에서 복사된 댓글 copy_no 가 맨 앞). 사이트 기본 화면은 1쪽(최근 100행)이라 첫 줄에 부모 없는 답글이 올 수 있다.
//   → 우리는 글 머리부터 읽히도록 마지막 쪽(= #comment_cnt 로 계산)부터 받고, 100개가 안 차면 그 앞쪽(마지막-1)을 한 번 더 받는다 (요청 최대 2회).
//   범위를 넘는 쪽 번호는 빈 목록이 온다 (마지막 쪽으로 맞춰 주지 않음).
//   디시는 댓글 추천/비추천·베스트 댓글이 없다 → likes/dislikes 는 null, best 없음.
//   memo 는 HTML 조각: 일반 글은 텍스트(\n 줄바꿈, &#x..; 엔티티), 디시콘은 <img class="written_dccon" src="dcimg5.dcinside.com/dccon.php?no=…">
//   또는 움직이는 디시콘 <video class="written_dccon" data-src="(GIF)"><source src="(mp4)">. 디시콘 두 개짜리는 태그가 깨진 채 붙어 온다.
//   robots.txt: User-agent:* 는 Allow:/ 이고 /board/comment/ 는 금지 목록에 없다 (특정 갤러리의 /board/comment_view/ 만 금지).
import * as cheerio from 'cheerio';
import { fetchHtml, fetchJson } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://gall.dcinside.com';
const DCBEST_TABS = 4; // 1=실베, 3=라이트, 4=실베+라이트, 5=나이트(ㅇㅎ), 9=전부
const MAX_MOVIE_RESOLVE = 4;
const MAX_COMMENTS = 100;
const ORIGINAL_IMG = 'https://image.dcinside.com/viewimage.php?id=&no=';

// 사이트가 성인/후방 글에 붙이는 표기. 디시 실베나이트는 제목 앞 "[ㅇㅎ]" 말머리를 쓴다.
//  - 강한 표기(ㅇㅎ/약ㅇㅎ/약ㅎ/ㅎㅂ/약후/후방주의/므흣/은꼴/19금)는 괄호 안 어디에 있어도 잡는다:
//    [ㅇㅎ] (약후) [ㅇㅎ?] [약스압/ㅇㅎ] [ㅇㅎ 스압] 【ㅇㅎ】. 괄호 없이 제목 앞·공백 뒤 "ㅇㅎ) 제목", "약후 짤" 도.
//  - "후방"·"19" 는 오탐(후방 카메라, 뉴스 나이 표기 "A씨(19)", [U-19], [2019])이 많아
//    대괄호로 딱 감싼 [후방]/[19]/[스압/후방], 소괄호 (후방), 제목 맨 앞의 (19)·"후방)" 만 잡는다.
//  - "세후" 는 "실수령 300(세후)" 같은 급여 표기와 겹쳐 뺐다.
const HAN = '\\uAC00-\\uD7A3\\u3131-\\u318E';
const NSFW_STRONG = '(?:약\\s*ㅇㅎ|ㅇㅎ\\s*주의|ㅇㅎㅈㅇ|ㅇㅎ|약ㅎ|ㅎㅂ\\s*주의|ㅎㅂㅈㅇ|ㅎㅂ|약후|후방\\s*주의|므흣|은꼴|19금)';
const NOT_CLOSE = '[^\\])）】〕]';
const NSFW_SEP = '[/,·|+&]';
const NSFW_RE = new RegExp(
  [
    `[\\[(（【〔]${NOT_CLOSE}{0,15}?(?<![${HAN}\\w])${NSFW_STRONG}\\??(?![${HAN}\\w])${NOT_CLOSE}{0,15}[\\])）】〕]`,
    `[\\[【〔](?:${NOT_CLOSE}{0,15}${NSFW_SEP}\\s*)?(?:후방|19)\\s*\\??\\s*(?:${NSFW_SEP}${NOT_CLOSE}{0,15})?[\\]】〕]`,
    `[(（]\\s*후방\\s*\\??\\s*[)）]`,
    `^\\s*[(（]\\s*19\\s*[)）]`,
    `(?:^|\\s)(?:약\\s*ㅇㅎ|ㅇㅎ|약ㅎ|ㅎㅂ|약후)\\??(?=[\\s)\\]）】/:,.!~]|$)`,
    `^\\s*(?:후방|19)\\s*\\??\\s*[)\\]）】:]`,
    `후방\\s*주의|ㅇㅎ\\s*주의|(?<!\\d)19금|은꼴|므흣`,
  ].join('|'),
);

const postUrl = (no) => `${BASE}/board/view/?id=dcbest&no=${no}`;

function isNsfwTitle(title) {
  return NSFW_RE.test(String(title || ''));
}

/** 본문 안 첨부 동영상 iframe(movie_view)을 실제 <video> 로 바꾼다. */
async function resolveMovies($, $body, referer) {
  const frames = $body.find('iframe[src*="/board/movie/movie_view"]').toArray().slice(0, MAX_MOVIE_RESOLVE);
  for (const el of frames) {
    const $f = $(el);
    const src = absUrl($f.attr('src'), BASE);
    try {
      const { $: $m } = await fetchHtml(src, { referer, retries: 1 });
      const $v = $m('video.dc_mv, video').first();
      const mp4 = absUrl($v.find('source[src]').first().attr('src') || $v.attr('src'), src);
      if (!mp4) continue;
      const poster = absUrl($v.attr('poster'), src);
      const $video = $('<video controls playsinline preload="metadata"></video>').attr('src', mp4);
      if (poster) $video.attr('poster', poster);
      $f.replaceWith($video);
    } catch {
      // 못 받으면 iframe 을 그대로 두되 화면을 덮는 크기 지정만 정리
      $f.attr('style', 'width:100%;aspect-ratio:16/9;border:0');
    }
  }
  // 나머지(한도 초과) iframe 도 크기만 정리
  $body.find('iframe[src*="/board/movie/movie_view"]').attr('style', 'width:100%;aspect-ratio:16/9;border:0');
}

/**
 * 축소판(가로 850px)으로 보이는 본문 이미지를 원본 주소로 바꾼다 (tidyBody 가 onclick 을 지우기 전에 호출).
 * 지연로딩 이미지는 data-original 이 normalizeMedia 에서 src 를 덮어쓰므로 함께 지운다.
 */
function useOriginalImages($, $body) {
  $body.find('img[onclick*="viewimagePop.php"]').each((_, el) => {
    const $img = $(el);
    const no = /viewimagePop\.php\?(?:[^'"]*?&)?no=([^'"&\s)]+)/.exec($img.attr('onclick') || '')?.[1];
    if (!no) return;
    $img.attr('src', ORIGINAL_IMG + no);
    $img.removeAttr('data-original');
    $img.removeClass('lazy');
  });
}

/** HTML 엔티티가 섞인 짧은 글자 → 순수 텍스트 */
function decodeText(s) {
  if (s == null || s === '') return '';
  return cleanText(cheerio.load(`<i>${s}</i>`, null, false).root().text());
}

/**
 * 댓글 memo 안의 디시콘 주소들 (화면은 <img> 로 그리므로 움직이는 디시콘은 mp4 대신 data-src 의 GIF).
 * 같은 디시콘을 두 번 붙인 댓글은 사이트에도 두 개로 보이므로 중복을 없애지 않는다.
 */
function memoImages(memo) {
  const out = [];
  if (!/written_dccon/.test(memo)) return out;
  // 디시콘 두 개짜리는 '…data-dcconoverstatus="false"img class="written_dccon" src=…' 처럼 깨져 오므로 태그 단위로 잘라 본다
  for (const part of memo.split(/(?=<video\b|img\s+class=)/i)) {
    if (!/written_dccon/.test(part)) continue;
    const m = /^<video\b/i.test(part) ? /\bdata-src\s*=\s*"([^"]+)"/i.exec(part) : /\bsrc\s*=\s*"([^"]+)"/i.exec(part);
    const u = absUrl(m?.[1]?.replace(/&amp;/g, '&'), BASE);
    if (u) out.push(u);
  }
  return out;
}

/** 댓글 memo(HTML 조각) → 순수 텍스트. 줄바꿈 유지, 디시콘·광고 버튼 제거, 앱 서명 "- dc App" 제거. */
function memoText(memo) {
  const $m = cheerio.load(`<div id="m">${String(memo || '').replace(/\r\n?/g, '\n')}</div>`, null, false);
  const $r = $m('#m');
  $r.find('script, style, img, video, source, button, .coment_dccon_info, .dccon_over_box').remove();
  // 글자콘(.coment_dccon_txt > .txtcon_txt): 글자는 .txtcon_txt 에 있고, 폰트 계산용 span.txtcon_meas 가
  // 그 글자를 감싸거나 따로 붙는다 → 측정용 span 밖에 글자가 있으면 그것만, 없으면 span 안쪽을 쓴다 (중복 방지)
  $r.find('.coment_dccon_txt').each((_, el) => {
    const $t = $m(el);
    const $txt = $t.find('.txtcon_txt').first();
    if (!$txt.length) return;
    const $outside = $txt.clone();
    $outside.find('.txtcon_meas').remove();
    const $use = cleanText($outside.text()) ? $outside : $txt.find('.txtcon_meas').first().clone();
    $t.replaceWith($m('<div></div>').append($use.contents()));
  });
  $r.find('br').replaceWith('\n');
  $r.find('p, div, li').each((_, el) => {
    $m(el).append('\n');
  });
  return $r
    .text()
    .replace(/[ \t\u00a0\u200b]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\s*-\s*dc\s+(?:official\s+)?app$/i, '')
    .trim();
}

const DELETED_RE = /^(?:\S+에 의해\s*)?(?:삭제된 댓글입니다|해당 댓글은 삭제되었습니다|삭제된 답글입니다)\.?$/;

/**
 * /board/comment/ 응답의 comments 배열(여러 쪽을 등록순으로 이어 붙인 것) → Comment[] (사이트 순서, 대댓글은 부모 뒤).
 * 부모가 빠진 답글(부모가 삭제됐거나 앞쪽에 있어 못 받은 경우)은 reply 표시를 하지 않는다 —
 * 화면이 답글을 바로 위 댓글 밑에 들여 그리므로, 그대로 두면 엉뚱한 댓글에 단 답글처럼 보인다.
 */
function parseComments(list) {
  const out = [];
  const kept = new Set(); // 결과에 들어간 원댓글 번호
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.nicktype === 'COMMENT_BOY' || !Number(c.no)) continue; // 댓글돌이(광고·다른 글 추천)
    if (c.del_yn === 'Y' || (c.is_delete != null && String(c.is_delete) !== '0')) continue;
    const memo = String(c.memo ?? '');
    const images = memoImages(memo);
    let text = memoText(memo);
    if (DELETED_RE.test(text)) continue;
    if (!text && !images.length && c.vr_player) text = '(보이스 댓글)';
    if (!text && !images.length) continue;
    const isReply = Number(c.depth) > 0;
    if (!isReply) kept.add(String(c.no));
    const nick = decodeText(c.name);
    out.push({
      author: nick ? `${nick}${c.ip ? `(${c.ip})` : ''}` : null,
      text,
      likes: null,
      dislikes: null,
      reply: isReply && kept.has(String(c.c_no)),
      postedAt: parseKoDate(c.reg_date),
      images,
    });
    if (out.length >= MAX_COMMENTS) break;
  }
  return out;
}

/** 응답 pagination HTML 에 보이는 가장 큰 쪽 번호 (현재 쪽 <em>n</em> 과 viewComments(n, …) 링크) */
function maxCommentPage(data) {
  const p = String(data?.pagination || '');
  let max = 0;
  for (const m of p.matchAll(/viewComments\(\s*(\d+)|<em>\s*(\d+)\s*<\/em>/g)) max = Math.max(max, Number(m[1] || m[2]));
  return max;
}

/** 실제 댓글 행 수 (댓글돌이 제외) */
const realRows = (data) => (Array.isArray(data?.comments) ? data.comments.filter((c) => c && c.nicktype !== 'COMMENT_BOY' && Number(c.no)) : []);

/**
 * 글 머리부터 댓글을 최대 100개 받는다 (추가 요청 최대 2회).
 * 쪽 번호가 끝에서부터라 #comment_cnt 로 마지막 쪽(가장 오래된 행)을 계산해 받고,
 * 100개가 안 차면 그 앞쪽을 받아 등록순으로 이어 붙인다. 글 페이지 숫자가 어긋나면 응답의 쪽 목록으로 바로잡는다.
 * @returns {Promise<{list: object[], total: number|null}|null>}
 */
async function fetchComments($, pageText, viewUrl, count) {
  const last = count > 0 ? Math.ceil(count / 100) : 1;
  const first = await fetchCommentPage($, pageText, viewUrl, last);
  if (!first) return null;
  let total = parseCount(first.total_cnt);
  let rows = realRows(first);
  let more = null; // 이어 붙일 다음 쪽 (등록순으로 뒤)
  const maxPage = maxCommentPage(first);
  // 두 번째 요청은 실패해도 첫 응답은 살린다
  const second = (page) => fetchCommentPage($, pageText, viewUrl, page).catch(() => null);
  if (!rows.length && last > 1) {
    // 글 페이지 숫자가 실제보다 커서 범위를 넘은 경우 → 사이트 기본(1쪽)으로
    const d = await second(1);
    rows = realRows(d);
    total = parseCount(d?.total_cnt) ?? total;
  } else if (rows.length && maxPage > last) {
    // 실제 마지막 쪽이 더 뒤에 있음 (삭제된 댓글 자리 등으로 행이 더 많음) → 그쪽이 더 오래된 행
    const older = realRows(await second(maxPage));
    if (older.length) {
      if (maxPage === last + 1) more = rows;
      rows = older;
    }
  } else if (last > 1 && rows.length < MAX_COMMENTS) {
    const d = await second(last - 1);
    more = realRows(d);
    total = parseCount(d?.total_cnt) ?? total;
  }
  // 두 요청 사이에 새 댓글이 달리면 쪽 경계가 밀려 겹칠 수 있다 → 번호로 중복 제거
  const seen = new Set();
  const list = [...rows, ...(more || [])].filter((c) => !seen.has(String(c.no)) && seen.add(String(c.no)));
  return { list, total };
}

/** 글 페이지의 hidden input 으로 댓글 한 쪽(등록순 정렬 sort=D)을 요청한다. */
async function fetchCommentPage($, pageText, viewUrl, page) {
  const gallId = $('#gallery_id').val() || 'dcbest';
  const no = $('#no').val() || /[?&]no=(\d+)/.exec(viewUrl)?.[1];
  const esno = $('#e_s_n_o').val();
  if (!no || !esno) return null;
  const galltype = /_GALLERY_TYPE_\s*=\s*["'](\w+)["']/.exec(pageText)?.[1] || $('input#_GALLTYPE_').first().val() || 'G';
  const form = new URLSearchParams({
    id: gallId,
    no,
    cmt_id: gallId,
    cmt_no: no,
    focus_cno: '',
    focus_pno: '',
    e_s_n_o: esno,
    comment_page: String(page || 1),
    sort: 'D',
    prevCnt: '',
    board_type: '',
    _GALLTYPE_: galltype,
    secret_article_key: $('#secret_article_key').val() || '',
    clean: '',
    nptest: '',
  });
  return fetchJson(`${BASE}/board/comment/`, {
    method: 'POST',
    body: form.toString(),
    referer: viewUrl,
    retries: 1,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      origin: BASE,
    },
  });
}

/** 디시 본문 특유의 잡음 정리 (normalizeMedia 전에 호출) */
function tidyBody($, $body) {
  $body.find('script, style, noscript').remove();
  // 모바일 앱 서명 "- dc official App" (span#dcappfooter) 과 그 껍데기 div
  $body.find('#dcappfooter, .dcappfooter').each((_, el) => {
    const $p = $(el).parent();
    $(el).remove();
    if ($p.is('div,p') && !$p.children().length && !cleanText($p.text())) $p.remove();
  });
  $body.find('span, p, div').each((_, el) => {
    const $e = $(el);
    if (!$e.children().length && /^-?\s*dc\s*(official\s*)?app$/i.test(cleanText($e.text()))) $e.remove();
  });
  // 움짤: <video data-src="gif"><source src="mp4"></video> → video src 를 mp4 로 (data-src 는 gif 대체본)
  $body.find('video').each((_, el) => {
    const $v = $(el);
    const mp4 = $v.find('source[src]').first().attr('src');
    if (mp4) {
      $v.attr('src', mp4);
      $v.removeAttr('data-src');
    }
  });
  // 유튜브는 <embed src="https://www.youtube.com/embed/ID"> 로 들어온다 → 표준 iframe 으로
  $body.find('embed[src], object embed[src]').each((_, el) => {
    const $e = $(el);
    const src = absUrl($e.attr('src'), BASE) || '';
    const yt = /youtube(?:-nocookie)?\.com\/(?:embed|v)\/([\w-]{6,})/.exec(src)?.[1];
    if (yt) {
      $e.replaceWith(
        $('<iframe frameborder="0" allowfullscreen allow="encrypted-media; picture-in-picture"></iframe>')
          .attr('src', `https://www.youtube.com/embed/${yt}`)
          .attr('style', 'width:100%;aspect-ratio:16/9;border:0'),
      );
    } else if ($e.parent().is('object')) {
      $e.parent().remove();
    } else {
      $e.remove();
    }
  });
  // 외부 링크 미리보기 카드(.og-div): 외부 호스트 썸네일(뉴스사 등)과 기사 요약문이 섞이므로
  // 카드는 지우고, 바로 위 URL 링크(a.lnk)의 글자를 기사 제목으로 바꾼다 (없으면 제목 링크 하나만 남김).
  $body.find('.og-div').each((_, el) => {
    const $og = $(el);
    const href = $og.find('a.og-wrap, a[href]').first().attr('href');
    const ogTitle = cleanText($og.find('.og-tit').first().text());
    const $lnk = href ? $body.find('a.lnk').filter((__, a) => $(a).attr('href') === href).first() : $();
    if ($lnk.length) {
      if (ogTitle) $lnk.text(ogTitle);
      $og.remove();
    } else if (href) {
      $og.replaceWith($('<p></p>').append($('<a target="_blank" rel="noopener"></a>').attr('href', href).text(ogTitle || href)));
    } else {
      $og.remove();
    }
  });
  // javascript: 링크(imgPop 등)는 껍데기만 벗긴다
  $body.find('a[href^="javascript"]').each((_, el) => {
    const $a = $(el);
    $a.replaceWith($a.contents());
  });
  // 인라인 이벤트 핸들러와 해시 alt 제거
  $body.find('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
    const alt = $(el).attr('alt');
    if (alt && /^[0-9a-f]{16,}$/i.test(alt)) $(el).attr('alt', '');
  });
}

export default {
  id: 'dcinside',
  name: '디시인사이드 실시간 베스트',
  short: '디시',
  color: '#3b4890',
  homepage: `${BASE}/board/lists/?id=dcbest`,
  domains: ['dcinside.com'],
  // dcimg*.dcinside.co.kr(본문), dccdn*.dcinside.co.kr(썸네일), dcm*.dcinside.co.kr(동영상),
  // image.dcinside.com(본문 원본 이미지 viewimage.php?id=&no=), dcimg*.dcinside.com(디시콘 dccon.php — 본문·댓글),
  // nstatic.dcinside.com(정적)
  imageHosts: ['dcinside.co.kr', 'dcinside.com'],
  referer: `${BASE}/`,
  strictness: 'strict',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const listUrl = `${BASE}/board/lists/?id=dcbest&_dcbest=${DCBEST_TABS}&page=${page}`;
    const { $, url } = await fetchHtml(listUrl, { referer: `${BASE}/` });
    const items = [];
    const seen = new Set();
    $('table.gall_list tbody tr.ub-content').each((_, tr) => {
      const $tr = $(tr);
      const type = $tr.attr('data-type') || '';
      const num = cleanText($tr.find('td.gall_num').text());
      const no = $tr.attr('data-no') || '';
      // 공지·설문·광고·이슈 행: 번호칸이 숫자가 아니거나 data-type 이 notice
      if (!/^\d+$/.test(no) || !/^\d+$/.test(num) || /notice/i.test(type)) return;
      if (seen.has(no)) return;

      const $a = $tr.find('td.gall_tit a').not('.reply_numbox').first();
      const href = absUrl($a.attr('href'), url);
      if (!href || !/[?&]no=\d+/.test(href)) return;

      const $t = $a.clone();
      const gallTag = cleanText($t.find('strong').first().text()).replace(/^\[|\]$/g, '');
      $t.find('.thumimg, em, strong').remove();
      const title = cleanText($t.text()).replace(/\s*\[\d+(?:\/\d+)?\]\s*$/, '');
      if (!title) return;
      seen.add(no);

      const $w = $tr.find('td.gall_writer');
      const dateTitle = $tr.find('td.gall_date').attr('title') || $tr.find('td.gall_date').text();
      const thumb = $tr.find('.thumimg img').attr('src');

      items.push({
        postId: no,
        title,
        url: postUrl(no),
        author: cleanText($w.attr('data-nick') || $w.find('.nickname').attr('title') || '') || null,
        postedAt: parseKoDate(dateTitle),
        commentCount: parseCount($tr.find('.reply_num').first().text()) ?? 0,
        views: parseCount($tr.find('td.gall_count').text()),
        likes: parseCount($tr.find('td.gall_recommend').text()),
        category: gallTag || null,
        nsfwHint: isNsfwTitle(title),
        thumbnail: thumb ? absUrl(thumb, url) : null,
      });
    });
    return items;
  },

  async read(inputUrl) {
    // 어떤 형태로 와도 정규화된 글 주소로 받는다
    const no = /[?&]no=(\d+)/.exec(inputUrl || '')?.[1];
    const target = no && /[?&]id=dcbest\b/.test(inputUrl) ? postUrl(no) : inputUrl;
    const { $, url, text: pageText } = await fetchHtml(target, { referer: `${BASE}/board/lists/?id=dcbest` });

    const $body = $('.writing_view_box .write_div').first().length
      ? $('.writing_view_box .write_div').first()
      : $('.write_div').first();
    if (!$body.length) {
      const msg = cleanText(/alert\(['"]([^'"]+)['"]\)/.exec($.html())?.[1] || '');
      throw new Error(`본문을 찾지 못함${msg ? ` (${msg})` : ''} — 삭제되었거나 접근 불가: ${target}`);
    }

    const $head = $('.gallview_head').first();
    const headtext = cleanText($head.find('.title_headtext').first().text());
    const subject = cleanText($head.find('.title_subject').first().text());
    const title =
      cleanText([headtext, subject].filter(Boolean).join(' ')) ||
      cleanText(($('meta[property="og:title"]').attr('content') || '').replace(/\s*-\s*실시간 베스트 갤러리\s*$/, ''));
    const $w = $head.find('.gall_writer').first();
    const dateTitle = $head.find('.gall_date').first().attr('title') || $head.find('.gall_date').first().text();

    useOriginalImages($, $body);
    tidyBody($, $body);
    await resolveMovies($, $body, url);
    normalizeMedia($, $body, url);
    // 지연로딩 흔적 정리 (src 로 옮겨졌으므로)
    $body.find('img[data-original]').removeAttr('data-original');
    $body.find('img.lazy').removeClass('lazy');
    // 고정 크기 속성은 지운다 (화면 CSS 가 max-width:100%·height:auto 로 맞춤 — 원본보다 작은 값이 박혀 있으면 작게/잘려 보임)
    $body.find('img, video').removeAttr('width').removeAttr('height');

    // 댓글 (AJAX 1~2회, 글 머리부터 최대 100개). 실패해도 본문은 돌려준다.
    let commentTotal = parseCount($('#comment_cnt').val());
    let comments = [];
    if (commentTotal !== 0) {
      try {
        const got = await fetchComments($, pageText, url, commentTotal);
        if (got) {
          comments = parseComments(got.list);
          commentTotal = got.total ?? commentTotal;
        }
      } catch {
        // 댓글만 못 가져온 경우 — comments 는 빈 배열, commentTotal 은 글 페이지 값
      }
    }

    return {
      title,
      html: ($body.html() || '').trim(),
      author: cleanText($w.attr('data-nick') || '') || null,
      postedAt: parseKoDate(dateTitle),
      nsfwHint: isNsfwTitle(title),
      comments,
      commentTotal: commentTotal ?? null,
    };
  },
};
