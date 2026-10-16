// 웃긴대학(웃대) 웃긴자료(pds) — "오늘의 베스트" 정렬.
// - 웃긴자료는 대기자료(pdswait)에서 추천을 받아 올라온 글만 모이는 게시판이고,
//   st=day 는 그중 최근 하루 글을 추천순으로 보여준다 (20개/페이지, pg 는 0부터).
// - 문자셋 EUC-KR (meta 태그) → fetchHtml 이 자동 디코딩.
// - 목록 날짜(w_date/w_time)는 웃긴자료로 "이동된 시각", 본문의 "작성시간"은 원래 작성 시각.
// - 이미지/영상은 down.humoruniv.com / down-webp.humoruniv.com / timg.humoruniv.com.
//   Referer 없음 또는 humoruniv.com Referer 는 200/206, 외부 Referer 는 cdn.humoruniv.com 으로 302(영상은 403).
//   down-webp 변환본은 원본과 가로x세로가 같다(재압축만). timg thumb.php?url=원본?SIZE=.. 는 원본으로 302.
//   영상 포스터(timg thumb.php?url_enc=..)는 글 페이지에서 받은 쿠키가 있어야 실제 프레임을 주고, 없으면 140x100 TV 아이콘을 준다
//   (서버는 http.js 쿠키 저장소를 공유하므로 read() 뒤 프록시 요청엔 쿠키가 붙는다).
// - 댓글("답글")은 글 HTML 안에 전부 들어 있다 (AJAX 없음, 100개 넘어도 한 페이지). 추가 요청 0회.
//   "답글 베스트" 표(#cmt_best_comm_table) + "답글마당 (N)" 일반 목록(tr#comment_span_<번호>, 대댓글은 2단 행).
//   댓글 쓰기·추천은 /*.php (robots.txt 금지) 지만 우리는 읽기만 하므로 쓰지 않는다.
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.humoruniv.com';
const BOARD = `${BASE}/board/humor`;
const TABLE = 'pds';
const SORT = 'day'; // 오늘의 베스트

// 목록에는 성인/후방 표시(아이콘·말머리·클래스)가 없어 목록 단계에서는 제목 표기로만 판단한다.
// 본문에서는 사이트 AI(웃파고)가 선정적이라고 본 이미지를 "너굴맨"(racy_show_/racy_hidden_)으로 가려 두는데,
// 이게 사이트 자체의 후방 표시이므로 read() 에서 nsfwHint 로 올린다 (AI 판정이라 오탐도 있음).
const NSFW_RE =
  /후방(?!\s*(?:카메라|센서|추돌|경고음|경고등|부대|지원))|ㅎㅂ|약후|약ㅎ|약\s*ㅇㅎ|ㅇㅎ\s*주의|므흣|19금|야짤|[([]\s*(?:19|ㅇㅎ|후)\s*[)\]]|(?:^|[\s([])ㅇㅎ\s*[)\]]|^\s*ㅇㅎ(?:[\s.]|$)|^\s*19\s*[)\]]|노출\s*주의|세미\s*누드/;

const isNsfw = (title) => NSFW_RE.test(title || '');

const postUrl = (no) => `${BOARD}/read.html?table=${TABLE}&number=${no}`;

/**
 * 웃대 영상 플레이어 호출의 인자.
 * comment_mp4_expand(id, url, thumb_url, div_width, img_width, css, ext, hu_size, url_ori, gif_size)
 *  - 일반 영상: ext 'MP4', url_ori ''
 *  - 움짤(GIF → mp4 변환, down-mp4.humoruniv.com): ext '' 이고 url_ori 가 원본 .gif
 */
function parseMp4Call(onclick) {
  const m = /comment_mp4_expand\(([^)]*)\)/.exec(onclick || '');
  if (!m) return null;
  const args = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  if (!args[1]) return null;
  const ext = (args[6] || '').toUpperCase();
  const ori = args[8] || null;
  return { url: args[1], poster: args[2] || null, ext, ori, gif: ext === 'GIF' || /\.gif(?:$|\?)/i.test(ori || '') };
}

/** comment_thumb_expand(id, 원본url, thumb_url, ...) — 큰 GIF·긴 이미지를 썸네일로 보여 주다 클릭하면 원본으로 펼친다 */
function parseThumbExpand(href) {
  const m = /comment_thumb_expand\(([^)]*)\)/.exec(href || '');
  if (!m) return null;
  const args = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return args[1] ? { url: args[1], thumb: args[2] || null } : null;
}

