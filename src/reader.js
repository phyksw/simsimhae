// 본문 보기: 원문 사이트에서 본문만 가져와 안전하게 정리(sanitize)하고, 이미지·영상은 우리 서버의 프록시를 거치게 바꾼다.
// 본문을 읽은 김에 본문 텍스트로 한 번 더 검열한다 (제목은 멀쩡한데 본문이 후방/정치인 경우).
// 캐시: 메모리(최근 300개, 30분). 클라우드는 setReadCache 로 DO 저장소를 뒤에 붙여 오래(기본 12시간) 둔다.
import sanitizeHtml from 'sanitize-html';
import * as cheerio from 'cheerio';
import { getSource } from './sources/index.js';
import { hostMatches } from './lib/util.js';
import { withRequestScope } from './lib/http.js';
import { classify } from './filter.js';
import { config } from './config.js';
import * as store from './store.js';

const CACHE_MAX = 300;
const CACHE_TTL_MS = 30 * 60e3;
const cache = new Map(); // id -> {at, data}
const inflight = new Map(); // id -> Promise
/** 오래 두는 캐시 { get(id): {at, data}|null, set(id, at, data), delete(id), clear() } (클라우드: DO 저장소) */
let persist = null;
let ttlMs = CACHE_TTL_MS;

/**
 * 미리보기를 메모리 밖에도 둔다 (클라우드: SiteDO 가 DO SQLite 를 넘긴다). 메모리 캐시는 비운다.
 * @param {{get(id: string): {at: number, data: any}|null, set(id: string, at: number, data: any): void, delete(id: string): void, clear(): void}|null} p
 * @param {{ttlMs?: number}} [opts]
 */
export function setReadCache(p, { ttlMs: t } = {}) {
  persist = p || null;
  ttlMs = t ?? CACHE_TTL_MS;
  cache.clear();
}

function remember(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * 본문 글자·그림·댓글이 하나도 없는 미리보기: 사이트가 이 서버에 본문 없는 페이지를 준 것이다
 * (예: 이토랜드가 클라우드 요청에 가끔 본문·댓글이 빠진 페이지를 준다 — 같은 글을 PC 에서 읽으면 멀쩡하다).
 * 이런 결과는 저장하지 않고 실패로 돌려, 방문자에게는 빈 화면 대신 원문 링크를 보여 주고 다음에 다시 읽는다.
 */
export const isEmptyRead = (d) => !d || (!String(d.text || '').trim() && !(d.mediaCount > 0) && !(d.comments?.length > 0));

/** 아직 유효한 캐시 (메모리 → 저장소 순). 예전에 저장된 빈 미리보기는 없는 셈 친다 */
function cachedEntry(id) {
  let hit = cache.get(id);
  if (!hit && persist) {
    try {
      hit = persist.get(id);
    } catch (e) {
      console.warn(`[reader] 캐시 읽기 실패: ${e.message}`);
    }
    if (hit) remember(id, hit);
  }
  if (hit && isEmptyRead(hit.data)) {
    cache.delete(id);
    return null;
  }
  return hit && Date.now() - hit.at < ttlMs ? hit : null;
}

/** 미리보기가 캐시에 있는지 (클라우드 알람의 미리 준비용) */
export function hasCached(id) {
  return !!cachedEntry(id);
}

const EMBED_HOSTS = ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com', 'streamable.com', 'clips.twitch.tv'];

export function proxiedUrl(sourceId, url) {
  return `/api/img?s=${encodeURIComponent(sourceId)}&u=${encodeURIComponent(url)}`;
}

function rewriteMedia(src, attribs, attr) {
  const v = attribs[attr];
  if (!v) return attribs;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) {
      delete attribs[attr];
    } else if (hostMatches(u.hostname, src.imageHosts)) {
      attribs[attr] = proxiedUrl(src.id, u.toString());
    } else {
      // 허용 목록 밖의 외부 이미지는 그대로 두되 Referer 를 보내지 않음
      attribs.referrerpolicy = 'no-referrer';
    }
  } catch {
    delete attribs[attr];
  }
  return attribs;
}

