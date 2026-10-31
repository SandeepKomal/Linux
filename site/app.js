// DevOps Nimbus Linux site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.TRACK;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM nodes directly, never from HTML strings.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Text with `code` spans.
  const rich = (text) => String(text).split(/(`[^`]+`)/).map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));

  const PREFIX = "lq:";
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode */ } }
  };
  // Everything the site keeps lives under one prefix in this browser; one click removes it.
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and solved scenarios from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }

  // A link that works anywhere: copied to the clipboard, shown if that is blocked.
  function copyLinkButton(hash, label = "Copy link") {
    return h("button.copy", {
      type: "button", title: "Copy a link to this",
      onclick: async (e) => {
        const b = e.currentTarget;
        const url = location.href.replace(/#.*$/, "") + "#" + hash;
        try { await navigator.clipboard.writeText(url); b.textContent = "Copied"; } catch { b.textContent = url; }
        setTimeout(() => { b.textContent = label; }, 1600);
      }
    }, label);
  }

  const scenarioTitles = () => Object.fromEntries((window.LQPlayground ? window.LQPlayground.scenarios : []).map((x) => [x.id, x.title]));
  function practise(id) { location.hash = "play/" + id; }
  const repoUrl = (p) => `${Q.repo}/blob/main/${p.split("/").map(encodeURIComponent).join("/")}`;

  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs and deep links ---------------------------------------------------------------

  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = want === "fix" ? "doctor" : want === "play" ? "path" : tabs.includes(want) ? want : "path";
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    document.querySelectorAll(".top nav a").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (want === "fix" && sub) openFix(sub);
    if (want === "play" && sub && window.LQPlayground) window.LQPlayground.load(sub);
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    show();
    if (current !== before && !/^#(play|fix)\//.test(location.hash)) window.scrollTo(0, 0);
  });

  // --- hero: the disk that df says is full ----------------------------------------------------

  function renderHero() {
    const gauge = h("i");
    const pct = h("b.bad", null, "100%");
    const rows = h("div.rows.mono", { role: "table", "aria-label": "Open files by process" });
    const procs = [["1204", "nginx", "/var/log/nginx/access.log", "212M"], ["988", "postgres", "/var/lib/postgresql/16/main", "3.1G"], ["2231", "java", "/var/log/app/app.log (deleted)", "16.4G"]];
    const draw = (found) => rows.replaceChildren(h("div.dim", { role: "row" }, h("span", null, "PID"), h("span", null, "PROCESS"), h("span", null, "OPEN FILE"), h("span", null, "SIZE")),
      ...procs.map((p) => h("div" + (found && p[2].includes("deleted") ? ".found" : ""), { role: "row" }, ...p.map((x) => h("span", null, x)))));
    const toggle = h("button.toggle", { type: "button", "aria-pressed": "false" }, "Find the missing space");
    let step = 0;
    toggle.addEventListener("click", () => {
      step = (step + 1) % 3;
      toggle.setAttribute("aria-pressed", String(step > 0));
      if (step === 1) { draw(true); note.textContent = "lsof +L1: java still writes a log someone deleted."; toggle.textContent = "Restart the app"; }
      if (step === 2) { gauge.classList.add("freed"); pct.textContent = "18%"; pct.className = "ok"; note.textContent = "Restarted: the file is closed and 16.4 GB come back."; toggle.textContent = "Start again"; }
      if (step === 0) { draw(false); gauge.classList.remove("freed"); pct.textContent = "100%"; pct.className = "bad"; note.textContent = "df says full; du finds only 3.3 GB."; toggle.textContent = "Find the missing space"; }
    });
    const note = h("span", null, "df says full; du finds only 3.3 GB.");
    $("#stage").replaceChildren(h("div.stage-bar", null, h("div", null, h("strong", null, "web-01:/"), h("div", { "aria-live": "polite" }, note)), h("div", null, toggle)),
      h("div.mono", null, h("span.dim", null, "/dev/nvme0n1p1  20G  used "), pct), h("div.gauge", { "aria-hidden": "true" }, gauge), rows,
      h("button.linkish.stage-try", { type: "button", onclick: () => practise("deletedopen") }, "Fix it yourself in the playground"));
    draw(false);
    const n = window.LQPlayground ? window.LQPlayground.scenarios.length : 0;
    $("#stats").replaceChildren(...[[n, "incidents to fix, basics to production"], [Q.levels.length, "levels, first command to incident response"], [Q.doctor.length, "error messages explained"]]
      .map(([v, l]) => h("div", null, h("b", null, String(v)), h("span", null, l))));
    $("#pg-count").textContent = String(n);
  }

  // --- path ------------------------------------------------------------------------------

  const stageId = (s) => "stage-" + s.toLowerCase().replace(/\s+/g, "-");
  function practiseRow(ids, label) {
    const titles = scenarioTitles();
    const list = (ids || []).filter((id) => titles[id]);
    return list.length ? h("div.doctor-practise", null, h("span.muted.small", null, label), list.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, titles[id]))) : null;
  }
  function renderPath() {
    const done = new Set(store.get("done", []));
    const scores = store.get("quiz", {});
    const box = $("#levels");
    box.replaceChildren();
    let stage = "", list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage", { id: stageId(stage) }, stage), list);
      }
      const isDone = done.has(lv.id);
      list.append(h("li.level" + (isDone ? ".done" : ""), { id: "lv-" + lv.id },
        h("input", { type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`, onchange: (e) => { if (e.target.checked) done.add(lv.id); else done.delete(lv.id); store.set("done", [...done]); if (e.target.checked) window.LQEngage.active(); renderPath(); } }),
        h("span.num", null, lv.id),
        h("details.what", null,
          h("summary", null, h("span.title", null, lv.title), h("span.topic", null, lv.topic)),
          h("div.level-body", null,
            h("div", null, h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h4", null, "Lab on a real Linux machine"), window.LQEngage.order(lv, h("pre", null, h("code", null, lv.lab.join("\n"))))),
            h("p.level-links", null, h("a", { href: repoUrl(lv.docs) }, `Guide: ${lv.docs}`)),
            practiseRow(lv.practise, "Practise in the playground:"))),
        h("span.actions", null, h("a.small", { href: "#quiz", onclick: () => { $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in scores ? `Quiz ${scores[lv.id]}%` : "Quiz"))));
    }
    const stages = [];
    for (const lv of Q.levels) {
      let st = stages.find((x) => x.name === lv.stage);
      if (!st) stages.push(st = { name: lv.stage, levels: [] });
      st.levels.push(lv);
    }
    $("#stages").replaceChildren(...stages.map((st, i) => {
      const n = st.levels.filter((l) => done.has(l.id)).length;
      const ring = h("span.ring", { "aria-hidden": "true" });
      ring.style.setProperty("--p", Math.round(n / st.levels.length * 100));
      return h("a.stage-card" + (n === st.levels.length ? ".complete" : ""), { role: "listitem", href: "#" + stageId(st.name), onclick: (e) => { e.preventDefault(); scrollToEl(document.getElementById(stageId(st.name))); } },
        ring, h("span.stage-num", null, `Stage ${i + 1}`), h("strong", null, st.name), h("span.muted", null, `${n} of ${st.levels.length} levels`));
    }));
    $("#bar-fill").style.width = (done.size / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(done.size));
    $("#bar").setAttribute("aria-valuemax", String(Q.levels.length));
    $("#bar-text").textContent = `${done.size} of ${Q.levels.length} levels complete`;
  }

  // --- quiz ------------------------------------------------------------------------------

  const EXAM_SIZE = 20;
  const questionsFor = (id) => (window.TRACK_QUIZ[id] || []).map((item) => ({ ...item, level: id }));
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function renderQuiz() {
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0, correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const bar = h("span.fill");
    const update = () => {
      score.replaceChildren(h("span", null, h("strong", null, `${correct}`), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, bar));
      bar.style.width = (answered / items.length * 100) + "%";
      if (answered < items.length) return;
      const pct = Math.round(correct / items.length * 100);
      if (!exam) { const all = store.get("quiz", {}); all[mode] = Math.max(all[mode] || 0, pct); store.set("quiz", all); window.LQEngage.active(); renderPath(); }
      score.append(h("p.result", null, h("strong", null, `${pct}%. `), pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, practise the level, and try again.",
        " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      // A new order each time, so position gives nothing away.
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => {
        opts.append(h("button.opt", {
          type: "button", "data-right": opt.index === item.answer ? "1" : null,
          onclick: (e) => {
            const right = opt.index === item.answer;
            opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
            if (!right) e.currentTarget.classList.add("wrong");
            fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
            fb.className = "feedback " + (right ? "ok" : "bad");
            answered++;
            if (right) correct++;
            update();
          }
        }, ...rich(opt.text)));
      });
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null, h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    update();
  }

  // --- unit file X-ray --------------------------------------------------------------------------

  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      let slot = $("#xray-lines .note-slot");
      if (!slot) slot = h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }
  function renderXray(res) {
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren();
    res.lines.forEach(({ line, note, level, warns }, i) => {
      if (!note) { lines.append(h("li", null, h("span.line.blank", null, line || " "))); return; }
      const flag = warns && warns.length ? "warn" : level === "unknown" ? "unknown" : "";
      lines.append(h("li", null, h("button.line" + (flag ? "." + flag : ""), {
        type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), h("p", null, ...rich(note)),
            ...(warns || []).map((w) => h("p.xray-warn", null, ...rich(w))), h("p.muted", null, `Line ${i + 1} of ${res.lines.length}`));
        }
      }, line)));
    });
    const warned = res.lines.filter((r) => r.warns && r.warns.length).length;
    $("#xray-summary").textContent = [`${{ unit: "Unit file", "drop-in": "Drop-in", crontab: "Crontab", "system crontab": "System crontab" }[res.kind]}: ${res.lines.filter((r) => r.note).length} lines explained`, warned ? `${warned} worth a second look` : null].filter(Boolean).join(" · ");
    $("#xray-review").replaceChildren(...(res.review.length ? [h("details.xray-missing", { open: true }, h("summary", null, `${res.review.length} thing${res.review.length === 1 ? "" : "s"} worth checking`), h("ul.xray-review", null, res.review.map((n) => h("li", null, ...rich(n)))))] : []));
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
    $("#xray-result").hidden = false;
    $("#xray-view").hidden = false;
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }
  function explainInput() {
    const res = window.LQExplain.explain($("#xray-input").value);
    const error = $("#xray-error");
    if (res.error) { error.textContent = res.error; error.hidden = false; return; }
    error.hidden = true;
    renderXray(res);
  }
  // i is an example's index, or -1 for "Paste your own" (the first tab).
  function loadExample(i) {
    document.querySelectorAll("#xray-pick button").forEach((b, j) => b.setAttribute("aria-selected", String(j === i + 1)));
    $("#xray-input").value = i < 0 ? "" : window.LQExplain.EXAMPLES[i].text;
    if (i < 0) { $("#xray-result").hidden = true; $("#xray-view").hidden = true; $("#xray-input").focus(); return; }
    explainInput();
  }

  // --- troubleshooting reference ---------------------------------------------------------------

  const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, " ").split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const docText = (d) => [d.title, d.error, d.symptom, ...d.cause, ...d.confirm, ...d.fix, d.prevent, d.group].join(" ").toLowerCase();
  // Pasted error text matches on its words; the best matches come first.
  function searchDoctor(q) {
    const ws = [...new Set(words(q))];
    if (!ws.length) return Q.doctor.map((d) => ({ d, score: 0 }));
    return Q.doctor.map((d) => {
      const text = docText(d), err = d.error.toLowerCase();
      const score = ws.reduce((s, w) => s + (err.includes(w) ? 2 : text.includes(w) ? 1 : 0), 0);
      return { d, score };
    }).filter((x) => x.score >= Math.max(1, Math.ceil(ws.length * 0.4))).sort((a, b) => b.score - a.score);
  }
  function renderDoctorList() {
    const q = $("#doctor-q").value;
    const hits = searchDoctor(q);
    const box = $("#doctor-list");
    if (q.trim()) {
      box.replaceChildren(h("div.doctor-group", null, h("div.doctor-group-name", null, "Best matches", h("span.doctor-group-count", null, String(hits.length))),
        h("div.doctor-group-items", null, hits.slice(0, 12).map(({ d }) => h("a.chip", { href: "#fix/" + d.id }, d.title)))));
      $("#doctor-none").hidden = hits.length > 0;
      return;
    }
    const groups = [...new Set(Q.doctor.map((d) => d.group))];
    box.replaceChildren(...groups.map((g) => {
      const items = Q.doctor.filter((d) => d.group === g);
      return h("div.doctor-group", null, h("div.doctor-group-name", null, g, h("span.doctor-group-count", null, String(items.length))),
        h("div.doctor-group-items", null, items.map((d) => h("a.chip", { href: "#fix/" + d.id, "aria-current": location.hash === "#fix/" + d.id ? "true" : null }, d.title))));
    }));
    $("#doctor-none").hidden = true;
  }
  function openFix(id) {
    const d = Q.doctor.find((x) => x.id === id);
    if (!d) return;
    const lv = Q.levels.find((l) => l.id === d.level);
    const list = (items) => h("ul", null, items.map((t) => h("li", null, ...rich(t))));
    $("#doctor-out").replaceChildren(h("article.card.fix", { id: "fix-" + d.id },
      h("div.fix-head", null, h("p.tag", null, d.group), copyLinkButton("fix/" + d.id)),
      h("h3", null, d.title),
      h("pre.fix-error", null, h("code", null, d.error)),
      h("h4", null, "What you see"), h("p", null, ...rich(d.symptom)),
      h("h4", null, "Why it happens"), list(d.cause),
      h("h4", null, "Confirm it"), h("pre", null, h("code", null, d.confirm.join("\n"))),
      h("h4", null, "Fix it"), list(d.fix),
      h("h4", null, "Prevent it"), h("p", null, ...rich(d.prevent)),
      // Fixing is the way in; the point is to learn it, so every answer ends in practice.
      h("div.learn-it", null,
        h("h4", null, "Now learn it"),
        h("p", null, "Break this yourself in a safe playground and fix it. Doing it once is what makes you recognise it next time."),
        practiseRow(d.scenarios, "Practise:"),
        lv ? h("p.note", null, "Then the level that teaches it: ", h("a", { href: "#path", onclick: (e) => { e.preventDefault(); go("path", () => scrollToEl(document.getElementById(stageId(lv.stage)))); } }, `Level ${lv.id} · ${lv.title}`)) : null)));
    document.querySelectorAll("#doctor-list a.chip").forEach((a) => { if (a.getAttribute("href") === "#fix/" + id) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
    requestAnimationFrame(() => scrollToEl($("#doctor-out")));
  }

  // --- cheat sheet -------------------------------------------------------------------------------

  function copyButton(text) {
    return h("button.copy", {
      type: "button", "aria-label": "Copy command",
      onclick: async (e) => {
        const b = e.currentTarget;
        try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
        setTimeout(() => { b.textContent = "Copy"; }, 1200);
      }
    }, "Copy");
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const out = $("#cheat-out");
    out.replaceChildren();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try a tool (journalctl, ss) or a task (disk, port, cron).")); return; }
    const titles = scenarioTitles();
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => h("li", null,
        h("div", null, h("code", null, cmd), h("span.muted", null, what)),
        h("div.cheat-actions", null,
          where && window.LQPlayground
            ? h("button.copy", { type: "button", title: where === "any" ? "Run it in the playground" : `Run it in the scenario "${titles[where]}"`, onclick: () => window.LQPlayground.prefill(cmd, where) }, "Try")
            : h("span.copy.lab", { title: "Needs a real Linux machine" }, "Lab"),
          copyButton(cmd))))));
    }
  }

  // --- page guides -------------------------------------------------------------------------------

  // Open on the inner pages, closed on the busy landing page and the reference;
  // whatever the reader chooses afterwards is remembered per page.
  const GUIDES_CLOSED = ["playground", "path", "doctor", "xray"];
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide;
      const g = Q.guides[key];
      const box = h("details.guide", { open: state[key] ?? !GUIDES_CLOSED.includes(key) }, h("summary", null, "How to use this"),
        h("div.guide-body", null, h("p", null, ...rich(g.what)),
          h("div.guide-cols", null,
            h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))),
              h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      let shown = box.open;
      box.addEventListener("toggle", () => {
        if (box.open === shown) return;
        shown = box.open;
        store.set("guides", { ...store.get("guides", {}), [key]: shown });
      });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) -------------------------------------------------------

  const palette = $("#palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let paletteItems = [], paletteActive = 0;
  const go = (hash, then) => { location.hash = hash; show(); if (then) then(); };
  const ACTIONS = [
    { label: "Playground: fix a broken server", kind: "Section", run: () => go("path", () => scrollToEl($(".playground"))) },
    { label: "Your path", kind: "Section", run: () => go("path", () => scrollToEl($("#path-title"))) },
    { label: "Exam: random questions from every level", kind: "Quiz", run: () => go("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
    { label: "Unit file X-ray", kind: "Section", run: () => go("xray") },
    { label: "Fix: troubleshoot an error", kind: "Section", run: () => go("doctor", () => $("#doctor-q").focus()) },
    { label: "Cheat sheet", kind: "Section", run: () => go("cheats", () => $("#cheat-q").focus()) },
    { label: "Linux internals", kind: "Section", run: () => go("arch") },
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.title}`, kind: "Quiz", run: () => go("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...Q.doctor.map((d) => ({ label: d.title, hint: d.error, kind: "Troubleshoot", run: () => go("fix/" + d.id) }))
  ];
  function renderPalette() {
    const ws = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const scenarios = (window.LQPlayground ? window.LQPlayground.scenarios : []).map((sc) => ({ label: `Playground: ${sc.title}`, kind: "Practice", run: () => go("play/" + sc.id) }));
    paletteItems = [...ACTIONS, ...scenarios].filter((a) => { const t = `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase(); return ws.every((w) => t.includes(w)); }).slice(0, 8);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
    paletteList.replaceChildren(...paletteItems.map((a, i) => h("li", { role: "option", id: "pal-" + i, "aria-selected": String(i === paletteActive), onclick: () => choose(i), onmousemove: () => { if (paletteActive !== i) { paletteActive = i; renderPalette(); } } },
      h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!paletteItems.length) paletteList.append(h("li.pal-empty", null, "Nothing matches. Try a word such as cron, disk or sudo."));
    paletteInput.setAttribute("aria-activedescendant", paletteItems.length ? "pal-" + paletteActive : "");
  }
  function openPalette() {
    if (palette.open) return;
    paletteInput.value = "";
    paletteActive = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }
  function choose(i) { const a = paletteItems[i]; if (!a) return; palette.close(); a.run(); }
  paletteInput.addEventListener("input", () => { paletteActive = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = paletteItems.length;
      if (n) paletteActive = (paletteActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
    } else if (e.key === "Enter") { e.preventDefault(); choose(paletteActive); }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); } else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init ----------------------------------------------------------------------------------------

  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, `${lv.id} · ${lv.title} (${questionsFor(lv.id).length} questions)`));
  $("#quiz-level").value = "00";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", () => { renderQuiz(); $("#quiz-list").scrollIntoView({ block: "start" }); });
  $("#xray-pick").append(h("button", { type: "button", role: "tab", onclick: () => loadExample(-1) }, "Paste your own"),
    ...window.LQExplain.EXAMPLES.map((ex, i) => h("button", { type: "button", role: "tab", onclick: () => loadExample(i) }, ex.name)));
  $("#xray-go").addEventListener("click", explainInput);
  $("#xray-clear").addEventListener("click", () => { $("#xray-input").value = ""; $("#xray-error").hidden = true; $("#xray-result").hidden = true; $("#xray-view").hidden = true; });
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainInput(); });
  $("#doctor-q").addEventListener("input", renderDoctorList);
  // The home page's "Something broken?" box hands the pasted error to Troubleshoot.
  const doorGo = () => { $("#doctor-q").value = $("#door-q").value; go("doctor", () => { renderDoctorList(); $("#doctor-q").focus(); }); };
  $("#door-go").addEventListener("click", doorGo);
  $("#door-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doorGo(); });
  $("#cheat-q").addEventListener("input", renderCheats);
  $("#forget").addEventListener("click", forgetEverything);
  $("#cta-start").addEventListener("click", (e) => { e.preventDefault(); location.hash = "path"; show(); scrollToEl($("#path-title")); });
  $("#cta-try").addEventListener("click", (e) => { e.preventDefault(); practise("noexec"); });
  document.querySelectorAll("[data-goto]").forEach((t) => t.addEventListener("click", () => { location.hash = t.dataset.goto; if (t.dataset.goto === "path") scrollToEl($(".playground")); }));

  // Shared with the playground, architecture and engage scripts, which load after this one.
  window.LQUI = { h, rich, practise, copyLinkButton };

  renderGuides();
  renderQuiz();
  renderDoctorList();
  loadExample(0);
  window.addEventListener("DOMContentLoaded", () => {
    renderHero();
    renderPath();
    renderCheats();
    show();
  });
})();