/** #wrap_copy 안의 첨부 영역 + 본문을 정리. → { $body, racy(너굴맨으로 가려진 블록 수) } */
function cleanBody($, $body, baseUrl) {
  // 너굴맨(AI 히든 처리): 안내 그림·버튼("이미지 보기 (=너굴맨 클릭)", "너굴맨 설정")은 버리고,
  // display:none 으로 숨겨 둔 실제 이미지는 꺼내 둔다. 가려진 개수는 nsfwHint 판단에 쓴다.
  const racy = $body.find('[id^="racy_hidden_"]').length;
  $body.find('[id^="racy_show_"]').remove();
  $body.find('[id^="racy_hidden_"]').each((_, el) => {
    $(el).replaceWith($(el).contents());
  });

  $body.find('script, style, noscript, link, form, input, button').remove();
  // 이미지 로딩 진행바(placeholder) 제거
  $body.find('[id^="timg_prog_"]').remove();
  $body.find('img[src*="loading_bar"]').remove();
  // 영상 썸네일 위의 "MP4" 꼬리표·재생 버튼 이미지
  $body.find('.comment_thumb_notice, [id^="play_trans_img_div_"]').remove();

  // 클릭해야 재생되는 영상 → <video>
  $body.find('[onclick*="comment_mp4_expand"]').each((_, el) => {
    const $el = $(el);
    const info = parseMp4Call($el.attr('onclick'));
    if (!info) return;
    const src = absUrl(info.url, baseUrl);
    if (!src) return;
    const $video = $('<video></video>').attr({ src, controls: '', preload: 'metadata', playsinline: '' });
    const poster = absUrl(info.poster, baseUrl);
    // 움짤(GIF→mp4)의 포스터 thumb.php?url=원본.gif 는 수 MB 짜리 원본 GIF 로 302 되므로 붙이지 않는다 (자동재생이라 필요 없음)
    if (poster && !(info.gif && /thumb\.php\?url=/i.test(poster))) $video.attr('poster', poster);
    // 움짤은 사이트처럼 자동재생·반복 (클릭해야 움직이는 첫 프레임 그림이 되지 않도록)
    if (info.gif) $video.attr({ autoplay: '', loop: '', muted: '' });
    const $wrap = $el.closest('[id^="comment_file_"]');
    ($wrap.length ? $wrap : $el).replaceWith($video);
  });

  // 큰 GIF·긴 이미지: 썸네일 + "클릭하면 펼치기"(comment_thumb_expand) → 원본을 바로 보여 준다
  $body.find('a[href*="comment_thumb_expand("]').each((_, el) => {
    const $a = $(el);
    const info = parseThumbExpand($a.attr('href'));
    const $img = $a.find('img').first();
    // width 는 썸네일 칸 폭(400)이라 원본에는 맞지 않으니 지운다
    if (info && $img.length) $img.attr('src', info.url).removeAttr('img_file_url').removeAttr('width').removeAttr('height');
    $a.replaceWith($a.contents());
  });

  // 웹프 변환본(down-webp, 원본과 같은 크기)이 기본 src. 원본이 GIF 면 움직임 보존을 위해 원본으로.
  // src 가 timg 리사이즈(thumb.php?url=원본?SIZE=원본크기)면 어차피 http:// 원본으로 302 되므로 원본을 바로 쓴다.
  // 너무 긴 이미지는 사이트가 여러 조각(src 에 "DOUBLE")으로 나눠 보여 주는데, 사이트의 "원본 모두 보기"(expand_all)처럼
  // 같은 원본의 첫 조각만 원본으로 바꾸고 나머지 조각은 지운다 (조각마다 원본이 반복되거나 잘린 조각만 남지 않도록).
  const doubleSeen = new Set();
  $body.find('img[img_file_url]').each((_, el) => {
    const $img = $(el);
    const ori = $img.attr('img_file_url');
    const src = $img.attr('src') || '';
    $img.removeAttr('img_file_url');
    if (ori && /DOUBLE/.test(src)) {
      if (doubleSeen.has(ori)) {
        const $a = $img.parent('a');
        ($a.length && $a.find('img').length === 1 ? $a : $img).remove();
        return;
      }
      doubleSeen.add(ori);
      $img.attr('src', ori);
      return;
    }
    if (ori && (/\.gif(?:$|\?)/i.test(ori) || /timg\.humoruniv\.com\/thumb\.php/i.test(src))) $img.attr('src', ori);
  });

  // width='100%' height='' (사이트는 style max-width:870px 와 함께 씀) — style 이 지워지면 작은 그림이 화면 폭으로 늘어나므로
  // 퍼센트/빈 값 크기 속성은 지운다. 숫자 크기(hu_f_img 600x693 등)는 실제 파일 크기와 같아 그대로 둔다.
  $body.find('img').each((_, el) => {
    const $img = $(el);
    for (const a of ['width', 'height']) {
      const v = $img.attr(a);
      if (v !== undefined && !/^\s*\d+\s*$/.test(v)) $img.removeAttr(a);
    }
  });

  // 인라인 이벤트 핸들러·불필요 속성 제거
  $body.find('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name) || /^file_size_/i.test(name) || name === 'info') $(el).removeAttr(name);
    }
  });

  // HTML 주석(<!--EAP_CONTENT--> 등) 제거
  $body
    .find('*')
    .addBack()
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();

  normalizeMedia($, $body, baseUrl);
  return { $body, racy };
}

