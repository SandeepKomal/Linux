// The playground's page: a terminal on the simulated host, the scenario
// picker, and a live view of the host (services, disks, memory, load).
// The simulator itself is in sim.js, sim-ops.js, world.js and scenarios.js.
"use strict";

(function () {
  const L = window.LQSim;
  const { SCENARIOS, GROUPS } = L;
  const { h, copyLinkButton } = window.LQUI;
  const $ = (id) => document.getElementById(id);
  const out = $("pg-out"), form = $("pg-form"), input = $("pg-input"), map = $("pg-map"), goal = $("pg-goal"), picker = $("pg-scenarios"), tries = $("pg-try"), promptEl = $("pg-prompt");

  const saved = {
    get() { try { return JSON.parse(localStorage.getItem("lq:pg-solved")) || []; } catch { return []; } },
    add(id) { try { localStorage.setItem("lq:pg-solved", JSON.stringify([...new Set([...saved.get(), id])])); } catch { /* private mode */ } }
  };

  let scenario = SCENARIOS[0], host, solved, hintLevel;
  const history = [];
  let historyPos = 0;

  const HELP = [
    "Files     ls cd pwd cat less head tail grep find du stat file cp mv rm mkdir touch ln readlink tar sed tee chmod chown chattr lsattr",
    "Text      grep sort uniq cut awk wc tr xargs echo printf",
    "Processes ps top kill pkill pgrep renice ionice lsof uptime free vmstat iotop",
    "Services  systemctl (status start stop restart reload enable disable mask unmask daemon-reload cat show reset-failed set-property) journalctl dmesg",
    "Disks     df du lsblk blkid findmnt mount umount fsck growpart resize2fs swapon swapoff truncate",
    "Network   ip ss ping curl wget dig nslookup host getent nc ufw iptables hostname hostnamectl ssh",
    "Users     id groups whoami sudo su useradd usermod gpasswd groupadd passwd visudo",
    "System    apt dpkg crontab timedatectl sysctl uname date env export umask ulimit sleep reboot",
    "Playground  help · hint · reset · next · clear.  Tab completes; arrows recall commands. Shell: | && || ; > >> 2>&1 $VAR $(cmd) ( list )."
  ];

  function print(text, cls) {
    out.append(h("div.pg-line" + (cls ? "." + cls : ""), null, text));
    out.scrollTop = out.scrollHeight;
  }
  function prompt() {
    const s = host.sess;
    const home = (host.user(s.user) || {}).home;
    const where = s.cwd === home ? "~" : home && s.cwd.startsWith(home + "/") ? "~" + s.cwd.slice(home.length) : s.cwd;
    return `${s.user}@${host.hostname}:${where}${s.user === "root" ? "#" : "$"}`;
  }

  function renderPicker() {
    const done = new Set(saved.get());
    picker.replaceChildren(...GROUPS.map(([group, ids]) => {
      const n = ids.filter((id) => done.has(id)).length;
      return h("div.pg-group", null,
        h("span.pg-group-name", null, group, h("span.pg-group-count" + (n === ids.length ? ".done" : ""), null, `${n}/${ids.length}`)),
        h("div.pg-group-items", null, ids.map((id) => {
          const s = SCENARIOS.find((x) => x.id === id);
          return h("a.pg-scn", { href: "#play/" + id, "aria-current": s === scenario ? "true" : null, title: done.has(id) ? `${s.title} (solved)` : s.title },
            done.has(id) ? h("span.pg-scn-done", { "aria-hidden": "true" }, "✓") : null, s.title);
        })));
    }));
  }

  // The host at a glance: the scenario's live check, services, disks, memory and load.
  function renderMap() {
    const c = scenario.check(host);
    const bar = (frac, cls) => { const i = h("i." + cls); i.style.width = Math.round(Math.min(1, frac) * 100) + "%"; return h("span.pg-meter", { "aria-hidden": "true" }, i); };
    const rows = [h("div.pg-check." + (c.ok ? "ok" : "bad"), null, h("span.pg-dot", { "aria-hidden": "true" }, c.ok ? "✓" : "!"), h("span.pg-check-label", null, c.label), h("span.pg-check-text", null, c.text))];
    const units = Object.keys(host.units).filter((n) => !/timesyncd/.test(n) || scenario.id === "time").sort();
    rows.push(h("div.pg-node", null, h("div.pg-node-name", null, "Services"), units.map((n) => {
      const st = L.state(host, n).active;
      const cls = st === "active" ? "ok" : st === "failed" ? "bad" : "off";
      return h("button.pg-pod." + cls, { type: "button", title: `${n}: ${st}. Click to use the name.`, onclick: () => insert(n.replace(/\.service$/, "")) },
        h("span.pg-dot", { "aria-hidden": "true" }, st === "active" ? "✓" : st === "failed" ? "×" : "–"), n.replace(/\.service$/, ""));
    })));
    const disks = host.mounts.filter((m) => !m.gone && m.mnt !== "/boot/efi").map((m) => {
      const u = host.usage(m);
      const byte = Math.min(1, u.bytes / (m.size * (m.type === "ext4" ? 0.95 : 1)));
      const ino = m.inodes ? u.inodes / m.inodes : 0;
      const frac = Math.max(byte, ino);
      return h("div.pg-row", null, h("span.pg-row-name", null, m.mnt), bar(frac, frac > 0.9 ? "bad" : frac > 0.8 ? "warn" : "ok"),
        h("span.pg-row-val", null, `${Math.ceil(frac * 100)}%${ino > byte ? " inodes" : ""}${m.ro ? " ro" : ""}`));
    });
    const mem = L.memStats(host), cpu = L.cpuStats(host);
    rows.push(h("div.pg-node", null, h("div.pg-node-name", null, `${host.hostname} · ${host.emergency ? "emergency mode" : "up " + L.upFor(host)}`), ...disks,
      h("div.pg-row", null, h("span.pg-row-name", null, "memory"), bar(mem.used / mem.total, mem.used / mem.total > 0.9 ? "bad" : "ok"), h("span.pg-row-val", null, `${(mem.used / 1048576).toFixed(1)} of ${(mem.total / 1048576).toFixed(1)}G`)),
      mem.swap ? h("div.pg-row", null, h("span.pg-row-name", null, "swap"), bar(mem.swapUsed / mem.swap, mem.thrash ? "bad" : "ok"), h("span.pg-row-val", null, mem.thrash ? "thrashing" : `${(mem.swapUsed / 1048576).toFixed(1)}G`)) : null,
      h("div.pg-row", null, h("span.pg-row-name", null, "load"), bar(cpu.load[0] / (host.cpus * 2), cpu.load[0] > host.cpus ? "bad" : "ok"), h("span.pg-row-val", null, `${cpu.load[0].toFixed(2)} on ${host.cpus} CPUs`))));
    map.replaceChildren(...rows);
  }
  function insert(text) {
    const v = input.value;
    input.value = (v && !v.endsWith(" ") ? v + " " : v) + text;
    input.focus();
  }

  function renderTries() {
    tries.replaceChildren(h("span.muted.small", null, "Try"), ...[...scenario.tries, "hint", "reset"].map((cmd) =>
      h("button.chip", { type: "button", onclick: () => { run(cmd); input.focus(); } }, cmd)), copyLinkButton("play/" + scenario.id));
  }

  function load(id) {
    scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    host = new L.Host(scenario);
    solved = false;
    hintLevel = 0;
    out.replaceChildren();
    print(`${scenario.group} · ${scenario.title}`, "head");
    print(scenario.story, "dim");
    for (const l of scenario.intro || []) print(l);
    print("Find out why, then fix it. Type 'help' for commands, 'hint' if stuck.", "dim");
    print("");
    goal.textContent = "Goal: " + scenario.goal;
    goal.className = "pg-goal";
    promptEl.textContent = prompt();
    renderPicker();
    renderTries();
    renderMap();
    const cur = picker.querySelector('[aria-current="true"]');
    if (cur && picker.scrollWidth > picker.clientWidth) picker.scrollLeft = cur.offsetLeft - 48;
  }

  function check() {
    if (solved || !scenario.won(host)) return;
    solved = true;
    saved.add(scenario.id);
    renderPicker();
    const b = picker.querySelector('[aria-current="true"]');
    if (b) { b.classList.add("just-solved"); b.closest(".pg-group").querySelector(".pg-group-count").classList.add("bump"); }
    goal.textContent = "Fixed. " + scenario.done;
    goal.className = "pg-goal done";
    print("");
    print("✓ Fixed. " + scenario.lesson, "ok");
    const fix = window.QUEST.doctor.find((d) => (d.scenarios || []).includes(scenario.id));
    if (fix) print(`  Reference: ${fix.title} (Troubleshoot tab).`, "dim");
    const next = SCENARIOS.find((s) => !saved.get().includes(s.id));
    print(next ? `  Next: ${next.title}. Pick it above, or type 'next'.` : "  You solved every scenario. Now try the levels on a real machine.", "dim");
  }

  function run(raw) {
    const line = raw.trim();
    print(`${prompt()} ${line}`, "cmd");
    if (!line) return;
    if (line === "help") return HELP.forEach((l) => print(l, "dim"));
    if (line === "clear") return out.replaceChildren();
    if (line === "reset") return load(scenario.id);
    if (line === "next") {
      const next = SCENARIOS.find((s) => !saved.get().includes(s.id) && s !== scenario) || SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length];
      location.hash = "play/" + next.id;
      return;
    }
    if (line === "hint") return print(`Hint ${Math.min(hintLevel + 1, 3)} of 3: ${scenario.hints[Math.min(hintLevel++, scenario.hints.length - 1)].replace(/`/g, "")}`, "dim");
    let result;
    try { result = L.shell(host, line); } catch {
      result = [["(the playground could not run that; check the quoting, or type 'help')", "na"]];
    }
    for (const [text, cls] of result) print(text, cls);
    promptEl.textContent = prompt();
    renderMap();
    check();
  }

  // Tab completes command names, then paths.
  function complete() {
    const v = input.value;
    const start = v.lastIndexOf(" ") + 1;
    const word = v.slice(start);
    const first = !v.slice(0, start).trim();
    let names;
    const base = word.includes("/") ? word.slice(0, word.lastIndexOf("/") + 1) : "";
    if (first && !word.includes("/")) {
      names = [...new Set([...Object.keys(L.CMDS), "cd", "export", "umask", "ulimit", "help", "hint", "reset", "next", "clear"])];
    } else {
      const dir = L.norm(base || ".", host.sess.cwd);
      const r = host.lookup(dir, host.sess.user);
      names = r.node && r.node.t === "d" ? host.kids(r.path).map((k) => base + k + (host.fs.get(L.norm(k, r.path)) && host.fs.get(L.norm(k, r.path)).t === "d" ? "/" : "")) : [];
    }
    const hits = names.filter((n) => n.startsWith(word) && n !== word).sort();
    if (hits.length === 1) input.value = v.slice(0, start) + hits[0] + (hits[0].endsWith("/") ? "" : " ");
    else if (hits.length > 1) {
      let common = hits[0];
      for (const x of hits) while (!x.startsWith(common)) common = common.slice(0, -1);
      if (common.length > word.length) input.value = v.slice(0, start) + common;
      else print(hits.map((x) => x.slice(base.length)).join("   "), "dim");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value;
    if (value.trim()) { history.push(value); historyPos = history.length; }
    input.value = "";
    run(value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && historyPos > 0) { historyPos--; input.value = history[historyPos]; e.preventDefault(); }
    if (e.key === "ArrowDown") { historyPos = Math.min(history.length, historyPos + 1); input.value = history[historyPos] || ""; e.preventDefault(); }
    if (e.key === "Tab" && input.value.trim()) { e.preventDefault(); complete(); }
  });
  out.addEventListener("click", () => { if (!window.getSelection().toString()) input.focus(); });

  const reveal = () => { $("pg-term").scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); input.focus({ preventScroll: true }); };
  window.LQPlayground = {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title })),
    load: (id) => { if (id !== scenario.id || !host) load(id); reveal(); },
    // From the cheat sheet: open the scenario a command needs and run it there.
    prefill: (cmd, where) => {
      if (where !== "any") location.hash = "play/" + where;
      else location.hash = "path";
      setTimeout(() => { reveal(); run(cmd); }, 0);
    }
  };
  load(SCENARIOS[0].id);
})();
