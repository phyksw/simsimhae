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
    topic: "",
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
    tab: "ledger", // ledger | ai
    aiDone: false,
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
  // 점수 'a·b·c' = 재미·이해·완결, 'a·-·-' = 재미만, 숫자 하나 = 종합 — 매기지 않은 칸('-')은 뺀다
  const SCORE_KEYS = ["재미", "이해", "완결"];
  function scoreParts(sc) {
    const raw = (sc || "").split("·");
    if (raw.length === 1) {
      const n = Number(raw[0]);
      return raw[0] === "" || Number.isNaN(n) ? [] : [["종합", n]];
    }
    return raw.map((x, i) => [SCORE_KEYS[i] || `${i + 1}`, Number(x)]).filter(([, n]) => !Number.isNaN(n));
  }
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  // 큰 주제 — 색은 주제마다 고정
  const TOPIC_HUE = {
    게임: 222, "버튜버·방송": 268, "시청자·채팅": 200, "고민 상담·사연": 160, "회사·일": 28, "학창 시절": 48,
    가족: 340, "연애·결혼": 350, "음식·생활": 95, "애니·만화·덕질": 290, "음악·노래": 312, "일본 유학": 6,
    "경제·IT·세상 이야기": 182, 기타: 220,
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
    if (state.topic && !(ep.tp || []).includes(state.topic)) return false;
    if (!state.words.length) return true;
    const hay = `${ep.c} ${ep.tg.join(" ")} ${(ep.tp || []).join(" ")} ${b.title} ${b.date}`.toLowerCase();
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
    const topicCount = new Map();
    for (const e of eps) for (const tp of e.tp || []) topicCount.set(tp, (topicCount.get(tp) || 0) + 1);
    const top = (state.data.topics || [...topicCount.keys()])
      .filter((tp) => topicCount.get(tp))
      .map((tp) => [tp, topicCount.get(tp)])
      .sort((a, b) => b[1] - a[1]);
    const tags = el("div", "card chart-tags");
    const h2 = el("h2", null, "주제별 에피소드");
    h2.append(el("span", "hint", "누르면 그 주제만 보기"));
    tags.append(h2);
    const maxT = top.length ? top[0][1] : 1;
    for (const [tp, n] of top) {
      const row = el("button", "hbar");
      row.type = "button";
      row.dataset.topic = tp;
      row.setAttribute("aria-pressed", String(state.topic === tp));
      const fl = el("span", "fl");
      fl.style.width = `${(n / maxT) * 100}%`;
      fl.style.background = `hsl(${TOPIC_HUE[tp] ?? 220} 62% 52%)`;
      const tr = el("span", "tr");
      tr.append(fl);
      row.append(el("span", "lab", tp), tr, el("span", "val", String(n)));
      row.setAttribute("aria-label", `${tp} ${n}개 — 이 주제만 보기`);
      row.addEventListener("click", () => setTopic(state.topic === tp ? "" : tp, true));
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
    const pre = opts.prefix || ""; // 같은 에피소드가 다른 탭에도 있을 때 id 가 겹치지 않게
    const words = opts.words || state.words;
    const art = el("article", "ep");
    art.id = `${pre}ep-${ep.id}`;
    art.tabIndex = -1;
    if (opts.rank != null) art.append(el("span", `rank${opts.rank <= 3 ? " top" : ""}`, String(opts.rank)));
    if (opts.badge != null) {
      const bd = el("span", `rank sbadge b${opts.band}`, opts.badge);
      bd.title = "평균 점수(5점 만점)";
      art.append(bd);
    }
    const tbox = el("div", "ep-time");
    tbox.append(el("span", "time", `${hms(ep.s)} – ${hms(ep.e)}`), el("span", "len", lenText(ep.e - ep.s)));
    art.append(tbox);
    const main = el("div", "ep-main");
    if (opts.withSource) main.append(el("div", "ep-src", `${b.date} · ${b.title}`));
    const p = el("p", "ep-text");
    hl(p, ep.c, words);
    main.append(p);
    // 길거나 여러 구간이 합쳐진 에피소드는 눌러서 자세히(검색 중에는 처음부터 다 보임)
    const expandable = ep.c.length > 80 || (ep.p && ep.p.length > 1);
    let toggle = null;
    if (expandable) {
      art.classList.add("expandable");
      if (words.length) art.classList.add("open");
      const detail = el("div", "ep-detail");
      detail.id = `${pre}d-${ep.id}`;
      detail.hidden = true;
      const more = el("button", "more-btn", "자세히");
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", detail.id);
      toggle = () => {
        const open = !(more.getAttribute("aria-expanded") === "true");
        art.classList.toggle("open", open || words.length > 0);
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
    const parts = scoreParts(ep.sc);
    if (opts.meters && parts.length) main.append(scoreMeters(parts));
    if (parts.length || (ep.tp && ep.tp.length) || art._more) {
      const meta = el("div", "ep-meta");
      if (parts.length && !opts.meters) {
        const one = parts.length === 1;
        const label = one
          ? `${parts[0][0] === "종합" ? "점수" : parts[0][0]} ${parts[0][1]}`
          : `점수 ${parts.map((x) => x[1]).join("·")}`;
        const s = el("span", "score", label);
        s.title = `${parts.map(([k, n]) => `${k} ${n}`).join(" · ")} (5점 만점)`;
        meta.append(s);
      }
      for (const tp of ep.tp || []) {
        const tg = el("span", "topic");
        tg.style.setProperty("--h", String(TOPIC_HUE[tp] ?? 220));
        hl(tg, tp, words);
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

  // ---------- AI 쇼츠 추천(점수별 묶음) ----------
  const BANDS = [
    { min: 4.5, label: "4.5점 이상", hue: 8 },
    { min: 4.0, label: "4.0 ~ 4.4점", hue: 24 },
    { min: 3.5, label: "3.5 ~ 3.9점", hue: 40 },
    { min: 3.0, label: "3.0 ~ 3.4점", hue: 168 },
    { min: -Infinity, label: "3점 미만", hue: 220 },
  ];
  const bandOf = (v) => BANDS.findIndex((x) => v >= x.min);
  function scoreMeters(parts) {
    const box = el("div", "meters");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", parts.map(([k, n]) => `${k} ${n}점`).join(", "));
    for (const [k, n] of parts) {
      const m = el("span", "mt");
      const tr = el("span", "mt-tr");
      const fl = el("span", "mt-fl");
      fl.style.width = `${Math.min(Math.max(n / 5, 0), 1) * 100}%`;
      tr.append(fl);
      m.append(el("span", "mt-k", k), tr, el("b", null, String(n)));
      box.append(m);
    }
    return box;
  }
  function aiItems() {
    const all = [];
    for (const b of broadcasts()) {
      for (const ep of b.eps) {
        const v = scoreVal(ep.sc);
        if (v >= 0) all.push({ ep, b, v: Math.round(v * 10) / 10 }); // 배지·점수대·통계가 같은 값을 쓰게
      }
    }
    all.sort(
      (x, y) =>
        y.v - x.v ||
        recOf(y.ep.id) - recOf(x.ep.id) ||
        (y.b.date || "").localeCompare(x.b.date || "") ||
        x.ep.s - y.ep.s,
    );
    return all;
  }
  function renderAI(animate = true) {
    const box = $("#panel-ai");
    box.textContent = "";
    const items = aiItems();
    const groups = BANDS.map(() => []);
    for (const it of items) groups[bandOf(it.v)].push(it);

    const head = el("section", "ai-head");
    head.setAttribute("aria-label", "AI 쇼츠 추천 한눈에 보기");
    const intro = el("div", "card ai-intro");
    intro.append(
      el("h2", null, "AI 쇼츠 추천"),
      el(
        "p",
        null,
        "쇼츠로 잘라 볼 만한 장면을 AI가 재미·이해·완결 세 가지로 1~5점씩 매겼습니다. 평균 점수가 높은 순으로 묶었어요.",
      ),
    );
    const avg = items.length ? items.reduce((a, x) => a + x.v, 0) / items.length : 0;
    const stats = el("div", "ai-stats");
    const top4 = items.filter((x) => x.v >= 4).length;
    for (const [n, label, isInt] of [
      [items.length, "점수 매긴 에피소드", true],
      [avg, "평균 점수", false],
      [top4, "4점 이상", true],
    ]) {
      const s = el("div");
      const b = el("b", null, isInt ? "0" : fmt1(n));
      s.append(b, el("span", null, label));
      stats.append(s);
      if (isInt) {
        if (animate) countUp(b, n);
        else b.textContent = n.toLocaleString();
      }
    }
    intro.append(stats);
    head.append(intro);
    reveal(intro, !animate);

    const dist = el("div", "card ai-dist");
    const h2 = el("h2", null, "점수대별 에피소드");
    h2.append(el("span", "hint", "누르면 그 점수대로 이동"));
    dist.append(h2);
    const maxN = Math.max(1, ...groups.map((g) => g.length));
    BANDS.forEach((band, i) => {
      if (!groups[i].length) return;
      const row = el("button", "hbar");
      row.type = "button";
      const fl = el("span", "fl");
      fl.style.width = `${(groups[i].length / maxN) * 100}%`;
      fl.style.background = `hsl(${band.hue} 78% 52%)`;
      const tr = el("span", "tr");
      tr.append(fl);
      row.append(el("span", "lab", band.label), tr, el("span", "val", String(groups[i].length)));
      row.setAttribute("aria-label", `${band.label} ${groups[i].length}개 — 그 점수대로 이동`);
      row.addEventListener("click", () => {
        const sec = document.getElementById(`band-${i}`);
        if (!sec) return;
        sec.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        const h = sec.querySelector("h3");
        if (h) h.focus({ preventScroll: true });
      });
      dist.append(row);
    });
    head.append(dist);
    reveal(dist, !animate);
    box.append(head);

    if (!items.length) {
      box.append(el("p", "empty", "점수를 매긴 에피소드가 없습니다"));
      return;
    }
    BANDS.forEach((band, i) => {
      if (!groups[i].length) return;
      const sec = el("section", "sgroup");
      sec.id = `band-${i}`;
      const h3 = el("h3", "sg-h");
      h3.tabIndex = -1;
      const dot = el("span", "sg-dot");
      dot.style.setProperty("--h", String(band.hue));
      h3.append(dot, el("span", null, band.label), el("span", "pill", `에피소드 ${groups[i].length}`));
      sec.append(h3);
      const list = el("div", "ranked ai-list");
      for (const { ep, b, v } of groups[i]) {
        const opts = { prefix: "ai-", words: [], withSource: true, badge: fmt1(v), band: i, meters: true, now: !animate };
        list.append(epCard(ep, b, opts));
      }
      sec.append(list);
      box.append(sec);
    });
  }

  // ---------- 탭 ----------
  function setTab(tab, { focus = false, push = true } = {}) {
    if (tab !== "ai") tab = "ledger";
    state.tab = tab;
    for (const t of document.querySelectorAll('.tabs [role="tab"]')) {
      const on = t.id === `tab-${tab}`;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    $("#panel-ledger").hidden = tab !== "ledger";
    $("#panel-ai").hidden = tab !== "ai";
    if (tab === "ai" && state.data && !state.aiDone) {
      state.aiDone = true;
      renderAI(true);
    }
    if (push) {
      const want = tab === "ai" ? "#ai" : "";
      if (location.hash !== want) {
        try {
          history.replaceState(null, "", `${location.pathname}${location.search}${want}`);
        } catch {
          /* 주소를 못 바꿔도 화면은 그대로 */
        }
      }
    }
    const tabs = document.querySelector(".tabs");
    if (tabs && tabs.getBoundingClientRect().top < 0) {
      window.scrollTo({ top: Math.max(tabs.getBoundingClientRect().top + window.scrollY - 8, 0), behavior: "auto" });
    }
  }
  function bindTabs() {
    const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => setTab(t.id.slice(4)));
      t.addEventListener("keydown", (e) => {
        let j = -1;
        if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = tabs.length - 1;
        if (j < 0) return;
        e.preventDefault();
        setTab(tabs[j].id.slice(4), { focus: true });
      });
    });
    window.addEventListener("hashchange", () => setTab(location.hash === "#ai" ? "ai" : "ledger", { push: false }));
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
    if (!state.aiDone) return;
    if (animate) renderAI(true);
    else for (const btn of document.querySelectorAll("#panel-ai [data-rec]")) paintRec(btn, btn.dataset.rec); // 펼친 카드·초점 유지
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

  function scrollToList() {
    const bar = $("#bar");
    const y = $("#count").getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - 8;
    if (window.scrollY > y || $("#count").getBoundingClientRect().top > window.innerHeight * 0.6) {
      window.scrollTo({ top: Math.max(y, 0), behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
  function setTopic(tp, jump = false) {
    state.topic = tp;
    state.page = 1;
    const sel = $("#topic");
    sel.value = tp;
    sel.classList.toggle("on", Boolean(tp));
    for (const b of document.querySelectorAll("button.hbar[data-topic]")) b.setAttribute("aria-pressed", String(b.dataset.topic === tp));
    renderList();
    if (jump) scrollToList();
  }
  function fillTopics() {
    const sel = $("#topic");
    const counts = new Map();
    for (const b of broadcasts()) for (const e of b.eps) for (const tp of e.tp || []) counts.set(tp, (counts.get(tp) || 0) + 1);
    for (const tp of state.data.topics || [...counts.keys()]) {
      if (!counts.get(tp)) continue;
      const o = el("option", null, `${tp} (${counts.get(tp)})`);
      o.value = tp;
      sel.append(o);
    }
  }
  function bindControls() {
    let timer = 0;
    const runSearch = (jump) => {
      clearTimeout(timer);
      state.words = $("#q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      state.page = 1;
      renderList();
      if (jump) scrollToList();
    };
    $("#q").addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(false), 200);
    });
    $("#q").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        runSearch(true);
        e.target.blur(); // 휴대폰 자판 내리기
      }
    });
    $("#go").addEventListener("click", () => runSearch(true));
    $("#topic").addEventListener("change", (e) => setTopic(e.target.value, true));
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
    bindTabs();
    setTab(location.hash === "#ai" ? "ai" : "ledger", { push: false }); // 데이터 전 — 화면만 바꿔 둠
    const votesP = fetchVotes(); // 데이터와 동시에
    votesP.catch(() => {});
    try {
      const r = await fetch("/data/episodes.json");
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (!data || !data.channels || !data.channels.length) throw new Error("empty");
      state.data = data;
    } catch {
      for (const box of [$("#list"), $("#panel-ai")]) {
        box.append(el("p", "empty", "장부를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요."));
      }
      return;
    }
    for (const b of broadcasts()) for (const ep of b.eps) bcOf.set(ep.id, b);
    fillTopics();
    const nAi = aiItems().length;
    $("#tab-ai-n").textContent = String(nAi);
    $("#tab-ai").setAttribute("aria-label", `AI 쇼츠 추천 — 점수 매긴 에피소드 ${nAi}개`);
    $("#foot").textContent =
      `데이터 기준일 ${state.data.generated} · 구간은 원본 다시보기 기준(시:분:초) · ` +
      "점수는 AI가 매긴 값(재미·이해·완결 각 1~5점, 숫자 하나는 종합 점수)이며 점수가 없는 에피소드도 있습니다.";
    if (state.tab === "ai") state.aiDone = true; // 주소가 #ai 로 열렸으면 처음부터 그 탭을 그린다
    renderAll(true); // 추천 수를 기다리지 않고 먼저 그린다
    await applyVotes(votesP);
    renderAll(false);
  }
  main();
})();
