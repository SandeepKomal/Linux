// The Linux internals tab: user space, the system call boundary, the
// kernel's subsystems and the hardware. Every part can be pointed at, tapped
// or reached with Tab to read what it does and how it fails.
"use strict";

(function () {
  const { h, rich, practise } = window.LQUI;
  const parts = Object.fromEntries(window.TRACK.architecture.components.map((c) => [c.id, c]));
  const root = document.getElementById("arch");

  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }

  // Two hand-placed layouts. Boxes are [x, y, width, height]; edges are polylines.
  const LAYOUTS = {
    wide: {
      size: [1040, 560], font: [13, 11],
      panels: [["User space", 20, 20, 1000, 186, "user"], ["Kernel", 20, 222, 1000, 236, "kernel"], ["Hardware", 20, 474, 1000, 70, "hw"]],
      boxes: {
        shell: [40, 54, 200, 56], apps: [260, 54, 220, 56], systemd: [500, 54, 220, 56], users: [740, 54, 260, 56], libc: [40, 140, 680, 46],
        syscalls: [40, 254, 960, 44], sched: [40, 326, 220, 56], memory: [280, 326, 220, 56], vfs: [520, 326, 220, 56], net: [760, 326, 240, 56],
        drivers: [40, 400, 960, 40], hardware: [40, 494, 960, 40]
      },
      edges: [
        ["shell", "libc", [[140, 110], [140, 140]]], ["apps", "libc", [[370, 110], [370, 140]]], ["systemd", "libc", [[610, 110], [610, 140]]],
        ["libc", "syscalls", [[380, 186], [380, 254]]], ["users", "syscalls", [[870, 110], [870, 254]]],
        ["syscalls", "sched", [[150, 298], [150, 326]]], ["syscalls", "memory", [[390, 298], [390, 326]]], ["syscalls", "vfs", [[630, 298], [630, 326]]], ["syscalls", "net", [[880, 298], [880, 326]]],
        ["vfs", "drivers", [[630, 382], [630, 400]]], ["net", "drivers", [[880, 382], [880, 400]]], ["memory", "drivers", [[390, 382], [390, 400]]],
        ["drivers", "hardware", [[520, 440], [520, 494]]]
      ]
    },
    narrow: {
      size: [360, 900], font: [12, 11],
      panels: [["User space", 5, 10, 350, 300, "user"], ["Kernel", 5, 330, 350, 450, "kernel"], ["Hardware", 5, 800, 350, 90, "hw"]],
      boxes: {
        shell: [20, 40, 150, 50], apps: [190, 40, 150, 50], systemd: [20, 110, 150, 50], users: [190, 110, 150, 50], libc: [20, 230, 320, 48],
        syscalls: [20, 360, 320, 48], sched: [20, 440, 150, 50], memory: [190, 440, 150, 50], vfs: [20, 520, 150, 50], net: [190, 520, 150, 50],
        drivers: [20, 620, 320, 48], hardware: [20, 830, 320, 46]
      },
      edges: [
        ["shell", "libc", [[95, 90], [95, 100], [10, 100], [10, 200], [95, 200], [95, 230]]], ["apps", "libc", [[265, 90], [265, 100], [350, 100], [350, 200], [265, 200], [265, 230]]],
        ["systemd", "libc", [[95, 160], [95, 230]]], ["users", "syscalls", [[265, 160], [265, 215], [345, 215], [345, 345], [300, 345], [300, 360]]],
        ["libc", "syscalls", [[180, 278], [180, 360]]],
        ["syscalls", "sched", [[95, 408], [95, 440]]], ["syscalls", "memory", [[265, 408], [265, 440]]], ["syscalls", "vfs", [[180, 408], [180, 425], [10, 425], [10, 545], [20, 545]]], ["syscalls", "net", [[180, 408], [180, 425], [350, 425], [350, 545], [340, 545]]],
        ["vfs", "drivers", [[95, 570], [95, 620]]], ["net", "drivers", [[265, 570], [265, 620]]], ["memory", "drivers", [[265, 490], [265, 505], [180, 505], [180, 620]]],
        ["drivers", "hardware", [[180, 668], [180, 830]]]
      ]
    }
  };
  const KIND = { "User space": "user", Kernel: "kernel", Hardware: "hw" };

  const figure = h("div.arch-figure");
  // What happens when you run cat /etc/hostname, played on the diagram.
  const TOUR = [
    [[["shell", "libc"]], "You type `cat /etc/hostname`. bash finds /usr/bin/cat through PATH and forks a child process."],
    [[["libc", "syscalls"]], "The child calls execve() to become cat. cat then calls openat() and read() through the C library."],
    [[["users", "syscalls"]], "The kernel checks your user and groups against the file's owner and mode. No read bit: Permission denied."],
    [[["syscalls", "vfs"]], "The VFS walks the path to the ext4 file system on / and looks in the page cache."],
    [[["vfs", "drivers"], ["drivers", "hardware"]], "Not cached yet: the NVMe driver reads the block from the disk."],
    [[["syscalls", "sched"]], "While cat waits for the disk (state D), the scheduler runs other processes on the CPU."],
    [[["syscalls", "libc"], ["libc", "shell"]], "write() puts the text on your terminal. cat exits, and bash collects its exit status with wait()."]
  ];

  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow cat /etc/hostname");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any part to see what it does and how it fails.");
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let svg = null, dot = null, pinned = null, touring = 0, entered = false;

  function draw() {
    const L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const [w, ht] = L.size;
    const arrow = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "Linux internals" }, s("defs", null, arrow("arch-arrow"), arrow("arch-arrow-on")));
    for (const [label, x, y, pw, ph, kind] of L.panels) {
      svg.append(s("rect", { x, y, width: pw, height: ph, rx: 16, class: `arch-panel arch-${kind}` }), s("text", { x: x + 14, y: y + 22, class: "arch-panel-label" }, label));
    }
    for (const [from, to, pts] of L.edges) svg.append(s("polyline", { points: pts.join(" "), class: "arch-edge", "data-from": from, "data-to": to, "marker-end": "url(#arch-arrow)" }));
    Object.entries(L.boxes).forEach(([id, [x, y, bw, bh]], i) => {
      const c = parts[id];
      const g = s("g", { class: `arch-box arch-${KIND[c.where]}`, "data-id": id, tabindex: "0", role: "button", "aria-label": `${c.name}: ${c.short}` },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: y + bh / 2 - 3, class: "arch-name", "font-size": L.font[0] }, c.name),
        s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 2, class: "arch-short", "font-size": L.font[1] }, c.short));
      g.style.animationDelay = `${120 + i * 40}ms`;
      g.addEventListener("mouseenter", () => touring || select(id));
      g.addEventListener("focus", () => touring || select(id));
      g.addEventListener("click", () => { stopTour(); pinned = id; select(id); open(id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    });
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  // Light up some parts and edges; with one id, its neighbours too.
  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [e.dataset.from, e.dataset.to];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => {
      g.classList.toggle("is-on", ids.includes(g.dataset.id));
      g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id));
    });
  }
  function select(id) { light(id ? [id] : []); place(id); }

  function practiseRow(c) {
    const titles = Object.fromEntries(window.TRACK_SCENARIOS.map((x) => [x.id, x.title]));
    const ids = c.practise.filter((id) => titles[id]);
    return ids.length ? h("div.doctor-practise", null, h("span.muted.small", null, "Practise in the playground:"),
      ids.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, titles[id]))) : null;
  }
  // A click opens everything about a part below the diagram.
  function open(id) {
    const c = parts[id];
    detail.replaceChildren(h("div.card", null, h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("h4", null, "What it does"), h("ul", null, c.does.map((d) => h("li", null, rich(d)))),
      h("h4", null, "When it breaks"), h("p", null, rich(c.breaks)),
      h("h4", null, "Look at it"), h("pre", null, h("code", null, c.look.join("\n"))), practiseRow(c)));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }

  // On hover, a short tip beside the part; touch screens go straight to the click.
  function place(id) {
    const show = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(show));
    if (!show) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("p", null, h("strong", null, "When it breaks: "), rich(c.breaks)), h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    const left = right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12);
    const top = Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  // Move the dot along an edge, in either direction.
  function travel(from, to, run) {
    const e = [...svg.querySelectorAll(".arch-edge")].find((x) => (x.dataset.from === from && x.dataset.to === to) || (x.dataset.from === to && x.dataset.to === from));
    let pts = e.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    if (e.dataset.from !== from) pts = pts.reverse();
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (dd) => {
      for (const [a, b, len] of segs) { if (dd <= len) return [a[0] + (b[0] - a[0]) * dd / len, a[1] + (b[1] - a[1]) * dd / len]; dd -= len; }
      return pts[pts.length - 1];
    };
    dot.classList.add("is-on");
    return { edge: e, done: new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(450, total * 2.2), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), ease = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * ease);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    }) };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [hops, text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), ...rich(text));
      const edges = [];
      for (const [from, to] of hops) {
        const leg = travel(from, to, run);
        edges.push(leg.edge);
        light([...new Set(hops.flat())], edges);
        await leg.done;
        if (run !== touring) return;
      }
      await wait(still() ? 3200 : 1500);
      if (run !== touring) return;
    }
    stopTour("Played. Point at any part to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow cat /etc/hostname";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }

  // The diagram assembles itself the first time the tab opens.
  function enter() {
    if (entered || location.hash !== "#arch" || still()) return;
    entered = true;
    svg.classList.add("is-entering");
    setTimeout(() => svg.classList.remove("is-entering"), 1400);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); enter(); });
  // app.js loads this script after the first screen, usually after DOMContentLoaded.
  const start = () => {
    draw();
    root.replaceChildren(figure, detail);
    enter();
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start);
  else start();
})();
