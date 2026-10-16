// 파싱 도우미: 절대 URL, 공백 정리, 숫자("1.2만", "[12]"), 한국 커뮤니티식 날짜("21:15", "10.16", "3분 전").

/** 상대 경로를 절대 URL 로. 실패하면 null. */
export function absUrl(href, base) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h || h.startsWith('javascript:') || h.startsWith('#')) return null;
  try {
    const u = new URL(h.startsWith('//') ? `https:${h}` : h, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

/** 연속 공백/개행을 한 칸으로 줄이고 앞뒤 공백 제거 */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/[​ \s]+/g, ' ')
    .trim();
}

/** "1,234" → 1234, "1.2만" → 12000, "3천" → 3000, "[12]" → 12, "" → null */
export function parseCount(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = String(s).replace(/[\s,[\]()]/g, '');
  const m = /(-?\d+(?:\.\d+)?)(만|천|k|K)?/.exec(t);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === '만') n *= 10000;
  else if (m[2] === '천' || m[2] === 'k' || m[2] === 'K') n *= 1000;
  return Math.round(n);
}

const KST_OFFSET_MS = 9 * 3600 * 1000;

/** KST 기준 연/월/일/시/분/초 → Date */
function kst(y, mo, d, h = 0, mi = 0, s = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - KST_OFFSET_MS);
}

/** 현재 시각의 KST 구성요소 */
function kstParts(now) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return { y: k.getUTCFullYear(), mo: k.getUTCMonth() + 1, d: k.getUTCDate() };
}

/**
 * 한국 커뮤니티에서 흔한 날짜 표기를 ISO 문자열로 바꾼다 (모두 KST 로 해석). 모르면 null.
 *  - "21:15", "21:15:03"            → 오늘 (미래면 어제)
 *  - "10.16", "10-16", "10/16 21:15" → 올해 (미래면 작년)
 *  - "26.10.16", "2026.10.16 21:15", "2026-10-16 21:15:00", "2026/10/16"
 *  - "방금", "3초 전", "5분 전", "2시간 전", "3일 전", "어제 21:15", "2026년 10월 16일 21시 15분"
 *  - ISO 8601 / 타임스탬프(초·밀리초)
 * @param {string|number|null|undefined} input
 * @param {Date} [now]
 */