export function cleanHtml(html, src) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'blockquote', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'video', 'source', 'a', 'figure', 'figcaption', 'table', 'thead',
      'tbody', 'tr', 'td', 'th', 'pre', 'code', 'iframe', 'font', 'center', 'sup', 'sub', 'small', 'big', 'mark',
    ],
    allowedAttributes: {
      img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
      video: ['src', 'poster', 'controls', 'loop', 'muted', 'autoplay', 'playsinline', 'preload', 'width', 'height', 'referrerpolicy'],
      source: ['src', 'type'],
      a: ['href', 'target', 'rel'],
      iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow', 'loading', 'referrerpolicy'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      font: ['color'],
      '*': ['style'],
    },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
        'text-align': [/^(left|right|center|justify)$/],
        'font-weight': [/^(bold|bolder|normal|\d{3})$/],
        'font-style': [/^(italic|normal)$/],
        'text-decoration': [/^[a-z\s-]+$/],
      },
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedIframeHostnames: EMBED_HOSTS,
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...rewriteMedia(src, { ...attribs }, 'src'), loading: 'lazy' } }),
      video: (tagName, attribs) => {
        let a = rewriteMedia(src, { ...attribs }, 'src');
        a = rewriteMedia(src, a, 'poster');
        return { tagName, attribs: { ...a, controls: 'controls', playsinline: 'playsinline', preload: 'metadata' } };
      },
      source: (tagName, attribs) => ({ tagName, attribs: rewriteMedia(src, { ...attribs }, 'src') }),
      iframe: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin', allowfullscreen: 'allowfullscreen' } }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}

/**
 * 댓글 정리: 글자는 순수 텍스트로(화면에서 textContent 로 넣음), 이미지는 허용 호스트면 프록시 주소로.
 * @returns {Array<{author: string|null, text: string, likes: number|null, dislikes: number|null, best: boolean, reply: boolean, postedAt: string|null, images: Array<{src: string, direct: boolean}>}>}
 */
export function cleanComments(list, src) {
  if (!Array.isArray(list)) return [];
  const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const text = String(c.text ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1500);
    const images = [];
    for (const u of Array.isArray(c.images) ? c.images.slice(0, 4) : []) {
      try {
        const x = new URL(u);
        if (!/^https?:$/.test(x.protocol)) continue;
        // 움직이는 댓글 스티커는 mp4 로만 있는 사이트가 있다(인벤·뽐뿌) → 화면에서 <video> 로 그리게 표시
        const kind = /\.(mp4|webm|mov|m4v)$/i.test(x.pathname) ? 'video' : 'image';
        if (hostMatches(x.hostname, src.imageHosts)) images.push({ src: proxiedUrl(src.id, x.toString()), direct: false, kind });
        else images.push({ src: x.toString(), direct: true, kind });
      } catch {}
    }
    if (!text && !images.length) continue;
    out.push({
      author: c.author ? String(c.author).trim().slice(0, 40) : null,
      text,
      likes: num(c.likes),
      dislikes: num(c.dislikes),
      best: !!c.best,
      reply: !!c.reply,
      postedAt: typeof c.postedAt === 'string' && !Number.isNaN(Date.parse(c.postedAt)) ? c.postedAt : null,
      images,
    });
    if (out.length >= 150) break;
  }
  return out;
}

