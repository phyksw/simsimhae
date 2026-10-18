// 블라인드(www.teamblind.com/kr) — 토픽 "유우머" 최신글.
// "회사생활"도 받았었지만 판정 118개 중 95개가 유머 아님(하소연·질문·광고), 핸드드립 1개뿐이라 뺐다 (2026-10-19).
//
// 사이트 구조 (2026-10 조사):
// - Nuxt 2 서버 렌더링. 토픽 페이지(/kr/topics/<토픽이름>) HTML 에 최신글 45개(+ 맨 위 NOW/HOT 고정글, 쿠팡 광고 칸)가
//   div.article-list > div.article-list-pre 로 들어 있다. 같은 데이터가 window.__NUXT__ 에도 있지만 HTML 만으로 충분하다.
// - 더 보기(무한 스크롤)와 "추천순" 정렬은 POST /kr/api/article/list 로 가져오는데, 요청·응답 본문을
//   클라이언트 JS 가 AES+RSA 로 암호화한다({payload, client_zl}). 이건 사이트가 일부러 걸어 둔 자동 수집 방지 장치라서
//   흉내 내지 않는다(평문 JSON 으로 보내면 30초 뒤 504). 서버 렌더링 HTML 은 쿼리(?page= 등)를 무시하고 늘 첫 45개만 준다.
//   → 그래서 "페이지" 대신 토픽을 바꿔 가며 읽는다: list(1)=유우머, list(2~)=빈 배열 (토픽을 더하려면 TOPICS 에).
//   유우머는 하루 1~2개꼴로 올라와 첫 45개가 3~4주치이므로 1쪽만으로 새 글을 놓치지 않는다.
// - robots.txt: `User-agent: *` 는 /search/, /kr/search/, /user/history, /kr/user/history 만 금지(토픽·글·API 경로는 허용).
//   GPTBot·CCBot·ClaudeBot·anthropic-ai·Google-Extended 같은 AI 크롤러 이름은 전면 금지인데, 이 수집기는 그 이름을 쓰지 않으므로
//   '*' 그룹이 적용된다. 금지 경로(검색·태그 검색·사용자 기록)는 쓰지 않는다.
// - 시각 표기는 "방금", "N분", "N시간", "어제", "N일"(달력 기준 며칠 전, 7일까지), 그 뒤로 "MM.DD". 목록·__NUXT__ 둘 다 상대 표기뿐이라
//   목록 postedAt 은 대략값이다. 글 페이지의 JSON-LD(DiscussionForumPosting.datePublished)는 시(時) 단위 절대 시각이라 read() 에선 그걸 쓴다.
//
// 글 페이지(/kr/post/<제목-슬러그>-<alias>): 로그인 없이 본문 전체가 보인다(JSON-LD text 와 같음). 슬러그는 장식이고
// 끝의 alias(8자)로 글을 찾는다(/kr/post/<alias> 도 같은 글). 본문 = p#contentArea(텍스트·링크) + p.attach-img(이미지)
// + 링크 미리보기(a.attach-link-out) + 투표(div.attach-poll). ul.tag-actions(쿠팡 "액션 태그")·광고는 뺀다.
// 이미지는 d2u3dcdbebyaiu.cloudfront.net (Referer 없어도·외부 Referer 여도 200 — 핫링크 차단 없음).
//
// 댓글: 비로그인 HTML 에는 사이트 기본 정렬("추천순") 첫 묶음만 들어 있다 — 원댓글 5개 남짓 + 각 원댓글의 대댓글 최대 3개.
// 나머지("댓글 N개 더보기", "+ 대댓글 N개 더보기")는 위의 암호화 API 로만 오므로 가져오지 않는다.
// 구조: .article-comments 의 자식으로 .wrap-comment(원댓글) 다음에 .wrap-reply(그 대댓글들)가 온다.
// 삭제 댓글은 p.cmt-txt.delete, 쿠팡 광고 댓글은 id 없는 .wrap-comment. 베스트 댓글 표시는 없다(정렬 자체가 추천순).
// 댓글 시각: 원댓글은 JSON-LD(시 단위), 대댓글은 일 단위 상대 표기뿐이라 그날 0시가 되므로 원글·원댓글 시각보다 이르면 그 시각으로 자른다.
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.teamblind.com';
const TOPICS = ['유우머']; // list(page) 의 page 번째 토픽
const MAX_COMMENTS = 100;
// 삭제 댓글은 보통 p.cmt-txt.delete 로 오지만, 클래스가 빠졌을 때를 대비해 자리표시 문구도 거른다
const DELETED_RE = /^(?:작성자가 삭제한|(?:관리자|운영자)에 의해 (?:삭제|숨김 처리)된|신고(?:로|에 의해) (?:삭제|숨김 처리)된|삭제된)\s*댓글입니다\.?$/;

