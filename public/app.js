"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* 저장 못 해도 화면은 그대로 */
      }
    },
  };

  const PAGE = 40;
  const SEARCH_OPEN_MAX = 5;
  const state = {
    data: null,
    words: [],
    sort: "bc",
    onlyScore: false,
    counts: {},
    mine: new Set(store.get("ledger-mine", [])),
    pending: store.get("ledger-pending", {}), // 서버에 못 보낸 추천 { id: true|false }
    online: false,
    page: 1,
    open: new Set(),
    ranked: null, // 추천 순 목록(검색·필터·정렬이 바뀔 때만 다시 셈)
    recStat: null,
  };

  // ---------- 작은 도구 ----------
  const hms = (sec) => {
    sec = Math.max(Math.round(sec), 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const lenText = (sec) => {
    sec = Math.max(Math.round(sec), 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return m ? `${h}시간 ${m}분` : `${h}시간`;
    if (m) return s ? `${m}분 ${s}초` : `${m}분`;
    return `${s}초`;
  };
  const scoreVal = (sc) => {
    if (!sc) return -1;
    const parts = sc.split("·").map(Number).filter((x) => !Number.isNaN(x));
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : -1;
  };
  const PALETTE = [210, 262, 330, 18, 150, 42, 188, 0];
  const tagHue = (t) => {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  function hl(parent, text, words) {
    if (!words.length) {
      parent.append(document.createTextNode(text));
      return;
    }
    const low = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      let best = -1;
      let len = 0;
      for (const w of words) {
        const j = low.indexOf(w, i);
        if (j >= 0 && (best < 0 || j < best)) {
          best = j;
          len = w.length;
        }
      }
      if (best < 0) {
        parent.append(document.createTextNode(text.slice(i)));
        break;
      }
      if (best > i) parent.append(document.createTextNode(text.slice(i, best)));
      parent.append(el("mark", null, text.slice(best, best + len)));
      i = best + len;
    }
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- 나타남(모션) ----------
  const io =
    !reduceMotion && "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              if (en.isIntersecting) {
                en.target.classList.add("in");
                io.unobserve(en.target);
              }
            }
          },
          { rootMargin: "0px 0px -6% 0px" },
        )
      : null;
  function reveal(node, now = false) {
    if (io && !now) io.observe(node);
    else node.classList.add("in");
  }
  function countUp(node, n) {
    if (reduceMotion || n < 10) {
      node.textContent = n.toLocaleString();
      return;
    }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min((t - t0) / 900, 1);
      node.textContent = Math.round(n * (1 - (1 - p) ** 3)).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- 데이터 ----------
  const broadcasts = () => (state.data && state.data.channels[0] ? state.data.channels[0].broadcasts : []);
  function matches(ep, b) {
    if (state.onlyScore && !ep.sc) return false;
    if (!state.words.length) return true;
    const hay = `${ep.c} ${ep.tg.join(" ")} ${b.title} ${b.date}`.toLowerCase();
    return state.words.every((w) => hay.includes(w));
  }
  const recOf = (id) => state.counts[id] || 0;
  const bcOf = new Map(); // 에피소드 id → 방송

  // ---------- 한눈에 보기(인포그래픽) ----------
  function renderOverview(animate = true) {
    const box = $("#overview");
    box.textContent = "";
    const bcs = broadcasts();
    const eps = bcs.flatMap((b) => b.eps);
    const recorded = eps.reduce((a, e) => a + Math.max(e.e - e.s, 0), 0);
    const stats = [
      [bcs.length, "방송"],
      [eps.length, "에피소드"],
      [Math.round(recorded / 3600), "기록된 시간(시간)"],
      [eps.reduce((a, e) => a + recOf(e.id), 0), "받은 추천"],
    ];
    stats.forEach(([n, label], i) => {
      const s = el("div", "stat");
      const b = el("b", null, "0");
      s.append(b, el("span", null, label));
      box.append(s);
      if (animate) countUp(b, n);
      else b.textContent = n.toLocaleString();
      if (i === 3) state.recStat = b;
    });
    const tagCount = new Map();
    for (const e of eps) for (const t of e.tg) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const top = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const tags = el("div", "card chart-tags");
    tags.append(el("h2", null, "많이 나온 주제"));
    const maxT = top.length ? top[0][1] : 1;
    for (const [t, n] of top) {
      const row = el("div", "hbar");
      const fl = el("span", "fl");
      fl.style.width = `${(n / maxT) * 100}%`;
      const tr = el("span", "tr");
      tr.append(fl);
      row.append(el("span", "lab", t), tr, el("span", "val", String(n)));
      row.title = `${t} — ${n}개`;
      tags.append(row);
    }
    if (!top.length) tags.append(el("p", "empty", "주제 표시가 없습니다"));
    box.append(tags);
    reveal(tags, !animate);
    const byMonth = new Map();
    for (const b of bcs) {
      const m = (b.date || "").slice(0, 7);
      if (m) byMonth.set(m, (byMonth.get(m) || 0) + b.eps.length);
    }
    const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-8);
    const mc = el("div", "card chart-months");
    mc.append(el("h2", null, "달마다 기록한 에피소드"));
    const bars = el("div", "vbars");
    const maxM = Math.max(1, ...months.map((x) => x[1]));
    for (const [m, n] of months) {
      const vb = el("div", "vb");
      const col = el("span", "col");
      col.style.height = `${Math.max((n / maxM) * 86, 4)}px`;
      vb.append(el("span", "n", String(n)), col, el("span", "m", `${Number(m.slice(5))}월`));
      vb.title = `${m} — ${n}개`;
      bars.append(vb);
    }
    mc.append(bars);
    box.append(mc);
    reveal(mc, !animate);
  }

  // ---------- 추천 ----------
  const THUMB =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v11H3V10h4zm4 11h7.2a2 2 0 0 0 2-1.6l1.3-7A2 2 0 0 0 19.5 10H14l.9-4.3a1.6 1.6 0 0 0-.4-1.4L13.6 3 7.8 9.4A2 2 0 0 0 7 11v8a2 2 0 0 0 2 2h2z"/></svg>';
  function recButton(ep) {
    const btn = el("button", "rec");
    btn.type = "button";
    btn.dataset.rec = ep.id;
    btn.insertAdjacentHTML("afterbegin", THUMB); // 고정 아이콘(데이터 아님)
    btn.append(el("span", "n"));
    paintRec(btn, ep.id);
    btn.addEventListener("click", () => toggleRec(btn, ep));
    return btn;
  }
  function paintRec(btn, id) {
    btn.setAttribute("aria-pressed", String(state.mine.has(id)));
    btn.setAttribute("aria-label", `추천 ${recOf(id)}개`);
    btn.querySelector(".n").textContent = String(recOf(id));
  }
  function burst(btn) {
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
    if (reduceMotion) return;
    for (let i = 0; i < 8; i++) {
      const s = el("span", "spark");
      const a = (Math.PI * 2 * i) / 8;
      s.style.setProperty("--dx", `${Math.cos(a) * 26}px`);
      s.style.setProperty("--dy", `${Math.sin(a) * 26}px`);
      btn.append(s);
      setTimeout(() => s.remove(), 650);
    }
  }
  function setMine(id, on) {
    if (on) state.mine.add(id);
    else state.mine.delete(id);
    store.set("ledger-mine", [...state.mine]);
  }
  // 추천 수가 바뀌면 버튼·방송 알약·타임라인 막대·개요 합계를 함께
  function repaint(id) {
    for (const b of document.querySelectorAll(`[data-rec="${id}"]`)) paintRec(b, id);
    for (const s of document.querySelectorAll(`[data-seg="${id}"]`)) s.classList.toggle("hot", recOf(id) > 0);
    const b = bcOf.get(id);
    if (b) {
      for (const pill of document.querySelectorAll(`[data-bcrec="${b.k}"]`)) {
        const sum = b.eps.filter((e) => matches(e, b)).reduce((a, e) => a + recOf(e.id), 0);
        pill.textContent = `추천 ${sum}`;
        pill.hidden = sum === 0;
      }
    }
    if (state.recStat) {
      const total = broadcasts()
        .flatMap((x) => x.eps)
        .reduce((a, e) => a + recOf(e.id), 0);
      state.recStat.textContent = total.toLocaleString();
    }
  }
  async function sendVote(id, on) {
    const r = await fetch("/api/vote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, on }),
    });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  async function toggleRec(btn, ep) {
    const on = !state.mine.has(ep.id);
    setMine(ep.id, on);
    state.counts[ep.id] = Math.max(0, recOf(ep.id) + (on ? 1 : -1));
    repaint(ep.id);
    if (on) burst(btn);
    if (!state.online) {
      state.pending[ep.id] = on;
      store.set("ledger-pending", state.pending);
      toast("추천 서버에 연결되지 않았어요 — 다음에 연결되면 보낼게요");
      return;
    }
    btn.disabled = true;
    try {
      const j = await sendVote(ep.id, on);
      state.counts[ep.id] = Number(j.n) || 0;
      repaint(ep.id);
    } catch (err) {
      setMine(ep.id, !on);
      state.counts[ep.id] = Math.max(0, recOf(ep.id) + (on ? -1 : 1));
      repaint(ep.id);
      const code = err.message;
      toast(code === "429" ? "잠시 뒤에 다시 눌러 주세요" : "추천을 저장하지 못했어요");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 에피소드 카드 ----------
  function epCard(ep, b, opts = {}) {
    const art = el("article", "ep");
    art.id = `ep-${ep.id}`;
    art.tabIndex = -1;
    if (opts.rank != null) art.append(el("span", `rank${opts.rank <= 3 ? " top" : ""}`, String(opts.rank)));
    const tbox = el("div", "ep-time");
    tbox.append(el("span", "time", `${hms(ep.s)} – ${hms(ep.e)}`), el("span", "len", lenText(ep.e - ep.s)));
    art.append(tbox);
    const main = el("div", "ep-main");
    if (opts.withSource) main.append(el("div", "ep-src", `${b.date} · ${b.title}`));
    const p = el("p", "ep-text");
    hl(p, ep.c, state.words);
    main.append(p);
    // 길거나 여러 구간이 합쳐진 에피소드는 눌러서 자세히(검색 중에는 처음부터 다 보임)
    const expandable = ep.c.length > 80 || (ep.p && ep.p.length > 1);
    let toggle = null;
    if (expandable) {
      art.classList.add("expandable");
      if (state.words.length) art.classList.add("open");
      const detail = el("div", "ep-detail");
      detail.id = `d-${ep.id}`;
      detail.hidden = true;
      const more = el("button", "more-btn", "자세히");
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", detail.id);
      toggle = () => {
        const open = !(more.getAttribute("aria-expanded") === "true");
        art.classList.toggle("open", open || state.words.length > 0);
        more.setAttribute("aria-expanded", String(open));
        more.textContent = open ? "접기" : "자세히";
        if (open && !detail.childNodes.length) fillDetail(detail, ep, b);
        detail.hidden = !open;
      };
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggle();
      });
      p.addEventListener("click", () => {
        if (window.getSelection && String(window.getSelection())) return; // 글을 고르는 중이면 그대로
        toggle();
      });
      main.append(detail);
      art._more = more;
    }
    if (b.dur > 0) {
      const pos = el("div", "ep-pos");
      pos.setAttribute("aria-hidden", "true");
      const track = el("span", "ep-pos-track");
      const fill = el("span", "ep-pos-fill");
      fill.style.left = `${Math.min((ep.s / b.dur) * 100, 99.5)}%`;
      fill.style.width = `${Math.max(((ep.e - ep.s) / b.dur) * 100, 1.2)}%`;
      track.append(fill);
      pos.append(track, el("span", "ep-pos-label", `방송 ${Math.round((ep.s / b.dur) * 100)}% 지점`));
      main.append(pos);
    }
    if (ep.sc || ep.tg.length || art._more) {
      const meta = el("div", "ep-meta");
      if (ep.sc) {
        const s = el("span", "score", `점수 ${ep.sc}`);
        s.title = ep.sc.includes("·") ? "재미·이해·완결(1~5)" : "종합 점수(1~5)";
        meta.append(s);
      }
      for (const t of ep.tg) {
        const tg = el("span", "tag");
        tg.style.setProperty("--h", String(tagHue(t)));
        hl(tg, `#${t}`, state.words);
        meta.append(tg);
      }
      if (art._more) meta.append(art._more);
      main.append(meta);
    }
    art.append(main, recButton(ep));
    reveal(art, opts.now);
    return art;
  }

  function fillDetail(box, ep, b) {
    if (ep.p && ep.p.length > 1) {
      box.append(el("div", "d-head", `이 에피소드가 나오는 구간 ${ep.p.length}곳`));
      const list = el("div", "d-spans");
      for (const [s, e] of ep.p) {
        const it = el("span", "d-span");
        it.append(el("span", "time sm", `${hms(s)} – ${hms(e)}`), el("span", "len", lenText(e - s)));
        list.append(it);
      }
      box.append(list);
    }
    const info = el("div", "d-info");
    info.append(document.createTextNode(`${b.date} · ${b.title}`));
    if (b.url) {
      const a = el("a", "src-link", "원본 다시보기 열기 ↗");
      a.href = b.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      info.append(document.createTextNode(" "), a);
    }
    box.append(info);
  }

  // ---------- 방송 타임라인(인포그래픽) ----------
  function timeline(b, eps) {
    const wrap = el("div", "tl");
    const dur = Math.max(b.dur, 1);
    const lanes = [];
    const placed = [...eps]
      .sort((x, y) => x.s - y.s)
      .map((ep) => {
        let lane = lanes.findIndex((end) => end <= ep.s - dur * 0.004);
        if (lane < 0) {
          if (lanes.length < 4) lane = lanes.push(0) - 1;
          else lane = lanes.indexOf(Math.min(...lanes));
        }
        lanes[lane] = Math.max(lanes[lane], ep.e);
        return { ep, lane };
      });
    const track = el("div", "tl-track");
    track.style.height = `${Math.max(lanes.length, 1) * 16 + 4}px`;
    placed.forEach(({ ep, lane }, i) => {
      const seg = el("button", `tl-seg${recOf(ep.id) > 0 ? " hot" : ""}`);
      seg.type = "button";
      seg.tabIndex = -1; // 같은 정보가 카드에 있어 탭 순서에서는 뺀다
      seg.dataset.seg = ep.id;
      seg.style.left = `${(ep.s / dur) * 100}%`;
      seg.style.width = `${Math.max(((ep.e - ep.s) / dur) * 100, 0.8)}%`;
      seg.style.top = `${4 + lane * 16}px`;
      if (!reduceMotion) seg.style.transitionDelay = `${Math.min(i * 18, 600)}ms`;
      const short = ep.c.length > 60 ? `${ep.c.slice(0, 59)}…` : ep.c;
      seg.title = `${hms(ep.s)} – ${hms(ep.e)}\n${short}`;
      seg.setAttribute("aria-label", `${hms(ep.s)} 에피소드로 가기`);
      seg.addEventListener("click", () => {
        const card = document.getElementById(`ep-${ep.id}`);
        if (!card) return;
        card.classList.add("in");
        card.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
        card.focus({ preventScroll: true });
        card.classList.remove("flash");
        void card.offsetWidth;
        card.classList.add("flash");
      });
      track.append(seg);
    });
    const ticks = el("div", "tl-ticks");
    const stepH = dur > 6 * 3600 ? 2 : 1;
    for (let h = 0; h * 3600 <= dur; h += stepH) {
      const t = el("span", null, h === 0 ? "0" : `${h}시간`);
      t.style.left = `${((h * 3600) / dur) * 100}%`;
      ticks.append(t);
    }
    wrap.append(track, ticks, el("div", "tl-legend", `방송 길이 ${lenText(b.dur)} · 막대를 누르면 그 에피소드로 이동`));
    reveal(wrap);
    return wrap;
  }

  // ---------- 목록 ----------
  function broadcastBody(b, eps, body) {
    body.textContent = "";
    if (b.url) {
      const a = el("a", "src-link", "원본 다시보기 열기 ↗");
      a.href = b.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      body.append(a);
    }
    body.append(timeline(b, eps));
    const list = el("div", "eps");
    for (const ep of eps) list.append(epCard(ep, b));
    body.append(list);
  }

  function renderBroadcasts() {
    const list = $("#list");
    list.textContent = "";
    let nb = 0;
    let ne = 0;
    let opened = 0;
    const searching = state.words.length > 0;
    for (const b of broadcasts()) {
      const eps = b.eps.filter((ep) => matches(ep, b));
      if (!eps.length) continue;
      nb++;
      ne += eps.length;
      const d = el("details", "bc");
      const sm = el("summary");
      sm.append(el("span", "date", b.date));
      const t = el("span", "btitle");
      hl(t, b.title, state.words);
      sm.append(t, el("span", "pill", `에피소드 ${eps.length}`));
      const recSum = eps.reduce((a, e) => a + recOf(e.id), 0);
      const pill = el("span", "pill rec", `추천 ${recSum}`);
      pill.dataset.bcrec = b.k;
      pill.hidden = recSum === 0;
      sm.append(pill);
      d.append(sm);
      const body = el("div", "bc-body");
      d.append(body);
      // 검색 중 자동으로 펼친 방송은 기억하지 않는다(검색어를 지우면 원래대로)
      const shouldOpen = searching
        ? opened < SEARCH_OPEN_MAX
        : state.open.has(b.k) || (state.open.size === 0 && nb === 1);
      if (shouldOpen) {
        opened++;
        d.open = true;
        if (!searching) state.open.add(b.k);
        broadcastBody(b, eps, body);
      }
      d.addEventListener("toggle", () => {
        if (d.open && !body.childNodes.length) broadcastBody(b, eps, body);
        if (state.words.length) return;
        if (d.open) state.open.add(b.k);
        else state.open.delete(b.k);
      });
      list.append(d);
    }
    $("#count").textContent = nb ? `방송 ${nb}개 · 에피소드 ${ne.toLocaleString()}개` : "";
    if (!nb) list.append(el("p", "empty", "맞는 에피소드가 없습니다"));
    $("#more").hidden = true;
  }

  function rankedList() {
    if (state.ranked) return state.ranked;
    const all = [];
    for (const b of broadcasts()) for (const ep of b.eps) if (matches(ep, b)) all.push({ ep, b });
    all.sort(
      (x, y) =>
        recOf(y.ep.id) - recOf(x.ep.id) ||
        scoreVal(y.ep.sc) - scoreVal(x.ep.sc) ||
        (y.b.date || "").localeCompare(x.b.date || "") ||
        x.ep.s - y.ep.s,
    );
    state.ranked = all;
    return all;
  }
  function renderRanked(append = false) {
    const list = $("#list");
    const all = rankedList();
    let box = list.querySelector(".ranked");
    const from = append && box ? (state.page - 1) * PAGE : 0;
    if (!append || !box) {
      list.textContent = "";
      box = el("div", "ranked");
      if (all.length) list.append(box);
      else list.append(el("p", "empty", "맞는 에피소드가 없습니다"));
    }
    all.slice(from, state.page * PAGE).forEach(({ ep, b }, i) => {
      box.append(epCard(ep, b, { rank: from + i + 1, withSource: true, now: append }));
    });
    $("#count").textContent = all.length ? `에피소드 ${all.length.toLocaleString()}개 · 추천 많은 순` : "";
    $("#more").hidden = state.page * PAGE >= all.length;
  }

  function renderList() {
    if (!state.data) return;
    state.ranked = null;
    if (state.sort === "rec") renderRanked();
    else renderBroadcasts();
  }
  function renderAll(animate = true) {
    if (!state.data) return;
    renderOverview(animate);
    renderList();
  }

  // ---------- 시작 ----------
  async function fetchVotes() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch("/api/votes", { headers: { accept: "application/json" }, signal: ctl.signal });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function applyVotes(votesP) {
    try {
      const j = await votesP;
      state.counts = j.counts || {};
      state.mine = new Set(j.mine || []);
      state.online = true;
      // 연결이 안 될 때 눌러 둔 추천을 이제 보낸다
      const pending = Object.entries(state.pending);
      for (const [id, on] of pending) {
        if (!bcOf.has(id) || state.mine.has(id) === on) continue;
        try {
          const res = await sendVote(id, on);
          state.counts[id] = Number(res.n) || 0;
          if (on) state.mine.add(id);
          else state.mine.delete(id);
        } catch {
          /* 이번에도 못 보내면 버린다 */
        }
      }
      state.pending = {};
      store.set("ledger-pending", {});
      store.set("ledger-mine", [...state.mine]);
    } catch {
      state.online = false;
      state.counts = {};
      for (const id of state.mine) state.counts[id] = 1;
      const n = $("#notice");
      n.textContent = "추천 수를 불러오지 못해 이 브라우저에서 누른 추천만 보여 드려요.";
      n.hidden = false;
    }
  }

  function bindControls() {
    let timer = 0;
    $("#q").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.words = e.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        state.page = 1;
        renderList();
      }, 160);
    });
    $("#onlyScore").addEventListener("change", (e) => {
      state.onlyScore = e.target.checked;
      state.page = 1;
      renderList();
    });
    for (const b of document.querySelectorAll(".seg-ctl button")) {
      b.addEventListener("click", () => {
        state.sort = b.dataset.sort;
        state.page = 1;
        for (const x of document.querySelectorAll(".seg-ctl button")) x.setAttribute("aria-pressed", String(x === b));
        renderList();
      });
    }
    $("#more").addEventListener("click", () => {
      if (!state.data) return;
      state.page++;
      renderRanked(true);
    });
  }

  async function main() {
    bindControls();
    const votesP = fetchVotes(); // 데이터와 동시에
    votesP.catch(() => {});
    try {
      const r = await fetch("/data/episodes.json");
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (!data || !data.channels || !data.channels.length) throw new Error("empty");
      state.data = data;
    } catch {
      $("#list").append(el("p", "empty", "장부를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요."));
      return;
    }
    for (const b of broadcasts()) for (const ep of b.eps) bcOf.set(ep.id, b);
    $("#foot").textContent =
      `데이터 기준일 ${state.data.generated} · 구간은 원본 다시보기 기준(시:분:초) · ` +
      "점수는 장부를 만들 때 매긴 값(a·b·c = 재미·이해·완결 1~5, 숫자 하나 = 종합 1~5)이며 없는 에피소드도 있습니다.";
    renderAll(true); // 추천 수를 기다리지 않고 먼저 그린다
    await applyVotes(votesP);
    renderAll(false);
  }
  main();
})();