/** 대본용 텍스트: 줄바꿈을 살려서 글자만 */
export function htmlToText(html) {
  const $ = cheerio.load(`<div id="__r">${html}</div>`);
  const $r = $('#__r');
  $r.find('br').replaceWith('\n');
  $r.find('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr, figure').each((_, el) => {
    $(el).append('\n');
  });
  $r.find('img, video, iframe').each((_, el) => {
    $(el).replaceWith('\n[이미지]\n');
  });
  return $r
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/(\n\[이미지\]){2,}/g, '\n[이미지 여러 장]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {import('./store.js').Post} post
 * @returns {Promise<{title: string, html: string, text: string, mediaCount: number, statusChanged: boolean}>}
 */
export async function readPost(post) {
  const hit = cachedEntry(post.id);
  if (hit) return hit.data;
  if (inflight.has(post.id)) return inflight.get(post.id);

  const job = (async () => {
    const src = await getSource(post.source);
    if (!src) throw new Error('알 수 없는 출처');
    // 미리보기는 같은 사이트 대기열에서 수집 목록 요청 뒤에 서고, 너무 오래 기다려야 하면 바로 포기한다 (BusyError → 원문 주소로 안내)
    const article = await withRequestScope({ priority: 'preview', maxWaitMs: config.previewMaxWaitMs || undefined }, () => src.read(post.url));
    const html = cleanHtml(article.html || '', src);
    const text = htmlToText(html);
    const mediaCount = (html.match(/<(img|video|iframe)\b/g) || []).length;
    const comments = cleanComments(article.comments, src);
    if (isEmptyRead({ text, mediaCount, comments })) {
      // 저장하지 않고, 본문 검사(bodyChecked)도 하지 않는다 — 다음 읽기에서 진짜 본문으로 다시
      const e = new Error('본문이 비어 있어요');
      e.empty = true;
      throw e;
    }

    // 본문까지 포함해 다시 판정 — 더 엄격한 결과가 나오면 반영.
    // 본문은 제목보다 기준이 높고(filter.js classify 의 opts.body), 본문에서 나온 사유에만 classify 가 "본문 " 을 붙여 준다.
    // (규칙이 바뀌면 server 가 제목으로 다시 판정하고 bodyChecked 를 지워, 다음 미리보기 때 본문을 새 규칙으로 다시 본다)
    let statusChanged = false;
    const live = store.getPost(post.id);
    if (live && !live.bodyChecked) {
      // 글 페이지에서만 보이는 후방 표시는 글에 남겨 둔다 (규칙 재적용 때도 유지되게)
      if (article.nsfwHint) live.nsfwHint = true;
      const verdict = classify({ title: live.title, category: live.category, nsfwHint: !!live.nsfwHint }, src, { body: text });
      const rank = { ok: 0, adult: 1, blocked: 2 };
      if (rank[verdict.status] > rank[live.auto?.status || 'ok']) {
        live.auto = { status: verdict.status, reasons: verdict.reasons, flags: verdict.flags };
      }
      live.bodyChecked = true;
      const before = live.status;
      live.status = store.resolveStatus(live);
      statusChanged = before !== live.status;
      store.upsertPost(live);
    }

    const commentTotal = Number.isFinite(article.commentTotal) ? article.commentTotal : post.commentCount ?? null;
    const data = { title: article.title || post.title, html, text, mediaCount, statusChanged, comments, commentTotal };
    const at = Date.now();
    remember(post.id, { at, data });
    if (persist) {
      // 다시 꺼낼 때는 상태 변경을 또 알리지 않는다 (이번 응답에서 이미 반영)
      try {
        persist.set(post.id, at, { ...data, statusChanged: false });
      } catch (e) {
        console.warn(`[reader] 캐시 저장 실패: ${e.message}`);
      }
    }
    return data;
  })().finally(() => inflight.delete(post.id));

  inflight.set(post.id, job);
  return job;
}

export function forgetCached(id) {
  cache.delete(id);
  try {
    persist?.delete(id);
  } catch (e) {
    console.warn(`[reader] 캐시 지우기 실패: ${e.message}`);
  }
}

/** 미리보기 캐시를 모두 지운다 (클라우드로 옮기기 뒤) */
export function forgetAll() {
  cache.clear();
  persist?.clear();
}