// 블라인드에는 후방 말머리 관행이 거의 없어 제목 표기만 가볍게 본다.
const NSFW_RE = /ㅇㅎ|ㅎㅂ|19금|🔞|nsfw|후방\s*주의|(?:^|[\s([])(?:약후|후방|19)\s*[)\]]/i;

const topicUrl = (name) => `${BASE}/kr/topics/${encodeURIComponent(name)}`;

/** 글 주소 → alias (경로 마지막 '-' 뒤, 슬러그 없는 /kr/post/<alias> 도 처리) */
function aliasOf(url) {
  try {
    const u = new URL(url);
    const m = /^\/kr\/post\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    const last = decodeURIComponent(m[1]).split('-').pop();
    return /^[A-Za-z0-9]{6,12}$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** 사이트가 준 글 주소에서 쿼리·조각만 뗀다 (슬러그+alias 그대로 = JSON-LD url 과 같은 정식 주소) */
function normalizePostUrl(href, base) {
  const abs = absUrl(href, base);
  if (!abs) return null;
  const u = new URL(abs);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** KST 기준 오늘 0시에서 n일 뺀 시각 */
function kstDaysAgo(n, now = new Date()) {
  const KST = 9 * 3600e3;
  const k = new Date(now.getTime() + KST);
  const midnight = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST;
  return new Date(midnight - n * 864e5).toISOString();
}

/** "방금" "3분" "2시간" "어제" "4일" "10.08" "2025.10.08" → ISO */
function blindDate(text) {
  const t = cleanText(text);
  if (!t) return null;
  let m = /^(\d+)\s*(초|분|시간)$/.exec(t);
  if (m) return parseKoDate(`${m[1]}${m[2]} 전`);
  m = /^(\d+)\s*일$/.exec(t); // 달력 기준 며칠 전 ("어제" = 1일)
  if (m) return kstDaysAgo(Number(m[1]));
  if (t === '어제') return kstDaysAgo(1);
  return parseKoDate(t);
}

/** <i class="blind">조회수</i>223 같은 칸의 숫자. 칸은 있는데 숫자가 없으면("좋아요") 0. 칸이 없으면 null. */
function countIn($x) {
  if (!$x.length) return null;
  const $c = $x.clone();
  $c.find('.blind').remove();
  return parseCount($c.text()) ?? 0;
}

/** p.name → "회사명 · 닉네임" (사이트 표기 그대로, 배지·작성자 표시·팔로우 버튼 제외) */
function nameOf($, $name) {
  if (!$name.length) return null;
  const $n = $name.clone();
  $n.find('button, .badges, em.op, .blind, img').remove();
  const company = cleanText($n.find('.cp, a.point').first().text());
  $n.find('.cp, a.point, .middot').remove();
  const nick = cleanText($n.text()).replace(/^·\s*|\s*·$/g, '');
  const out = [company, nick].filter(Boolean).join(' · ');
  return out || null;
}

/** 텍스트 칸(<br> 줄바꿈) → 순수 텍스트 */
function plainText($, $x) {
  const $c = $x.clone();
  $c.find('img, video, iframe, script, style, .blind').remove();
  $c.find('*')
    .addBack()
    .contents()
    .each((_, n) => {
      if (n.type === 'text') n.data = n.data.replace(/[\r\n\t]+/g, ' ');
    });
  $c.find('br').replaceWith('\n');
  $c.find('p, div, li').each((_, el) => {
    $(el).append('\n');
  });
  return $c
    .text()
    .replace(/[ ​﻿]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseList($, pageUrl, fallbackTopic) {
  const topic = cleanText($('.topic_info h2.topic_is').first().text()) || fallbackTopic;
  const items = [];
  const seen = new Set();
  $('.article-list > .article-list-pre').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('.tit h3 a[href]').first();
    const href = $a.attr('href') || '';
    if (!/^\/kr\/post\//.test(href)) return; // 쿠팡 광고 카드(외부 링크)·빈 광고 칸
    const url = normalizePostUrl(href, pageUrl);
    const postId = url && aliasOf(url);
    if (!postId || seen.has(postId)) return;
    const $t = $a.clone();
    $t.find('.blind, i, em').remove(); // "투표글"/"투표" 같은 숨김 꼬리표
    const title = cleanText($t.text());
    if (!title) return;
    const $name = $el.find('.sub .name').first().clone();
    $name.find('button, .badges, img').remove();
    const author = cleanText($name.text()).replace(/\s*·$/, '') || null;
    if (author && /^팀블라인드(\s|·|$)/.test(author)) return; // 운영팀 이벤트·공지 글
    seen.add(postId);
    const $past = $el.find('.wrap-info .past').first().clone();
    $past.find('.blind').remove();
    const thumb = $el.find('.attach-img img').first().attr('src');
    items.push({
      postId,
      title,
      url,
      author,
      postedAt: blindDate($past.text()),
      commentCount: countIn($el.find('.wrap-info .cmt').first()),
      views: countIn($el.find('.wrap-info .pv').first()),
      likes: countIn($el.find('.wrap-info .like').first()),
      category: topic,
      nsfwHint: NSFW_RE.test(title),
      thumbnail: absUrl(thumb, pageUrl),
    });
  });
  return items;
}

/** JSON-LD 의 DiscussionForumPosting (없으면 null) */
function ldPosting($) {
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const data = JSON.parse($(el).contents().text());
      for (const d of Array.isArray(data) ? data : [data]) {
        if (d && d['@type'] === 'DiscussionForumPosting') {
          found = d;
          break;
        }
      }
    } catch {
      // 깨진 JSON-LD 는 무시
    }
  });
  return found;
}

const squash = (s) => String(s || '').replace(/\s+/g, '');

function parseComments($, pageUrl, ld, postMs) {
  // JSON-LD 에는 원댓글(대댓글 제외) 몇 개의 시(時) 단위 작성 시각이 있다 → 본문(공백 제거) 기준으로 짝지어 쓴다
  const ldDates = new Map();
  for (const c of ld?.comment || []) {
    if (c?.text && c.datePublished) ldDates.set(squash(c.text), c.datePublished);
  }
  const out = [];
  // 대댓글은 HTML 의 일 단위 상대 표기("어제", "3일", "10.03")뿐이라 그날 0시로 잡힌다 → 원글·원댓글보다 앞서지 않게 자른다
  let parentMs = postMs;
  const push = ($c, reply) => {
    if (!/^\d+$/.test($c.attr('id') || '')) return; // 쿠팡 광고 댓글 칸
    const $txt = $c.find('.cmt-txt').first();
    if (!$txt.length || $txt.hasClass('delete')) return;
    const text = plainText($, $txt);
    const images = [];
    $c.find('.attach-img img').each((_, im) => {
      const s = absUrl($(im).attr('src'), pageUrl);
      if (s && /^https?:/.test(s) && !images.includes(s)) images.push(s);
    });
    if (!text && !images.length) return;
    if (!images.length && DELETED_RE.test(text)) return;
    const $info = $c.find('.wrap-info').first();
    const $date = $info.find('.date').first().clone();
    $date.find('.blind').remove();
    let postedAt = (!reply && ldDates.get(squash(text))) || null;
    if (postedAt) postedAt = new Date(postedAt).toISOString();
    else postedAt = blindDate($date.text());
    const floor = reply ? parentMs : postMs;
    if (postedAt && Number.isFinite(floor) && Date.parse(postedAt) < floor) postedAt = new Date(floor).toISOString();
    if (!reply && postedAt) parentMs = Date.parse(postedAt);
    out.push({
      author: nameOf($, $c.find('.name').first()),
      text,
      likes: countIn($info.find('.like').first()),
      dislikes: null, // 블라인드에는 비추천이 없다
      best: false, // 베스트 표시 없음 (사이트 기본 정렬 '추천순' 그대로 — 좋아요 수만으로 정렬된 건 아님)
      reply,
      postedAt,
      images,
    });
  };
  $('.article-comments')
    .first()
    .children()
    .each((_, el) => {
      const $el = $(el);
      if ($el.hasClass('wrap-comment')) {
        if (/^\d+$/.test($el.attr('id') || '')) parentMs = postMs; // 새 원댓글 (삭제됐으면 원글 시각 기준)
        push($el, false);
      } else if ($el.hasClass('wrap-reply')) $el.children('.wrap-comment').each((__, r) => push($(r), true));
    });
  return out.slice(0, MAX_COMMENTS);
}

/** .article-view-contents → 본문 HTML (광고·액션 태그·버튼 제외, 투표는 보기 목록으로) */
function bodyHtml($, pageUrl) {
  const $src = $('.article-view-contents').first();
  if (!$src.length) return '';
  const $body = $src.clone();
  $body
    .find(
      'script, style, noscript, ul.tag-actions, .article_info, .ad_coupang_rwd, .ad_md, .adwrap, .dynamicwrap, .gam-slot, img.favicon',
    )
    .remove();
  // 이미지 확대 버튼은 벗겨서 이미지만 남긴다
  $body.find('button.zoom').each((_, b) => {
    $(b).replaceWith($(b).contents());
  });
  // 투표: 라디오 버튼 대신 보기 목록 (결과는 로그인/참여해야 보여서 넣지 않음)
  $body.find('.attach-poll').each((_, p) => {
    const $p = $(p);
    const joined = parseCount($p.find('.state strong em').first().text());
    const opts = $p
      .find('label.inp-lb, .inp-lb')
      .map((__, l) => cleanText($(l).text()))
      .get()
      .filter(Boolean);
    if (!opts.length) return void $p.remove();
    const $box = $('<div class="poll"></div>');
    $box.append($('<p></p>').text(`[투표${joined != null ? ` · 참여 ${joined}` : ''}]`));
    const $ul = $('<ul></ul>');
    for (const o of opts) $ul.append($('<li></li>').text(o));
    $box.append($ul);
    $p.replaceWith($box);
  });
  $body.find('button, input, a.view-result').remove();
  // 이미지만 올릴 때 본문 칸에 형식상 넣는 "." 같은 글자는 버린다
  const $txt = $body.find('#contentArea').first();
  if ($txt.length && !$txt.find('a, img').length && /^[\s.·,ㅤ]*$/.test($txt.text())) $txt.remove();
  // 인라인 이벤트·Vue 속성 정리
  $body.find('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name) || /^data-v-/.test(name)) $(el).removeAttr(name);
    }
  });
  normalizeMedia($, $body, pageUrl);
  return ($body.html() || '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

export default {
  id: 'blind',
  name: '블라인드 유우머',
  short: '블라',
  color: '#da3238', // 블라인드 포인트 빨강(#FB5957)을 흰 글씨가 읽히도록 어둡게 (사이트 CSS 토큰 --tb-legacy-red-da)
  homepage: topicUrl(TOPICS[0]),
  domains: ['teamblind.com'],
  // 본문·댓글 첨부 이미지와 링크 미리보기 썸네일: d2u3dcdbebyaiu.cloudfront.net, 배지 등: static.teamblind.com
  imageHosts: ['d2u3dcdbebyaiu.cloudfront.net', 'teamblind.com'],
  referer: `${BASE}/`, // 핫링크 차단은 없지만 사이트 Referer 를 붙여 둔다
  strictness: 'strict', // 토픽 밖 인기글(NOW/HOT 고정글)에 젠더·연봉·부동산 얘기가 섞인다
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const topic = TOPICS[page - 1];
    if (!topic) return []; // 토픽마다 첫 45개만 서버 렌더링됨 (위 설명)
    const { $, url } = await fetchHtml(topicUrl(topic), { referer: `${BASE}/kr/` });
    return parseList($, url, topic);
  },

  async read(postUrl) {
    const { $, url } = await fetchHtml(postUrl, { referer: `${BASE}/kr/` });
    const ld = ldPosting($);
    const $head = $('.article-view-head').first();
    const title = cleanText($head.find('h1').first().text()) || cleanText(ld?.headline) || '';
    const $date = $head.find('.wrap-info .date').first().clone();
    $date.find('.blind').remove();
    const ldDate = ld?.datePublished ? new Date(ld.datePublished) : null;
    const postedAt = ldDate && !Number.isNaN(ldDate.getTime()) ? ldDate.toISOString() : blindDate($date.text());
    const comments = parseComments($, url, ld, postedAt ? Date.parse(postedAt) : NaN);
    const $total = $('.article-comments .comments_function h3').first();
    return {
      title,
      html: bodyHtml($, url),
      author: nameOf($, $head.find('.name').first()),
      postedAt,
      nsfwHint: NSFW_RE.test(title),
      comments,
      commentTotal: $total.length ? parseCount($total.text()) : (ld?.commentCount ?? null),
    };
  },
};