// ---- 댓글 ----
const MAX_COMMENTS = 100;
const DELETED_RE = /^\(?\s*삭제(?:된\s*(?:답글|댓글)\s*입니다|되었습니다)\.?\s*\)?$/;
const BR = String.fromCharCode(0xe000); // <br> 자리표시 (사용자 영역 문자, 공백 정리 뒤 \n 으로)
const BR_RE = new RegExp(` ?${BR} ?`, 'g');
const ZWSP_RE = new RegExp(String.fromCharCode(0x200b), 'g'); // \s 에 안 들어가는 폭 없는 공백
// 빈 칸처럼 보이는 한글 채움 문자(U+3164 등)·점자 빈칸 — 짤만 올리면서 글자 칸을 이걸로 채우는 경우가 많다 (실측: 1428947 의 짤 댓글 글자가 U+3164 하나뿐). 공백으로 본다.
const FILLER_RE = new RegExp(`[${[0x115f, 0x1160, 0x3164, 0xffa0, 0x2800].map((c) => String.fromCharCode(c)).join('')}]`, 'g');

/** 댓글 본문(div.comment_more) → 순수 텍스트. 사이트 CSS 가 white-space:normal 이라 줄바꿈은 <br> 만 */
function commentText($, $el) {
  if (!$el.length) return '';
  const $c = $el.clone();
  $c.find('script, style').remove();
  $c.find('br').replaceWith(BR);
  return $c
    .text()
    .replace(ZWSP_RE, '')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ') // \s 는 nbsp·BOM 포함
    .replace(BR_RE, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 댓글 첨부(짤·움짤·영상) → 절대 URL 목록. 축소판 대신 원본(같은 그림)을, 영상은 포스터, GIF→mp4 는 원본 GIF */
function commentImages($, $td, baseUrl) {
  const out = [];
  const add = (u) => {
    const abs = absUrl(u, baseUrl);
    if (abs && !out.includes(abs)) out.push(abs);
  };
  const $s = $td.clone();
  // 사이트 AI 가 선정적이라고 가린(너굴맨) 댓글 짤은 넣지 않는다
  $s.find('[id^="racy_show_"], [id^="racy_hidden_"]').remove();
  $s.find('.comment_more, .comment_more_btn').remove();
  $s.find('[onclick*="comment_mp4_expand"]').each((_, el) => {
    const info = parseMp4Call($(el).attr('onclick'));
    if (info) add(info.gif && info.ori ? info.ori : info.poster);
    $(el).remove();
  });
  $s.find('a[href*="comment_thumb_expand("]').each((_, el) => {
    const info = parseThumbExpand($(el).attr('href'));
    if (info) add(info.url);
    $(el).remove();
  });
  $s.find('img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    if (!src || /^\/images\//.test(src) || $img.hasClass('hu_icon') || /loading_bar|play_trans/.test(src)) return;
    const href = $img.closest('a[href]').attr('href') || '';
    const linkOri = /^(?:https?:)?\/\/[^/]*humoruniv\.com\/[^?#]+\.(?:jpe?g|png|gif|webp|bmp)$/i.test(href) ? href : null;
    add($img.attr('img_file_url') || linkOri || src);
  });
  return out;
}

/** "2026-10-15 <bThu, ...>22:44:49" / "2026-10-15<br>22:44" → ISO */
function commentDate($el) {
  const m = /(\d{4}-\d{2}-\d{2})\s*(\d{1,2}:\d{2}(?::\d{2})?)?/.exec(cleanText($el.text()));
  return m ? parseKoDate(`${m[1]} ${m[2] || ''}`.trim()) : null;
}

/** 답글 행(일반 목록 tr#comment_span_N 또는 베스트 표의 행) 하나. 열: [아이콘|↳, 닉, 본문+첨부, 추천/반대, 메뉴, 날짜] */
function parseCommentRow($, $tr, baseUrl) {
  const $tds = $tr.children('td');
  const $content = $tds.eq(2);
  const $text = $content.find('.comment_more').first().clone();
  $text.find('span[style*="green"]').remove(); // 베스트 표의 "[2]"(대댓글 수)
  return {
    author: cleanText($tds.eq(1).find('.hu_nick_txt').first().text()) || null,
    text: commentText($, $text),
    likes: parseCount($tr.find('[id^="comm_ok_div_"], [id^="top_comm_ok_div_"]').first().text()),
    dislikes: parseCount($tr.find('.list_no').first().text()),
    reply: $tds.eq(0).find('img[src*="blt_cmt_re"]').length > 0,
    postedAt: commentDate($tr.find('.list_date').first()),
    images: commentImages($, $content, baseUrl),
  };
}

/** 글 페이지 HTML 안의 댓글 → { comments, commentTotal } */
function parseComments($, baseUrl) {
  // 일반 목록 (사이트 순서, 삭제된 답글은 comment_span id 가 없는 별도 행이라 자연히 빠진다).
  // 대댓글(2단)은 원댓글(1단) 바로 뒤에 이어 나오므로 직전 1단 행을 부모로 기억해 둔다.
  const normal = [];
  const byId = new Map();
  let parent = null;
  $('tr[id^="comment_span_"]').each((_, tr) => {
    const id = /(\d+)$/.exec($(tr).attr('id') || '')?.[1];
    if (!id || byId.has(id)) return;
    const c = parseCommentRow($, $(tr), baseUrl);
    if (!c.reply) parent = id;
    byId.set(id, c);
    normal.push({ id, c, parent: c.reply ? parent : null });
  });

  // 답글 베스트 (베스트 댓글 + 그 아래 베스트 대댓글). 같은 댓글이 일반 목록에 있으면 그쪽 내용을 쓰고 일반 목록에서는 뺀다.
  const best = [];
  const bestIds = new Set();
  $('#cmt_best_comm_table [id^="top_comm_ok_div_"]').each((_, el) => {
    const id = /(\d+)$/.exec($(el).attr('id') || '')?.[1];
    if (!id || bestIds.has(id)) return;
    bestIds.add(id);
    const c = byId.get(id) || parseCommentRow($, $(el).closest('tr'), baseUrl);
    best.push({ id, c: { ...c, best: true } });
  });

  // 원댓글이 베스트로 올라가 일반 목록에서 빠지면, 그 밑의 나머지 대댓글이 화면(app.js 의 평평한 목록)에서
  // 바로 앞의 엉뚱한 댓글에 달린 것처럼 보인다 (실측: 1428947 의 87개 중 16개, 1428914 의 85개 중 33개).
  // → 그런 대댓글은 그 베스트 댓글(과 베스트 대댓글) 바로 뒤로 옮긴다 (ygosu·etoland·bobaedream 과 같은 방식).
  const topBest = new Set(best.filter((b) => !b.c.reply).map((b) => b.id));
  const movedOf = new Map(); // 베스트 원댓글 번호 → 옮길 대댓글들 (사이트 순서)
  const rest = [];
  for (const x of normal) {
    if (bestIds.has(x.id)) continue;
    const c = { ...x.c, best: false };
    if (x.parent && topBest.has(x.parent)) {
      if (!movedOf.has(x.parent)) movedOf.set(x.parent, []);
      movedOf.get(x.parent).push(c);
    } else rest.push(c);
  }
  const ordered = [];
  let top = null;
  const flush = () => top && ordered.push(...(movedOf.get(top) || []));
  for (const b of best) {
    if (!b.c.reply) {
      flush();
      top = b.id;
    }
    ordered.push(b.c);
  }
  flush();
  ordered.push(...rest);

  const comments = [];
  for (const c of ordered) {
    if (DELETED_RE.test(c.text)) c.text = '';
    if (!c.text && !c.images.length) continue;
    comments.push(c);
    if (comments.length >= MAX_COMMENTS) break;
  }

  const head = cleanText($('#cmt_hd_new .cmt_hd_txt').first().text()); // "답글마당 (54)"
  const total = /\((\d[\d,]*)\)/.exec(head)?.[1];
  return { comments, commentTotal: total ? parseCount(total) : normal.length || null };
}

export default {
  id: 'humoruniv',
  name: '웃긴대학 웃긴자료',
  short: '웃대',
  color: '#c2410c',
  homepage: `${BOARD}/list.html?table=${TABLE}&st=${SORT}`,
  domains: ['humoruniv.com'],
  imageHosts: ['humoruniv.com'], // down / down-webp / timg / cdn / icon-neo .humoruniv.com
  referer: `${BASE}/`,
  strictness: 'normal',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const pg = Math.max(0, (Number(page) || 1) - 1);
    const listUrl = `${BOARD}/list.html?table=${TABLE}&st=${SORT}${pg ? `&pg=${pg}` : ''}`;
    const { $, url } = await fetchHtml(listUrl, { referer: `${BOARD}/list.html?table=${TABLE}` });
    const items = [];
    const seen = new Set();
    $('#post_list tr[id^="li_chk_"]').each((_, tr) => {
      const $tr = $(tr);
      const m = /^li_chk_([a-z0-9_]+)-(\d+)$/i.exec($tr.attr('id') || '');
      if (!m || m[1] !== TABLE) return; // 다른 게시판 행(공지 등) 제외
      const postId = m[2];
      if (seen.has(postId)) return;
      seen.add(postId);

      const $sbj = $tr.find('td.li_sbj').first();
      const title = cleanText($sbj.find(`span[id^="title_chk_"]`).first().text());
      if (!title) return;

      const $cmt = $sbj.find('.list_comment_num').first();
      const commentCount = $cmt.length ? parseCount($cmt.text()) : 0;

      const $date = $tr.find('td.li_date').first();
      const dateText = `${cleanText($date.find('.w_date').text())} ${cleanText($date.find('.w_time').text())}`.trim();

      const $und = $tr.find('td.li_und');
      const views = parseCount(cleanText($und.eq(0).text()));
      const likes = parseCount(cleanText($und.eq(1).find('.o').text() || $und.eq(1).text()));

      let thumbnail = absUrl($tr.find('td.li_num img').first().attr('src'), url);
      if (thumbnail && /humoruniv\.com\/images\//.test(thumbnail)) thumbnail = null;

      items.push({
        postId,
        title,
        url: postUrl(postId),
        author: cleanText($tr.find('td.li_icn .hu_nick_txt').first().text()) || null,
        postedAt: parseKoDate(dateText),
        commentCount,
        views,
        likes,
        category: null,
        nsfwHint: isNsfw(title),
        thumbnail,
      });
    });
    return items;
  },

  async read(url) {
    const { $, url: finalUrl } = await fetchHtml(url, { referer: `${BOARD}/list.html?table=${TABLE}&st=${SORT}` });
    const title =
      cleanText($('#ai_cm_title').first().text()) ||
      cleanText($('meta[property="og:title"]').attr('content')) ||
      cleanText($('title').text());

    // 댓글은 본문 정리(cleanBody 가 DOM 을 고침) 전에 읽는다. 본문 영역(#wrap_copy) 밖이라 서로 겹치지 않는다.
    const { comments, commentTotal } = parseComments($, finalUrl);
    const { $body, racy } = cleanBody($, $('#wrap_copy').first(), finalUrl);

    const info = cleanText($('#content_info').text());
    const written = /작성시간\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?)/.exec(info)?.[1];
    const moved = /이동시간\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?)/.exec(info)?.[1];

    return {
      title,
      html: ($body.html() || '').trim(),
      author: cleanText($('#profile_table .hu_nick_txt').first().text()) || null,
      postedAt: parseKoDate(written || moved || null),
      nsfwHint: isNsfw(title) || racy > 0,
      comments,
      commentTotal,
    };
  },
};