export function parseKoDate(input, now = new Date()) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' || /^\d{10}(\d{3})?$/.test(String(input).trim())) {
    const n = Number(input);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = cleanText(input)
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const nowMs = now.getTime();
  const today = kstParts(now);
  const out = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

  if (/^(방금|조금 전|막)/.test(s)) return new Date(nowMs).toISOString();
  let m = /(\d+)\s*(초|분|시간|일|주|개월|달)\s*전/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = { 초: 1e3, 분: 6e4, 시간: 3.6e6, 일: 8.64e7, 주: 6.048e8, 개월: 2.592e9, 달: 2.592e9 }[m[2]];
    return new Date(nowMs - n * unit).toISOString();
  }

  // ISO 8601 (T 포함 또는 타임존 포함)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /[+-]\d{2}:?\d{2}$|Z$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // "2026년 10월 16일 21시 15분" / "10월 16일"
  m = /(?:(\d{2,4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(오전|오후)?\s*(\d{1,2})\s*[시:]\s*(\d{1,2})?\s*분?)?/.exec(s);
  if (m) {
    let y = m[1] ? Number(m[1]) : today.y;
    if (y < 100) y += 2000;
    let h = m[5] ? Number(m[5]) : 0;
    if (m[4] === '오후' && h < 12) h += 12;
    if (m[4] === '오전' && h === 12) h = 0;
    let d = kst(y, Number(m[2]), Number(m[3]), h, m[6] ? Number(m[6]) : 0);
    if (!m[1] && d.getTime() > nowMs + 864e5) d = kst(y - 1, Number(m[2]), Number(m[3]), h, m[6] ? Number(m[6]) : 0);
    return out(d);
  }

  const TIME = '(?:\\s+|T)?(?:(오전|오후)\\s*)?(\\d{1,2}):(\\d{2})(?::(\\d{2}))?';
  const hm = (ampm, h, mi, sec) => {
    let hh = Number(h);
    if (ampm === '오후' && hh < 12) hh += 12;
    if (ampm === '오전' && hh === 12) hh = 0;
    return [hh, Number(mi), sec ? Number(sec) : 0];
  };

  // "어제 21:15"
  m = new RegExp(`^(어제|그제|그저께)${TIME}?`).exec(s);
  if (m) {
    const back = m[1] === '어제' ? 1 : 2;
    const [h, mi, sec] = m[3] ? hm(m[2], m[3], m[4], m[5]) : [0, 0, 0];
    return out(new Date(kst(today.y, today.mo, today.d, h, mi, sec).getTime() - back * 864e5));
  }

  // "2026.10.16 21:15" / "26.10.16" / "2026-10-16" / "2026/10/16"
  m = new RegExp(`^(\\d{2}|\\d{4})[.\\-/]\\s?(\\d{1,2})[.\\-/]\\s?(\\d{1,2})\\.?${'(?:' + TIME + ')?'}`).exec(s);
  if (m) {
    let y = Number(m[1]);
    if (y < 100) y += 2000;
    const [h, mi, sec] = m[5] ? hm(m[4], m[5], m[6], m[7]) : [0, 0, 0];
    return out(kst(y, Number(m[2]), Number(m[3]), h, mi, sec));
  }

  // "10.16" / "10-16 21:15" / "10/16"
  m = new RegExp(`^(\\d{1,2})[.\\-/](\\d{1,2})\\.?${'(?:' + TIME + ')?'}$`).exec(s);
  if (m) {
    const mo = Number(m[1]);
    const dd = Number(m[2]);
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      const [h, mi, sec] = m[4] ? hm(m[3], m[4], m[5], m[6]) : [0, 0, 0];
      let d = kst(today.y, mo, dd, h, mi, sec);
      if (d.getTime() > nowMs + 864e5) d = kst(today.y - 1, mo, dd, h, mi, sec);
      return out(d);
    }
  }

  // "21:15" / "오후 9:15"
  m = new RegExp(`^${TIME}$`).exec(s);
  if (m) {
    const [h, mi, sec] = hm(m[1], m[2], m[3], m[4]);
    let d = kst(today.y, today.mo, today.d, h, mi, sec);
    if (d.getTime() > nowMs + 5 * 6e4) d = new Date(d.getTime() - 864e5);
    return out(d);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 이미지/영상의 지연 로딩 속성을 실제 src 로 옮기고 절대 URL 로 바꾼다 (cheerio 요소 범위 안에서). */
export function normalizeMedia($, $root, baseUrl) {
  const LAZY = ['data-original', 'data-src', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'lazy-src', 'file-src'];
  $root.find('img, video, source, iframe').each((_, el) => {
    const $el = $(el);
    for (const a of LAZY) {
      const v = $el.attr(a);
      if (v && !/^data:/.test(v)) {
        $el.attr('src', v);
        break;
      }
    }
    for (const a of ['src', 'poster']) {
      const v = $el.attr(a);
      if (v && !/^data:/.test(v)) {
        const abs = absUrl(v, baseUrl);
        if (abs) $el.attr(a, abs);
      }
    }
    $el.removeAttr('srcset');
  });
  $root.find('a[href]').each((_, el) => {
    const abs = absUrl($(el).attr('href'), baseUrl);
    if (abs) $(el).attr('href', abs);
  });
  return $root;
}

/** 호스트가 허용 목록(접미사) 중 하나에 속하는지 */
export function hostMatches(host, suffixes) {
  const h = String(host || '').toLowerCase();
  return (suffixes || []).some((s) => {
    const x = String(s).toLowerCase().replace(/^\./, '');
    return h === x || h.endsWith(`.${x}`);
  });
}
