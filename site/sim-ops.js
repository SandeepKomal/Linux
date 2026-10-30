// Linux Quest simulator, part 2: processes and signals, systemd and the
// journal, disks and mounts, the network, users and sudo, packages, cron,
// time, and reboots. Output formats follow Ubuntu 24.04 (systemd 255,
// procps-ng 4, util-linux 2.39, iproute2 6, curl 8, BIND 9.18).
"use strict";

(function (root) {
  const L = root.LQSim;
  const { CMDS, ERR, ok, fail, opts, norm, dirname, basename, human, stamp, longDate, hms, lines, MiB, GiB, KiB } = L;

  // --- time ------------------------------------------------------------------------

  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min ${s % 60}s ago`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${hr}h ${m % 60}min ago`;
    const dd = Math.floor(hr / 24);
    return `${dd} day${dd === 1 ? "" : "s"} ${hr % 24}h ago`;
  }
  function upFor(h) {
    const m = Math.floor((h.clock - h.boot) / 60000);
    const dd = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
    return `${dd ? `${dd} day${dd === 1 ? "" : "s"}, ` : ""}${dd || hh ? `${String(hh).padStart(2)}:${String(mm).padStart(2, "0")}` : `${mm} min`}`;
  }

  // --- processes -------------------------------------------------------------------

  // A process: {pid, ppid, user, comm, args, stat, cpu, rss (KiB), vsz, start,
  // fds, listen, unit, nofile, ni, io, ioVictim, onSignal}.
  function spawn(h, p) {
    const proc = { pid: h.nextPid++, ppid: 1, user: "root", stat: "S", cpu: 0, rss: 8000, vsz: 120000, start: h.clock, tty: "?",
      fds: [], listen: [], ni: 0, nofile: 1024, oomAdj: 0, ...p };
    if (p.pid) h.nextPid = Math.max(h.nextPid, p.pid + 1);
    proc.args = proc.args || proc.comm;
    h.procs.push(proc);
    return proc;
  }
  const procOf = (h, pid) => h.procs.find((p) => p.pid === Number(pid));
  // Heavy I/O makes its victims wait in D; idle I/O priority lets them run.
  const ioHogs = (h) => h.procs.filter((p) => p.io && p.ioclass !== 3);
  const statOf = (h, p) => (p.ioVictim && ioHogs(h).length ? "D" : p.stat);
  function cpuStats(h) {
    const ncpu = h.cpus || 2;
    const busy = h.procs.reduce((s, p) => s + (statOf(h, p) === "Z" ? 0 : p.cpu), 0);
    const nD = h.procs.filter((p) => statOf(h, p) === "D").length;
    const us = Math.min(100, busy / ncpu * 0.85), sy = Math.min(100 - us, busy / ncpu * 0.15 + 0.4);
    const wa = nD ? Math.min(100 - us - sy, 78 + nD) : 0.1;
    const load = Math.round((busy / 100 + nD + 0.04) * 100) / 100;
    return { us, sy, wa, id: Math.max(0, 100 - us - sy - wa), load: [load, Math.round(load * 0.93 * 100) / 100, Math.round(load * 0.81 * 100) / 100] };
  }
  function memStats(h) {
    const m = h.mem;
    const rss = h.procs.reduce((s, p) => s + (statOf(h, p) === "Z" ? 0 : p.rss), 0);
    const used = Math.min(m.total - 60 * 1024, rss + m.kernel);
    const over = Math.max(0, rss + m.kernel - m.total + 60 * 1024);
    const swapUsed = Math.min(m.swap, (m.swapBase || 0) + over);
    const cache = Math.max(40 * 1024, Math.min(m.cache, m.total - used - 50 * 1024));
    const free = Math.max(0, m.total - used - cache);
    return { total: m.total, used, free, cache, shared: 12 * 1024, avail: Math.max(0, free + cache * 0.7), swap: m.swap, swapUsed, swapFree: m.swap - swapUsed, thrash: over > 0 || swapUsed > m.swap * 0.8 };
  }
  const SIG = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15, CONT: 18, STOP: 19 };
  const sigName = (s) => {
    const k = String(s).toUpperCase().replace(/^SIG/, "");
    if (SIG[k]) return k;
    const n = Number(s);
    return Object.keys(SIG).find((x) => SIG[x] === n) || null;
  };

  // Deliver a signal. Returns an error string, or null.
  function signal(h, pid, sig, by) {
    const p = procOf(h, pid);
    if (!p) return "ESRCH";
    if (by !== "root" && p.user !== by) return "EPERM";
    if (sig === 0 || sig === "CONT") return null;
    if (p.stat === "Z") return null;
    if (statOf(h, p) === "D") return null;
    if (p.onSignal && p.onSignal(h, sig, p) === true) return null;
    if (sig === "HUP" && p.hup) return null;
    if (sig === "STOP") { p.stat = "T"; return null; }
    if (p.ignore && p.ignore.includes(sig)) return null;
    die(h, p, sig === "KILL" ? "killed" : "signal", sig);
    return null;
  }
  // A process ends: its children are reparented to init, which reaps zombies.
  function die(h, p, how, sig) {
    h.procs = h.procs.filter((x) => x !== p);
    for (const kid of h.procs.filter((x) => x.ppid === p.pid)) {
      if (kid.stat === "Z") h.procs = h.procs.filter((x) => x !== kid);
      else if (kid.thread || kid.child) die(h, kid, how, sig);
      else kid.ppid = 1;
    }
    if (p.unit && h.units[p.unit] && h.units[p.unit].pid === p.pid) mainExited(h, p.unit, how, sig, p);
  }

  // --- systemd ------------------------------------------------------------------------

  const unitName = (n) => (/\.(service|timer|target|socket|mount)$/.test(n) ? n : n + ".service");
  const UNIT_DIRS = ["/etc/systemd/system", "/usr/lib/systemd/system"];
  function unitFile(h, name) {
    for (const d of UNIT_DIRS) {
      const n = h.fs.get(`${d}/${name}`);
      if (n && n.t === "l" && n.to === "/dev/null") return { masked: true, path: `${d}/${name}` };
      if (n) return { path: `${d}/${name}` };
    }
    return null;
  }
  function dropins(h, name) {
    return UNIT_DIRS.flatMap((d) => h.kids(`${d}/${name}.d`).filter((k) => k.endsWith(".conf")).map((k) => `${d}/${name}.d/${k}`));
  }
  function diskText(h, name) {
    const f = unitFile(h, name);
    if (!f || f.masked) return null;
    return [h.read(f.path) || "", ...dropins(h, name).map((p) => h.read(p) || "")].join("\n");
  }
  // systemd works from the unit files it loaded at the last daemon-reload.
  function loadedText(h, name) {
    if (!(name in h.loaded)) h.loaded[name] = diskText(h, name);
    return h.loaded[name];
  }
  const changedOnDisk = (h, name) => name in h.loaded && h.loaded[name] !== diskText(h, name) && diskText(h, name) !== null;
  function parseUnit(text) {
    const u = { Unit: {}, Service: {}, Install: {} };
    let sec = null;
    for (const raw of (text || "").split("\n")) {
      const l = raw.trim();
      if (!l || l.startsWith("#") || l.startsWith(";")) continue;
      const s = /^\[(\w+)\]$/.exec(l);
      if (s) { sec = u[s[1]] = u[s[1]] || {}; continue; }
      const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(l);
      if (!kv || !sec) continue;
      // An empty assignment resets a list, as in a drop-in's "ExecStart=".
      if (kv[2] === "") { sec[kv[1]] = []; continue; }
      (sec[kv[1]] = sec[kv[1]] || []).push(kv[2]);
    }
    const one = (sec, k) => (u[sec][k] || []).slice(-1)[0];
    const list = (sec, k) => (u[sec][k] || []).flatMap((v) => v.split(/\s+/)).filter(Boolean);
    const env = {};
    for (const v of u.Service.Environment || []) for (const m of v.matchAll(/"([^"]*)"|(\S+)/g)) { const [k, ...r] = (m[1] || m[2]).split("="); env[k] = r.join("="); }
    return { raw: u, one, list, env, desc: one("Unit", "Description") || "", exec: one("Service", "ExecStart"), user: one("Service", "User"),
      type: one("Service", "Type") || "simple", restart: one("Service", "Restart") || "no", wantedBy: list("Install", "WantedBy"), after: list("Unit", "After"),
      wants: [...list("Unit", "Wants"), ...list("Unit", "Requires")] };
  }
  const cfgOf = (h, name) => parseUnit(loadedText(h, name));
  function enabledState(h, name) {
    const f = unitFile(h, name);
    if (!f) return null;
    if (f.masked) return "masked";
    if ([...h.fs.keys()].some((k) => /^\/etc\/systemd\/system\/[^/]+\.wants\//.test(k) && k.endsWith("/" + name))) return "enabled";
    return parseUnit(diskText(h, name)).wantedBy.length ? "disabled" : "static";
  }
  const state = (h, name) => (h.units[name] = h.units[name] || { active: "inactive", sub: "dead", since: h.boot, starts: [] });
  const isUp = (h, name) => state(h, name).active === "active" && (state(h, name).readyAt || 0) <= h.clock;

  const EXIT = { 1: "FAILURE", 2: "INVALIDARGUMENT", 200: "CHDIR", 203: "EXEC", 217: "USER", 226: "NAMESPACE", 9: "KILL", 15: "TERM" };
  // Start one attempt of a service. Returns true when its main process runs.
  function launch(h, name) {
    const cfg = cfgOf(h, name);
    const st = state(h, name);
    const sd = (msg, prio) => h.log("systemd", msg, { pid: 1, unit: name, prio });
    const label = `${name}${cfg.desc ? " - " + cfg.desc : ""}`;
    const failNow = (pid, code, logs, result = "exit-code") => {
      for (const [who, msg] of logs) h.log(who === "sd" ? "systemd" : who, msg, { pid: who === "sd" ? 1 : pid, unit: name, prio: 3 });
      if (result === "exit-code") sd(`${name}: ${cfg.type === "forking" ? "Control" : "Main"} process exited, code=exited, status=${code}/${EXIT[code] || "n/a"}`, 4);
      sd(`${name}: Failed with result '${result}'.`, 4);
      if (cfg.type !== "simple" && cfg.type !== "exec" || result === "resources") sd(`Failed to start ${label}.`, 3);
      Object.assign(st, { active: "failed", sub: "failed", result, since: h.clock, pid: null, lastPid: pid, code, cmd: cfg.exec });
      return false;
    };
    sd(`Starting ${label}...`);
    if (!cfg.exec) return failNow(null, 0, [["sd", `${name}: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.`]], "resources");
    const argv = cfg.exec.replace(/^[-@:+!]+/, "").split(/\s+/);
    const bin = argv[0];
    const pid = h.nextPid++;
    for (const ef of cfg.raw.Service.EnvironmentFile || []) {
      const path = ef.replace(/^-/, "");
      const text = h.read(path);
      if (text == null && !ef.startsWith("-")) {
        return failNow(null, 0, [["sd", `${name}: Failed to load environment files: No such file or directory`], ["sd", `${name}: Failed to spawn 'start' task: No such file or directory`]], "resources");
      }
      for (const l of lines(text || "")) { const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(l); if (m) cfg.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1"); }
    }
    const user = cfg.user || "root";
    if (!h.user(user)) return failNow(pid, 217, [["sd", `${name}: Failed to determine user credentials: No such process`], ["sd", `${name}: Failed at step USER spawning ${bin}: No such process`]]);
    const wd = cfg.one("Service", "WorkingDirectory");
    if (wd && !h.lookup(wd, user).node) return failNow(pid, 200, [["sd", `${name}: Changing to the requested working directory failed: No such file or directory`], ["sd", `${name}: Failed at step CHDIR spawning ${bin}: No such file or directory`]]);
    const r = h.lookup(bin, user);
    if (r.err === "ENOENT" || !r.node) return failNow(pid, 203, [["sd", `${name}: Failed to locate executable ${bin}: No such file or directory`], ["sd", `${name}: Failed at step EXEC spawning ${bin}: No such file or directory`]]);
    if (r.err || !h.can(user, r.node, 1)) return failNow(pid, 203, [["sd", `${name}: Failed to locate executable ${bin}: Permission denied`], ["sd", `${name}: Failed at step EXEC spawning ${bin}: Permission denied`]]);
    if (r.node.data && r.node.data.startsWith("#!") && /\r/.test(r.node.data.split("\n")[0])) {
      return failNow(pid, 203, [["sd", `${name}: Failed to execute ${bin}: No such file or directory`], ["sd", `${name}: Failed at step EXEC spawning ${bin}: No such file or directory`]]);
    }
    const app = h.apps[r.path] || h.apps[bin] || (() => ({}));
    const nofile = Number(cfg.one("Service", "LimitNOFILE")) || 1024;
    const res = app(h, { name, cfg, env: cfg.env, user, argv, nofile, pid }) || {};
    const ident = res.ident || basename(bin);
    if (cfg.type === "simple" || cfg.type === "exec") sd(`Started ${label}.`);
    if (res.fail) {
      for (const l of res.fail.log || []) h.log(ident, l, { pid, unit: name, prio: 3 });
      return failNow(pid, res.fail.code || 1, []);
    }
    const proc = spawn(h, { pid, user, comm: ident, args: argv.join(" ").replace(/\$\{?(\w+)\}?/g, (m, k) => cfg.env[k] || ""), unit: name, nofile, cwd: wd || "/", ...res.proc });
    for (const kid of res.kids || []) spawn(h, { user, unit: name, ppid: proc.pid, child: true, start: h.clock, ...kid });
    for (const l of res.log || []) h.log(ident, l, { pid, unit: name });
    if (cfg.type !== "simple" && cfg.type !== "exec") sd(`Started ${label}.`);
    Object.assign(st, { active: "active", sub: "running", result: "success", since: h.clock, pid: proc.pid, readyAt: h.clock + (res.ready || 0) * 1000, by: h.booting ? "boot" : "manual" });
    return true;
  }
  // Start with the unit's restart policy and start limit (5 starts in 10 s).
  function start(h, name) {
    const f = unitFile(h, name);
    if (f && f.masked) return [`Failed to start ${name}: Unit ${name} is masked.`];
    if (!f || loadedText(h, name) === null) return [`Failed to start ${name}: Unit ${name} not found.`];
    const st = state(h, name);
    if (st.active === "active") return [];
    const cfg = cfgOf(h, name);
    const limit = Number(cfg.one("Unit", "StartLimitIntervalSec") || 10) * 1000;
    const burst = Number(cfg.one("Unit", "StartLimitBurst") || 5);
    if (st.result === "start-limit-hit" && h.clock - st.since < limit) {
      return [`Job for ${name} failed because start of the service was attempted too often.`, `See "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`,
        `To force a start use "systemctl reset-failed ${name}"`, `followed by "systemctl start ${name}" again.`];
    }
    const t0 = h.clock;
    const restartSec = Number(String(cfg.one("Service", "RestartSec") || "0.1").replace(/s$/, ""));
    for (let attempt = 0; attempt < 40; attempt++) {
      st.starts = (st.starts || []).filter((t) => h.clock - t < limit).concat(h.clock);
      if (launch(h, name)) break;
      const again = (cfg.restart === "on-failure" || cfg.restart === "always") && st.result !== "resources";
      if (!again) break;
      h.clock += restartSec * 1000;
      h.log("systemd", `${name}: Scheduled restart job, restart counter is at ${st.starts.length}.`, { pid: 1, unit: name });
      if (st.starts.length >= burst) {
        h.log("systemd", `${name}: Start request repeated too quickly.`, { pid: 1, unit: name, prio: 4 });
        h.log("systemd", `${name}: Failed with result 'start-limit-hit'.`, { pid: 1, unit: name, prio: 4 });
        h.log("systemd", `Failed to start ${name}${cfg.desc ? " - " + cfg.desc : ""}.`, { pid: 1, unit: name, prio: 3 });
        Object.assign(st, { result: "start-limit-hit", since: h.clock });
        break;
      }
    }
    if (!h.booting) h.clock = Math.max(t0, h.clock);
    if (st.active === "active" || cfg.type === "simple" || cfg.type === "exec") return [];
    return [`Job for ${name} failed because the control process exited with error code.`, `See "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`];
  }
  function stop(h, name) {
    const st = state(h, name);
    if (st.active !== "active") { if (st.active === "failed") Object.assign(st, { active: "failed" }); return; }
    const cfg = cfgOf(h, name);
    const label = `${name}${cfg.desc ? " - " + cfg.desc : ""}`;
    h.log("systemd", `Stopping ${label}...`, { pid: 1, unit: name });
    const p = procOf(h, st.pid);
    st.stopping = true;
    if (p) {
      if (p.onSignal) p.onSignal(h, "TERM", p);
      for (const x of h.procs.filter((q) => q.unit === name)) h.procs = h.procs.filter((q) => q !== x);
    }
    st.stopping = false;
    h.log("systemd", `${name}: Deactivated successfully.`, { pid: 1, unit: name });
    h.log("systemd", `Stopped ${label}.`, { pid: 1, unit: name });
    Object.assign(st, { active: "inactive", sub: "dead", result: "success", since: h.clock, pid: null });
  }
  // The main process went away without systemctl stop.
  function mainExited(h, name, how, sig, p) {
    const st = state(h, name);
    if (st.stopping) return;
    const cfg = cfgOf(h, name);
    for (const x of h.procs.filter((q) => q.unit === name)) h.procs = h.procs.filter((q) => q !== x);
    const clean = how === "signal" && (sig === "TERM" || sig === "INT" || sig === "HUP");
    const exited = how === "exit";
    const result = clean || exited ? "success" : p.oomKilled ? "oom-kill" : "signal";
    h.log("systemd", exited ? `${name}: Main process exited, code=exited, status=0/SUCCESS` : `${name}: Main process exited, code=killed, status=${SIG[sig] || 9}/${sig || "KILL"}`, { pid: 1, unit: name, prio: clean || exited ? 6 : 4 });
    if (result === "success") h.log("systemd", `${name}: Deactivated successfully.`, { pid: 1, unit: name });
    else h.log("systemd", `${name}: Failed with result '${result}'.`, { pid: 1, unit: name, prio: 4 });
    Object.assign(st, { active: result === "success" ? "inactive" : "failed", sub: result === "success" ? "dead" : "failed", result, since: h.clock, pid: null, lastPid: p.pid, code: SIG[sig] || 9, killed: sig });
    if (cfg.restart === "always" || (cfg.restart === "on-failure" && result !== "success")) {
      h.log("systemd", `${name}: Scheduled restart job, restart counter is at 1.`, { pid: 1, unit: name });
      start(h, name);
    }
  }

  // Boot: mount /etc/fstab, then start enabled units in After= order.
  function bootUp(h, first) {
    const now = h.clock;
    h.booting = true;
    h.clock = h.boot + 2000;
    h.loaded = {};
    h.fstabSeen = h.read("/etc/fstab");
    // A kernel installed since the last boot is the one that boots now.
    if (h.pendingKernel && !first) {
      h.kernel = h.pendingKernel;
      h.pendingKernel = null;
      h.fs.delete("/run/reboot-required");
      h.fs.delete("/run/reboot-required.pkgs");
    }
    h.dmesg(`Linux version ${h.kernel} (buildd@lcy02-amd64-075) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0) #16-Ubuntu SMP`, 0);
    if (!mountFstab(h, true)) { h.booting = false; if (first) h.clock = now; return; }
    const wanted = [...h.fs.keys()].filter((k) => /^\/etc\/systemd\/system\/multi-user\.target\.wants\/[^/]+$/.test(k)).map(basename);
    const order = [];
    const visit = (n, seen = new Set()) => {
      if (order.includes(n) || seen.has(n) || !wanted.includes(n)) return;
      seen.add(n);
      for (const dep of cfgOf(h, n).after) visit(dep, seen);
      order.push(n);
    };
    wanted.sort().forEach((n) => visit(n));
    for (const n of order) {
      const cfg = cfgOf(h, n);
      // Units without After= start together; ordering waits for readiness.
      const deps = cfg.after.filter((dep) => order.includes(dep)).map((dep) => state(h, dep).readyAt || h.clock);
      h.clock = Math.max(h.boot + 3000, ...deps);
      start(h, n);
    }
    h.booting = false;
    h.log("systemd", "Reached target multi-user.target - Multi-User System.", { pid: 1 });
    h.log("systemd", `Startup finished in 2.416s (kernel) + 8.951s (userspace) = 11.367s.`, { pid: 1 });
    if (first) h.clock = now; else h.clock = Math.max(h.clock, h.boot + 45000);
  }
  // Mount every fstab line. A line that fails without nofail stops the boot.
  function mountFstab(h, booting) {
    const entries = fstab(h);
    for (const e of entries) {
      if (e.mnt === "/" || e.type === "swap" || h.mounts.some((m) => m.mnt === e.mnt && !m.gone)) continue;
      const dev = findDev(h, e.spec);
      if (!dev) {
        if (!booting) continue;
        const unitN = e.mnt.slice(1).replace(/\//g, "-") + ".mount";
        if (e.opts.includes("nofail")) { h.log("systemd", `${e.spec.replace(/=/, "\\x3d")}: Job dev-disk-by\\x2duuid.device/start timed out.`, { pid: 1, prio: 4 }); continue; }
        h.log("systemd", `dev-disk-by\\x2duuid-${e.spec.split("=")[1] || e.spec}.device: Job dev-disk-by\\x2duuid-${(e.spec.split("=")[1] || "").replace(/-/g, "\\x2d")}.device/start timed out.`, { pid: 1, prio: 3 });
        h.log("systemd", `Timed out waiting for device dev-disk-by\\x2duuid-${(e.spec.split("=")[1] || "").replace(/-/g, "\\x2d")}.device - /dev/disk/by-uuid/${e.spec.split("=")[1] || e.spec}.`, { pid: 1, prio: 3 });
        h.log("systemd", `Dependency failed for ${unitN} - ${e.mnt}.`, { pid: 1, prio: 3 });
        h.log("systemd", "Dependency failed for local-fs.target - Local File Systems.", { pid: 1, prio: 3 });
        h.log("systemd", "local-fs.target: Job local-fs.target/start failed with result 'dependency'.", { pid: 1, prio: 3 });
        h.log("systemd", "Started emergency.service - Emergency Shell.", { pid: 1 });
        h.log("systemd", "Reached target emergency.target - Emergency Mode.", { pid: 1 });
        h.emergency = true;
        const rootM = h.mounts.find((m) => m.mnt === "/");
        if (rootM) rootM.ro = true;
        return false;
      }
      doMount(h, dev, e.mnt, e.opts, e.type);
    }
    return true;
  }
  function fstab(h) {
    return lines(h.read("/etc/fstab") || "").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      const [spec, mnt, type, o, , pass] = l.split(/\s+/);
      return { spec, mnt, type, opts: o || "defaults", pass };
    });
  }
  function findDev(h, spec) {
    const parts = h.disks.flatMap((dk) => dk.parts || []);
    if (/^UUID=/.test(spec)) return parts.find((p) => p.uuid === spec.slice(5).replace(/"/g, ""));
    if (/^LABEL=/.test(spec)) return parts.find((p) => p.label === spec.slice(6));
    return parts.find((p) => "/dev/" + p.name === spec);
  }
  function doMount(h, part, mnt, o, type) {
    const prev = h.mounts.find((m) => m.dev === "/dev/" + part.name);
    const m = prev || { dev: "/dev/" + part.name, type: type || part.fs, size: part.fsSize || part.size, base: part.used || 0, inodes: part.inodes, ibase: part.iused || 11 };
    Object.assign(m, { mnt, gone: false, ro: /(^|,)ro(,|$)/.test(o) || Boolean(part.ro), opts: o === "defaults" ? "rw,relatime" : o });
    if (!prev) h.mounts.push(m);
    if (!h.fs.has(mnt)) h.dir(mnt);
    return m;
  }

  // Reboot: everything in memory goes; what is on disk decides what comes back.
  function reboot(h) {
    h.boots++;
    h.clock += 40000;
    h.boot = h.clock - 45000;
    h.procs = [];
    h.units = {};
    h.emergency = false;
    h.kmsg = [];
    for (const m of h.mounts) if (m.mnt !== "/") m.gone = true;
    const rootM = h.mounts.find((m) => m.mnt === "/");
    if (rootM) rootM.ro = false;
    h.sysctl = { ...h.sysctlDefaults };
    applySysctlFiles(h);
    h.hostname = (h.read("/etc/hostname") || "web-01").trim();
    if (L.world.system) L.world.system(h);
    bootUp(h, false);
    h.sess = h.newSession(h.emergency ? "root" : h.scenario.user || "ubuntu");
  }

  // --- procfs ------------------------------------------------------------------------

  function procfs(h, path, user) {
    const parts = path.split("/").filter(Boolean);
    const vfile = (gen, write, mode = 0o444) => ({ path, node: { t: "f", virtual: true, u: "root", g: "root", m: mode, gen: () => gen(), write } });
    const vdir = (list) => ({ path, node: { t: "d", virtual: true, u: "root", g: "root", m: 0o555, list } });
    if (parts.length === 1) return vdir(() => h.procs.map((p) => ({ name: String(p.pid), path: `/proc/${p.pid}`, node: { t: "d", u: p.user, g: p.user, m: 0o555, mt: p.start } })));
    if (parts[1] === "meminfo") {
      const m = memStats(h);
      return vfile(() => [`MemTotal:       ${String(m.total).padStart(8)} kB`, `MemFree:        ${String(Math.round(m.free)).padStart(8)} kB`, `MemAvailable:   ${String(Math.round(m.avail)).padStart(8)} kB`,
        `Cached:         ${String(Math.round(m.cache)).padStart(8)} kB`, `SwapTotal:      ${String(m.swap).padStart(8)} kB`, `SwapFree:       ${String(Math.round(m.swapFree)).padStart(8)} kB`]);
    }
    if (parts[1] === "loadavg") { const c = cpuStats(h); return vfile(() => [`${c.load.map((x) => x.toFixed(2)).join(" ")} 2/${h.procs.length + 140} ${h.nextPid}`]); }
    if (parts[1] === "mounts") return vfile(() => h.mounts.filter((m) => !m.gone).map((m) => `${m.dev} ${m.mnt} ${m.type} ${m.ro ? "ro" : "rw"},relatime 0 0`));
    if (parts[1] === "swaps") return vfile(() => ["Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority", ...(h.mem.swap ? [`/swap.img                               file\t\t${h.mem.swap}\t\t${Math.round(memStats(h).swapUsed)}\t\t-2`] : [])]);
    if (parts[1] === "sys") {
      const key = parts.slice(2).join(".");
      if (!(key in h.sysctl)) return { err: "ENOENT" };
      return vfile(() => [String(h.sysctl[key])], (data, u) => {
        if (u !== "root") return "EACCES";
        if (data.trim()) h.sysctl[key] = data.trim();
        return null;
      }, 0o644);
    }
    const p = procOf(h, parts[1]);
    if (!p) return { err: "ENOENT" };
    const sub = parts.slice(2);
    if (!sub.length) return vdir(() => ["cmdline", "cwd", "fd", "limits", "oom_score_adj", "status"].map((n) => ({ name: n, path: `${path}/${n}`, node: { t: n === "fd" ? "d" : "f", u: p.user, g: p.user, m: 0o444, mt: p.start } })));
    if (sub[0] === "cmdline") return vfile(() => [p.args]);
    if (sub[0] === "status") return vfile(() => [`Name:\t${p.comm}`, `State:\t${statOf(h, p)} (${{ S: "sleeping", R: "running", D: "disk sleep", Z: "zombie", T: "stopped" }[statOf(h, p)[0]]})`, `Pid:\t${p.pid}`, `PPid:\t${p.ppid}`,
      `Uid:\t${(h.user(p.user) || { uid: 0 }).uid}`, `VmRSS:\t${String(p.rss).padStart(8)} kB`, `Threads:\t${1 + h.procs.filter((x) => x.ppid === p.pid && x.thread).length}`]);
    if (sub[0] === "oom_score_adj") {
      return vfile(() => [String(p.oomAdj)], (data, u) => {
        if (u !== "root") return "EACCES";
        const v = Number(data.trim());
        if (data.trim() && (!Number.isInteger(v) || v < -1000 || v > 1000)) return "EINVAL";
        if (data.trim()) p.oomAdj = v;
        return null;
      }, 0o644);
    }
    if (sub[0] === "limits") {
      return vfile(() => ["Limit                     Soft Limit           Hard Limit           Units     ", "Max cpu time              unlimited            unlimited            seconds   ",
        "Max file size             unlimited            unlimited            bytes     ", "Max processes             15209                15209                processes ",
        `Max open files            ${String(p.nofile).padEnd(21)}${String(Math.max(p.nofile, 524288)).padEnd(21)}files     `, "Max locked memory         8388608              8388608              bytes     "]);
    }
    if (sub[0] === "cwd") return { path, node: { t: "l", u: p.user, g: p.user, m: 0o777, to: p.cwd || "/", mt: p.start } };
    if (sub[0] === "fd") {
      if (user !== "root" && user !== p.user) return { err: "EACCES" };
      const fds = [{ fd: 0, path: "/dev/null" }, { fd: 1, path: "socket:[38211]" }, { fd: 2, path: "socket:[38211]" }, ...p.fds];
      if (sub.length === 1) return vdir(() => fds.map((f) => ({ name: String(f.fd), path: `${path}/${f.fd}`, node: { t: "l", u: p.user, g: p.user, m: 0o700, to: f.path + (f.deleted ? " (deleted)" : ""), mt: p.start } })));
      const f = fds.find((x) => String(x.fd) === sub[1]);
      if (!f) return { err: "ENOENT" };
      if (!f.deleted) return h.lookup(f.path, user);
      return { path, node: { t: "f", virtual: true, u: p.user, g: p.user, m: 0o644, size: f.size, gen: () => [], write: (data) => { f.size = data.length; return null; } } };
    }
    return { err: "ENOENT" };
  }

  // --- builtins ----------------------------------------------------------------------

  function builtin(c, name, args, stdin) {
    const h = c.h, s = h.sess;
    switch (name) {
      case "cd": {
        const target = args[0] == null || args[0] === "~" ? c.env.HOME : args[0] === "-" ? s.oldpwd || s.cwd : args[0];
        const p = norm(target, c.cwd);
        const where = c.script ? `${c.script}: line ${c.line}: cd` : "-bash: cd";
        const r = h.lookup(p, c.user);
        if (r.err) return fail(`${where}: ${args[0]}: ${ERR[r.err]}`);
        if (r.node.t !== "d") return fail(`${where}: ${args[0]}: Not a directory`);
        if (!h.can(c.user, r.node, 1)) return fail(`${where}: ${args[0]}: ${ERR.EACCES}`);
        // In a script or a cron job, cd moves that script only.
        if (c.own) { c.own.cwd = p; return ok(); }
        s.oldpwd = s.cwd;
        s.cwd = p;
        s.env.PWD = p;
        return ok();
      }
      case "pwd": return ok([c.own ? c.own.cwd : c.cwd]);
      case "echo": {
        let a = [...args], nl = true, esc = false;
        while (/^-[neE]+$/.test(a[0] || "")) { const f = a.shift(); if (f.includes("n")) nl = false; if (f.includes("e")) esc = true; }
        let text = a.join(" ");
        if (esc) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
        const out = text.split("\n");
        if (!nl) out.noNewline = true;
        return ok(out);
      }
      case "printf": {
        const [fmt = "", ...rest] = args;
        let i = 0;
        const text = fmt.replace(/%[sd]/g, () => rest[i++] || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
        const out = text.split("\n");
        if (out[out.length - 1] === "") out.pop(); else out.noNewline = true;
        return ok(out);
      }
      case "export":
        if (!args.length) return ok(Object.entries(s.env).map(([k, v]) => `declare -x ${k}="${v}"`));
        for (const a of args) { const [k, ...v] = a.split("="); if (v.length) s.env[k] = v.join("="); }
        return ok();
      case "unset": for (const a of args) delete s.env[a]; return ok();
      case "umask":
        if (!args.length) return ok([s.umask.toString(8).padStart(4, "0")]);
        if (args[0] === "-S") return ok([`u=${"rwx".split("").filter((x, i) => !(s.umask & (0o400 >> i))).join("")},g=${"rwx".split("").filter((x, i) => !(s.umask & (0o40 >> i))).join("")},o=${"rwx".split("").filter((x, i) => !(s.umask & (0o4 >> i))).join("")}`]);
        if (!/^[0-7]{1,4}$/.test(args[0])) return fail(`-bash: umask: ${args[0]}: octal number out of range`);
        s.umask = parseInt(args[0], 8);
        return ok();
      case "ulimit": {
        const { f, rest } = opts(args, "n");
        if (f.a) return ok(["real-time non-blocking time  (microseconds, -R) unlimited", "core file size              (blocks, -c) 0", "file size                   (blocks, -f) unlimited",
          "max user processes                  (-u) 15209", `open files                          (-n) ${s.nofile}`, "stack size                  (kbytes, -s) 8192"]);
        const v = f.n === true || f.n == null ? rest[0] : f.n;
        if (v == null || v === true) return ok([String(s.nofile)]);
        if (Number(v) > 1048576 && c.user !== "root") return fail("-bash: ulimit: open files: cannot modify limit: Operation not permitted");
        s.nofile = Number(v);
        return ok();
      }
      case "exit": case "logout":
        if (s.outer) { h.sess = s.outer; return { out: ["logout"], err: [], code: 0 }; }
        if (h.emergency) return L.CMDS.systemctl({ ...c, user: "root" }, ["default"]);
        return { out: [], err: [], code: 0, notes: ["(this is the only session; type 'reset' to start the scenario again)"] };
      case "type": return ok(args.map((a) => {
        const w = L.which(c, a);
        return !w ? `-bash: type: ${a}: not found` : w.builtin ? `${a} is a shell builtin` : `${a} is ${w.path}`;
      }));
      case "command": {
        if (args[0] === "-v") { const w = L.which(c, args[1] || ""); return w ? ok([w.builtin ? args[1] : w.path]) : fail([], 1); }
        return L.exec(c, args, stdin);
      }
      case "history": return ok(h.history.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`));
      case "alias": return ok(["alias l='ls -CF'", "alias la='ls -A'", "alias ll='ls -alF'", "alias ls='ls --color=auto'"]);
      case "source": case ".": return ok();
      case "set": return ok();
      case "help": return ok(["Type 'help' on its own (not in a pipe) for the playground's list of commands."]);
      case "true": case ":": return ok();
      case "false": return fail([], 1);
      case "test": case "[": {
        const a = name === "[" ? args.slice(0, -1) : args;
        const r = a.length === 2 ? h.lookup(norm(a[1], s.cwd), c.user) : null;
        const t = a[0] === "-e" ? r && !r.err : a[0] === "-f" ? r && r.node && r.node.t === "f" : a[0] === "-d" ? r && r.node && r.node.t === "d"
          : a[0] === "-x" ? r && r.node && h.can(c.user, r.node, 1) : a[1] === "=" ? a[0] === a[2] : a[1] === "!=" ? a[0] !== a[2] : a.length === 1 && a[0] !== "";
        return t ? ok() : fail([], 1);
      }
      case "kill": return killCmd(c, args, "-bash: kill: ");
      default: return ok();
    }
  }

  // --- processes: ps, top, kill, nice, lsof ----------------------------------------------

  function killCmd(c, args, prefix) {
    const h = c.h;
    if (args[0] === "-l") return ok(["1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t10) SIGUSR1\t12) SIGUSR2\t15) SIGTERM\t18) SIGCONT\t19) SIGSTOP"]);
    let sig = "TERM";
    const rest = [...args];
    if (rest[0] === "-s" || rest[0] === "-n") { rest.shift(); sig = rest.shift(); } else if (/^-/.test(rest[0] || "")) sig = rest.shift().slice(1);
    const name = sig === "0" ? 0 : sigName(sig);
    if (name === null) return fail(`${prefix}${sig}: invalid signal specification`);
    if (!rest.length) return fail("kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]", 2);
    const err = [];
    for (const pid of rest) {
      if (!/^\d+$/.test(pid)) { err.push(`${prefix}${pid}: arguments must be process or job IDs`); continue; }
      const e = signal(h, pid, name, c.user);
      if (e === "ESRCH") err.push(prefix === "kill: " ? `kill: (${pid}): No such process` : `${prefix}(${pid}) - No such process`);
      if (e === "EPERM") err.push(prefix === "kill: " ? `kill: (${pid}): Operation not permitted` : `${prefix}(${pid}) - Operation not permitted`);
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  }
  CMDS.kill = (c, args) => killCmd(c, args, "kill: ");
  function matchProcs(h, pattern, full) {
    let re;
    try { re = new RegExp(pattern); } catch { return []; }
    return h.procs.filter((p) => p.stat !== "Z" && !p.thread && re.test(full ? p.args : p.comm));
  }
  CMDS.pgrep = (c, args) => {
    const { f, rest } = opts(args, "u");
    const hits = matchProcs(c.h, rest[0] || "", f.f).filter((p) => !f.u || p.user === f.u);
    return { out: hits.map((p) => (f.a || f.l ? `${p.pid} ${f.a ? p.args : p.comm}` : String(p.pid))), err: [], code: hits.length ? 0 : 1 };
  };
  CMDS.pidof = (c, args) => {
    const hits = c.h.procs.filter((p) => p.comm === args[0] && p.stat !== "Z");
    return hits.length ? ok([hits.map((p) => p.pid).reverse().join(" ")]) : fail([], 1);
  };
  CMDS.pkill = (c, args) => {
    const { f, rest } = opts(args.map((a) => (/^-(\d+|[A-Z]+)$/.test(a) ? "--sig=" + a.slice(1) : a)));
    const sig = sigName(f.sig || f.signal || "TERM") || "TERM";
    const hits = matchProcs(c.h, rest[0] || "", f.f);
    const err = [];
    for (const p of hits) if (signal(c.h, p.pid, sig, c.user) === "EPERM") err.push(`pkill: killing pid ${p.pid} failed: Operation not permitted`);
    return { out: [], err, code: hits.length ? (err.length ? 1 : 0) : 1 };
  };
  CMDS.killall = (c, args) => {
    const rest = args.filter((a) => !a.startsWith("-"));
    const sig = sigName((args.find((a) => /^-[A-Z0-9]+$/.test(a)) || "-TERM").slice(1)) || "TERM";
    const hits = c.h.procs.filter((p) => p.comm === rest[0] && p.stat !== "Z" && !p.thread);
    if (!hits.length) return fail(`${rest[0]}: no process found`);
    for (const p of hits) signal(c.h, p.pid, sig, c.user);
    return ok();
  };

  const PS_COLS = {
    pid: ["PID", (h, p) => p.pid, 7], ppid: ["PPID", (h, p) => p.ppid, 7], user: ["USER", (h, p) => p.user, -8], stat: ["STAT", (h, p) => statOf(h, p) + (p.lead ? "s" : "") + (p.ni > 0 ? "N" : ""), -4],
    state: ["S", (h, p) => statOf(h, p), -1], comm: ["COMMAND", (h, p) => p.comm, -15], cmd: ["CMD", (h, p) => cmdLine(h, p), 0], args: ["COMMAND", (h, p) => cmdLine(h, p), 0],
    "%cpu": ["%CPU", (h, p) => p.cpu.toFixed(1), 5], "%mem": ["%MEM", (h, p) => (p.rss / h.mem.total * 100).toFixed(1), 5], rss: ["RSS", (h, p) => p.rss, 8],
    vsz: ["VSZ", (h, p) => p.vsz, 8], ni: ["NI", (h, p) => p.ni, 3], etime: ["ELAPSED", (h, p) => etime(h.clock - p.start), 11], wchan: ["WCHAN", (h, p) => (statOf(h, p) === "D" ? "io_schedule" : "-"), -12]
  };
  const cmdLine = (h, p) => (statOf(h, p) === "Z" ? `[${p.comm}] <defunct>` : p.args);
  function etime(ms) {
    const s = Math.floor(ms / 1000), dd = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, mm = Math.floor(s / 60) % 60;
    return `${dd ? dd + "-" : ""}${dd || hh ? String(hh).padStart(2, "0") + ":" : ""}${String(mm).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  const cputime = (p, now) => { const s = Math.floor((now - p.start) / 1000 * p.cpu / 100); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function sortProcs(h, list, key) {
    if (!key) return list;
    const desc = key.startsWith("-");
    const k = key.replace(/^[-+]/, "");
    const val = (p) => (k === "%cpu" || k === "pcpu" ? p.cpu : k === "%mem" || k === "pmem" || k === "rss" ? p.rss : k === "pid" ? p.pid : 0);
    return [...list].sort((a, b) => (desc ? val(b) - val(a) : val(a) - val(b)));
  }
  CMDS.ps = (c, args) => {
    const h = c.h;
    const a = args.map((x, i) => (i === 0 && /^[auxef]+$/.test(x) && !x.startsWith("-") ? "-BSD" + x : x));
    const { f } = opts(a, "opuC");
    const bsd = Boolean(f.B);
    let list = h.procs.filter((p) => !p.thread || f.L).sort((a, b) => a.pid - b.pid);
    if (f.p) list = list.filter((p) => String(f.p).split(",").includes(String(p.pid)));
    if (f.u && !bsd) list = list.filter((p) => p.user === f.u);
    if (f.C) list = list.filter((p) => p.comm === f.C);
    if (f.ppid) list = list.filter((p) => String(p.ppid) === String(f.ppid));
    if (!f.e && !f.A && !bsd && !f.p && !f.u && !f.C && !f.ppid) list = list.filter((p) => p.tty !== "?");
    list = sortProcs(h, list, f.sort);
    const cols = f.o ? String(f.o).split(",").map((k) => k.replace(/=.*$/, "")) : null;
    if (cols) {
      if (cols.some((k) => !PS_COLS[k])) return fail(["error: unknown user-defined format specifier \"" + cols.find((k) => !PS_COLS[k]) + "\"", "", "Usage:", " ps [options]"]);
      const head = cols.map((k) => { const [t, , w] = PS_COLS[k]; return w > 0 ? t.padStart(w) : w < 0 ? t.padEnd(-w) : t; }).join(" ").trimEnd();
      return ok([head, ...list.map((p) => cols.map((k) => { const [, fn, w] = PS_COLS[k]; const v = String(fn(h, p)); return w > 0 ? v.padStart(w) : w < 0 ? v.padEnd(-w) : v; }).join(" ").trimEnd())]);
    }
    if (bsd && /u/.test(args[0] || "")) {
      return ok(["USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND", ...list.map((p) => `${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${(p.rss / h.mem.total * 100).toFixed(1).padStart(4)} ${String(p.vsz).padStart(6)} ${String(p.rss).padStart(5)} ${p.tty.padEnd(8)} ${PS_COLS.stat[1](h, p).padEnd(4)} ${hms(p.start).slice(0, 5)} ${cputime(p, h.clock).padStart(6)} ${cmdLine(h, p)}`)]);
    }
    if (f.f || bsd) return ok(["UID          PID    PPID  C STIME TTY          TIME CMD", ...list.map((p) => `${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.round(p.cpu)).padStart(2)} ${hms(p.start).slice(0, 5)} ${p.tty.padEnd(8)} ${("00:" + cputime(p, h.clock).padStart(5, "0")).padStart(8)} ${cmdLine(h, p)}`)]);
    return ok(["    PID TTY          TIME CMD", ...list.map((p) => `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} 00:00:00 ${p.comm}`)]);
  };
  CMDS.top = (c, args) => {
    const h = c.h;
    const { f } = opts(args, "npo");
    const cs = cpuStats(h), m = memStats(h);
    const tasks = h.procs.filter((p) => !p.thread);
    const n = (st) => tasks.filter((p) => statOf(h, p)[0] === st).length;
    const mib = (k) => (k / 1024).toFixed(1).padStart(9);
    const list = sortProcs(h, tasks, f.o === "%MEM" ? "-rss" : "-%cpu").slice(0, 14);
    const users = h.sessions || 1;
    const out = [`top - ${hms(h.clock)} up ${upFor(h)},  ${users} user${users === 1 ? "" : "s"},  load average: ${cs.load.map((x) => x.toFixed(2)).join(", ")}`,
      `Tasks: ${String(tasks.length + 98).padStart(3)} total, ${String(n("R") + 1).padStart(3)} running, ${String(n("S") + 97 + n("D")).padStart(3)} sleeping, ${String(n("T")).padStart(3)} stopped, ${String(n("Z")).padStart(3)} zombie`,
      `%Cpu(s): ${cs.us.toFixed(1).padStart(4)} us, ${cs.sy.toFixed(1).padStart(4)} sy,  0.0 ni, ${cs.id.toFixed(1).padStart(4)} id, ${cs.wa.toFixed(1).padStart(4)} wa,  0.0 hi,  0.1 si,  0.0 st`,
      `MiB Mem : ${mib(m.total)} total, ${mib(m.free)} free, ${mib(m.used)} used, ${mib(m.cache)} buff/cache`,
      `MiB Swap: ${mib(m.swap)} total, ${mib(m.swapFree)} free, ${mib(m.swapUsed)} used. ${mib(m.avail)} avail Mem`, "",
      "    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
      ...list.map((p) => `${String(p.pid).padStart(7)} ${p.user.slice(0, 8).padEnd(8)}  ${String(20 + p.ni).padStart(2)} ${String(p.ni).padStart(3)} ${String(p.vsz).padStart(7)} ${String(p.rss).padStart(6)} ${String(Math.round(p.rss / 6)).padStart(6)} ${statOf(h, p)} ${p.cpu.toFixed(1).padStart(5)} ${(p.rss / h.mem.total * 100).toFixed(1).padStart(5)} ${(cputime(p, h.clock) + ".00").padStart(9)} ${p.comm}`)];
    return { out, err: [], code: 0, notes: f.b ? [] : ["(top refreshes every few seconds; the playground shows one screen, like top -b -n 1)"] };
  };
  CMDS.htop = (c) => fail("htop needs a full-screen terminal; this playground shows top -b -n 1 instead. Try: top", 1);
  CMDS.uptime = (c) => {
    const cs = cpuStats(c.h);
    return ok([` ${hms(c.h.clock)} up ${upFor(c.h)},  1 user,  load average: ${cs.load.map((x) => x.toFixed(2)).join(", ")}`]);
  };
  CMDS.w = (c) => ok([...CMDS.uptime(c).out, "USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU  WHAT", `${c.h.sess.user.padEnd(8)} pts/0    203.0.113.24     ${hms(c.h.clock - 600000).slice(0, 5)}    0.00s  0.04s  0.00s w`]);
  CMDS.who = (c) => ok([`${c.h.sess.user.padEnd(8)} pts/0        ${c.h.clock ? L.isoDay(c.h.clock - 600000) : ""} ${hms(c.h.clock - 600000).slice(0, 5)} (203.0.113.24)`]);
  CMDS.nproc = (c) => ok([String(c.h.cpus || 2)]);
  CMDS.free = (c, args) => {
    const { f } = opts(args);
    const m = memStats(c.h);
    const fmt = f.h ? (k) => (k === 0 ? "0B" : human(k * 1024).replace(/([KMGT])$/, "$1i")) : f.m ? (k) => String(Math.round(k / 1024)) : f.g ? (k) => String(Math.round(k / 1048576)) : (k) => String(Math.round(k));
    const row = (...v) => v.map((x) => fmt(x).padStart(11)).join(" ");
    return ok(["               total        used        free      shared  buff/cache   available", `Mem:    ${row(m.total, m.used, m.free, m.shared, m.cache, m.avail)}`, `Swap:   ${row(m.swap, m.swapUsed, m.swapFree)}`]);
  };
  CMDS.vmstat = (c, args) => {
    const h = c.h, cs = cpuStats(h), m = memStats(h);
    const n = Math.min(5, Number(args[1] || 1));
    const r = h.procs.filter((p) => p.cpu > 50).length, b = h.procs.filter((p) => statOf(h, p) === "D").length;
    const si = m.thrash ? 1840 : 0, so = m.thrash ? 2210 : 0, bi = ioHogs(h).length ? 148220 : 12;
    const row = () => `${String(r).padStart(2)} ${String(b).padStart(2)} ${String(Math.round(m.swapUsed)).padStart(6)} ${String(Math.round(m.free)).padStart(6)} ${String(Math.round(m.cache * 0.2)).padStart(6)} ${String(Math.round(m.cache * 0.8)).padStart(6)} ${String(si).padStart(4)} ${String(so).padStart(4)} ${String(bi).padStart(5)} ${String(m.thrash ? 2400 : 38).padStart(5)} ${String(420).padStart(4)} ${String(610).padStart(4)} ${String(Math.round(cs.us)).padStart(2)} ${String(Math.round(cs.sy)).padStart(2)} ${String(Math.round(cs.id)).padStart(2)} ${String(Math.round(cs.wa)).padStart(2)}  0`;
    return ok(["procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----", " r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st", ...Array.from({ length: n }, row)]);
  };
  CMDS.iotop = (c) => {
    const h = c.h;
    if (c.user !== "root") return fail(["Netlink error: Operation not permitted (1)", "", "The Linux kernel interfaces that iotop relies on now require root privileges", "or the NET_ADMIN capability."]);
    const rows = h.procs.filter((p) => p.io || statOf(h, p) === "D").map((p) => `${String(p.pid).padStart(7)} ${p.ioclass === 3 ? "idle" : "be/4"} ${p.user.padEnd(8)} ${p.io ? "  148.22 M/s" : "    0.00 B/s"}    0.00 B/s  0.00 % ${p.io ? "99.99" : statOf(h, p) === "D" ? "87.12" : " 0.00"} % ${p.args}`);
    const total = ioHogs(h).length ? "148.22 M/s" : "0.00 B/s";
    return ok([`Total DISK READ:       ${total} | Total DISK WRITE:         0.00 B/s`, `Actual DISK READ:      ${total} | Actual DISK WRITE:        0.00 B/s`, "    TID  PRIO  USER     DISK READ  DISK WRITE  SWAPIN     IO>    COMMAND", ...rows]);
  };
  CMDS.renice = (c, args) => {
    const { f, rest } = opts(args, "np");
    const pid = f.p || rest[0];
    const p = procOf(c.h, pid);
    if (!p) return fail(`renice: failed to get priority for ${pid} (process ID): No such process`);
    const v = Number(f.n);
    if (c.user !== "root" && (p.user !== c.user || v < p.ni)) return fail(`renice: failed to set priority for ${pid} (process ID): Permission denied`);
    const old = p.ni;
    p.ni = v;
    return ok([`${pid} (process ID) old priority ${old}, new priority ${v}`]);
  };
  CMDS.ionice = (c, args) => {
    const { f, rest } = opts(args, "cnp");
    const p = procOf(c.h, f.p || rest[0]);
    if (!p) return fail(`ionice: ioprio_get failed: No such process`);
    if (f.c == null) return ok([p.ioclass === 3 ? "idle" : "best-effort: prio 4"]);
    if (c.user !== "root" && p.user !== c.user) return fail("ionice: ioprio_set failed: Operation not permitted");
    p.ioclass = Number(f.c);
    return ok();
  };
  // lsof: open files, +L1 for deleted ones, -i :port, -p pid, or a path.
  CMDS.lsof = (c, args) => {
    const h = c.h;
    const head = "COMMAND    PID     USER   FD   TYPE DEVICE    SIZE/OFF NLINK    NODE NAME";
    if (c.user !== "root") return { out: [head], err: [], code: 1, notes: ["(as a normal user, lsof only sees your own processes; most files here belong to services: try sudo lsof)"] };
    const rows = [];
    const deletedOnly = args.includes("+L1");
    const iArg = args[args.indexOf("-i") + 1];
    const pArg = args.includes("-p") ? args[args.indexOf("-p") + 1] : null;
    const pathArg = args.find((a) => a.startsWith("/"));
    for (const p of h.procs) {
      if (p.thread || p.stat === "Z") continue;
      if (pArg && String(p.pid) !== pArg) continue;
      if (args.includes("-i")) {
        const port = iArg ? Number((/:(\d+)$/.exec(iArg) || [])[1]) : null;
        for (const l of p.listen) if (!port || l.port === port) rows.push(`${p.comm.slice(0, 9).padEnd(9)} ${String(p.pid).padStart(5)} ${p.user.padEnd(8)}    6u  IPv4  31415         0t0  TCP ${l.addr === "0.0.0.0" ? "*" : l.addr}:${l.port} (LISTEN)`);
        continue;
      }
      for (const fd of p.fds) {
        if (deletedOnly && !fd.deleted) continue;
        if (pathArg && !(fd.path === pathArg || fd.path.startsWith(pathArg.replace(/\/$/, "") + "/"))) continue;
        const size = Math.round(fd.deleted ? fd.size : (h.fs.get(fd.path) ? h.sizeOf(h.fs.get(fd.path)) : 0));
        rows.push(`${p.comm.slice(0, 9).padEnd(9)} ${String(p.pid).padStart(5)} ${p.user.padEnd(8)} ${String(fd.fd + (fd.mode || "w")).padStart(4)}   REG    8,1 ${String(size).padStart(11)} ${fd.deleted ? "    0" : "    1"} ${String(131000 + fd.fd).padStart(7)} ${fd.path}${fd.deleted ? " (deleted)" : ""}`);
      }
      if (pathArg && p.cwd && (p.cwd === pathArg || p.cwd.startsWith(pathArg.replace(/\/$/, "") + "/"))) rows.push(`${p.comm.slice(0, 9).padEnd(9)} ${String(p.pid).padStart(5)} ${p.user.padEnd(8)}  cwd    DIR    8,1        4096     2       2 ${p.cwd}`);
    }
    return rows.length ? ok([head, ...rows]) : fail([], 1);
  };
  CMDS.fuser = (c, args) => {
    const path = args.find((a) => a.startsWith("/"));
    const pids = c.h.procs.filter((p) => (p.cwd || "").startsWith(path) || p.fds.some((f) => f.path.startsWith(path))).map((p) => p.pid);
    return pids.length ? ok([`${path}: ${pids.map((p) => `${p}c`).join(" ")}`]) : fail([], 1);
  };

  // --- systemctl and journalctl --------------------------------------------------------------

  function needRoot(c, verb, name) {
    if (c.user === "root") return null;
    return fail([`Failed to ${verb} ${name || "units"}: Access denied`, `See system logs and 'systemctl status ${name || ""}' for details.`.replace(" ''", "")]);
  }
  const DOT = { active: "●", failed: "×", inactive: "○", activating: "●" };
  function statusLines(h, name) {
    const f = unitFile(h, name);
    if (!f) return null;
    if (f.masked) return [`○ ${name}`, `     Loaded: masked (Reason: Unit ${name} is masked.)`, "     Active: inactive (dead)"];
    const cfg = cfgOf(h, name);
    const st = state(h, name);
    const en = enabledState(h, name);
    const out = [`${DOT[st.active]} ${name} - ${cfg.desc}`, `     Loaded: loaded (${f.path}; ${en}; preset: enabled)`];
    const dins = dropins(h, name);
    if (dins.length) out.push(`    Drop-In: ${dirname(dins[0])}`, ...dins.map((d, i) => `             ${i === dins.length - 1 ? "└─" : "├─"}${basename(d)}`));
    const since = `since ${longDate(st.since)} UTC; ${ago(h.clock - st.since)}`;
    if (st.active === "active") out.push(`     Active: active (running) ${since}`);
    else if (st.active === "failed") out.push(`     Active: failed (Result: ${st.result}) ${since}`);
    else out.push(`     Active: inactive (dead)${st.since !== h.boot ? ` ${since}` : ""}`);
    const docs = cfg.one("Unit", "Documentation");
    if (docs) out.push(`       Docs: ${docs}`);
    if (st.active === "active") {
      const p = procOf(h, st.pid);
      const kids = h.procs.filter((q) => q.unit === name && q !== p);
      out.push(`   Main PID: ${st.pid} (${p ? p.comm : "?"})`, `      Tasks: ${1 + kids.length} (limit: 4558)`,
        `     Memory: ${(h.procs.filter((q) => q.unit === name).reduce((s, q) => s + q.rss, 0) / 1024).toFixed(1)}M (peak: ${(h.procs.filter((q) => q.unit === name).reduce((s, q) => s + q.rss, 0) / 1024 * 1.2).toFixed(1)}M)`,
        `        CPU: ${Math.round((h.clock - st.since) / 1000 * (p ? p.cpu : 0) / 100 * 1000) / 1000}s`.replace(/: 0s$/, ": 41ms"), `     CGroup: /system.slice/${name}`,
        ...[p, ...kids].filter(Boolean).map((q, i, a) => `             ${i === a.length - 1 ? "└─" : "├─"}${q.pid} ${/\s/.test(cmdLine(h, q)) ? `"${cmdLine(h, q)}"` : cmdLine(h, q)}`));
    } else if (st.active === "failed" && st.lastPid) {
      const how = st.result === "signal" ? `code=killed, signal=${st.killed}` : `code=exited, status=${st.code}/${EXIT[st.code] || "n/a"}`;
      out.push(`    Process: ${st.lastPid} ExecStart=${st.cmd || cfg.exec} (${how})`, `   Main PID: ${st.lastPid} (${how})`, "        CPU: 12ms");
    }
    const log = h.journal.filter((e) => e.unit === name && e.boot === h.boots).sort((a, b) => a.t - b.t).slice(-10);
    if (log.length) out.push("", ...log.map((e) => jline(h, e)));
    return out;
  }
  const jline = (h, e) => `${stamp(e.t)} ${h.hostname} ${e.ident}${e.pid ? `[${e.pid}]` : ""}: ${e.msg}`;

  CMDS.systemctl = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    const [verb = "list-units", ...names] = rest;
    const units = names.map(unitName);
    const changed = (n) => (changedOnDisk(h, n) ? [`Warning: The unit file, source configuration file or drop-ins of ${n} changed on disk. Run 'systemctl daemon-reload' to reload units.`] : []);
    const mutating = ["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload", "reset-failed", "set-property", "reboot", "poweroff", "default", "kill", "try-restart", "reload-or-restart", "edit"];
    if (mutating.includes(verb)) {
      const e = needRoot(c, verb === "daemon-reload" ? "reload daemon" : verb === "set-property" ? "set unit properties on" : verb, units[0]);
      if (e) return verb === "daemon-reload" ? fail(["Failed to reload daemon: Access denied"]) : e;
    }
    const nf = (n) => [`Failed to ${verb} ${n}: Unit ${n} not found.`];
    switch (verb) {
      case "status": {
        if (!units.length) return ok([`● ${h.hostname}`, "    State: " + (h.emergency ? "maintenance" : Object.values(h.units).some((u) => u.active === "failed") ? "degraded" : "running"), `    Units: 241 loaded (incl. loaded aliases)`, `     Jobs: 0 queued`, `   Failed: ${Object.values(h.units).filter((u) => u.active === "failed").length} units`]);
        const out = [], err = [];
        for (const n of units) {
          const s = statusLines(h, n);
          if (!s) { err.push(`Unit ${n} could not be found.`); continue; }
          out.push(...s);
          err.push(...changed(n));
        }
        return { out, err, code: err.some((e) => e.startsWith("Unit")) ? 4 : units.every((n) => state(h, n).active === "active") ? 0 : 3 };
      }
      case "start": case "restart": case "reload": case "try-restart": case "reload-or-restart": {
        const err = [];
        for (const n of units) {
          err.push(...changed(n));
          if (!unitFile(h, n)) { err.push(...nf(n)); continue; }
          if (verb === "reload") {
            const p = procOf(h, state(h, n).pid);
            if (!p) { err.push(`Job for ${n} failed.`, `See "systemctl status ${n}" and "journalctl -xeu ${n}" for details.`); continue; }
            if (p.onReload) { const e = p.onReload(h, p); if (e) { err.push(`Job for ${n} failed because the control process exited with error code.`, `See "systemctl status ${n}" and "journalctl -xeu ${n}" for details.`); continue; } }
            h.log("systemd", `Reloaded ${n} - ${cfgOf(h, n).desc}.`, { pid: 1, unit: n });
            continue;
          }
          if (verb !== "start") stop(h, n);
          err.push(...start(h, n));
        }
        return { out: [], err, code: err.filter((e) => !e.startsWith("Warning")).length ? 1 : 0 };
      }
      case "stop": {
        for (const n of units) { if (!unitFile(h, n)) return fail(nf(n), 5); stop(h, n); }
        return { out: [], err: units.flatMap(changed), code: 0 };
      }
      case "enable": case "disable": {
        const out = [], err = [];
        for (const n of units) {
          const file = unitFile(h, n);
          if (!file) { err.push(`Failed to ${verb} unit: Unit file ${n} does not exist.`); continue; }
          if (file.masked) { err.push(`Failed to ${verb} unit: Unit file ${file.path} is masked.`); continue; }
          const cfg = parseUnit(diskText(h, n));
          if (verb === "enable") {
            if (!cfg.wantedBy.length) {
              err.push(`The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,`, "Also=, or Alias= settings in the [Install] section, and DefaultInstance= for", "template units). This means they are not meant to be enabled or disabled using systemctl.", " ",
                "Possible reasons for having these kinds of units are:", "• A unit may be statically enabled by being symlinked from another unit's", "  .wants/, .requires/, or .upholds/ directory.");
              continue;
            }
            for (const t of cfg.wantedBy) {
              const link = `/etc/systemd/system/${t}.wants/${n}`;
              if (!h.fs.has(link)) { h.link(link, file.path); out.push(`Created symlink ${link} → ${file.path}.`); }
            }
            if (f.now) err.push(...start(h, n));
          } else {
            for (const k of [...h.fs.keys()]) if (/^\/etc\/systemd\/system\/[^/]+\.wants\//.test(k) && k.endsWith("/" + n)) { h.fs.delete(k); out.push(`Removed "${k}".`); }
            if (f.now) stop(h, n);
          }
        }
        return { out, err, code: err.length ? 1 : 0 };
      }
      case "mask": {
        const out = [];
        for (const n of units) { stop(h, n); h.link(`/etc/systemd/system/${n}`, "/dev/null"); out.push(`Created symlink /etc/systemd/system/${n} → /dev/null.`); }
        return ok(out);
      }
      case "unmask": {
        const out = [];
        for (const n of units) {
          const k = `/etc/systemd/system/${n}`;
          const node = h.fs.get(k);
          if (node && node.t === "l" && node.to === "/dev/null") { h.fs.delete(k); out.push(`Removed "${k}".`); }
        }
        return ok(out);
      }
      case "daemon-reload":
        h.loaded = {};
        h.fstabSeen = h.read("/etc/fstab");
        return ok();
      case "reset-failed":
        for (const n of units.length ? units : Object.keys(h.units)) { const st = state(h, n); if (st.active === "failed") Object.assign(st, { active: "inactive", sub: "dead", result: "success", starts: [] }); else st.starts = []; if (st.result === "start-limit-hit") st.result = "success"; }
        return ok();
      case "is-active": {
        const s = units.map((n) => { const st = state(h, n).active; return st === "inactive" && !unitFile(h, n) ? "inactive" : st; });
        return { out: s, err: [], code: s.every((x) => x === "active") ? 0 : 3 };
      }
      case "is-enabled": {
        const s = units.map((n) => enabledState(h, n));
        if (s.includes(null)) return fail(`Failed to get unit file state for ${units[s.indexOf(null)]}: No such file or directory`);
        return { out: s, err: [], code: s.every((x) => x === "enabled" || x === "static") ? 0 : 1 };
      }
      case "is-failed": { const s = units.map((n) => state(h, n).active); return { out: s, err: [], code: s.includes("failed") ? 0 : 1 }; }
      case "cat": {
        const out = [];
        for (const n of units) {
          const file = unitFile(h, n);
          if (!file || file.masked) return fail(`No files found for ${n}.`);
          out.push(`# ${file.path}`, ...lines(h.read(file.path) || ""));
          for (const dpath of dropins(h, n)) out.push("", `# ${dpath}`, ...lines(h.read(dpath) || ""));
        }
        return { out, err: units.flatMap(changed), code: 0 };
      }
      case "show": {
        const n = units[0];
        const cfg = cfgOf(h, n), st = state(h, n);
        const props = { Id: n, ActiveState: st.active, SubState: st.sub, Result: st.result || "success", MainPID: st.pid || 0, ExecStart: `{ path=${(cfg.exec || "").split(" ")[0]} ; argv[]=${cfg.exec || ""} }`,
          LimitNOFILE: cfg.one("Service", "LimitNOFILE") || 524288, LimitNOFILESoft: cfg.one("Service", "LimitNOFILE") || 1024, User: cfg.user || "", Restart: cfg.restart, NRestarts: Math.max(0, (st.starts || []).length - 1),
          UnitFileState: enabledState(h, n), After: cfg.after.join(" "), Wants: cfg.wants.join(" "), MemoryMax: cfg.one("Service", "MemoryMax") || "infinity", Environment: Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join(" ") };
        const want = (f.p || f.property) ? String(f.p || f.property).split(",") : Object.keys(props);
        return ok(want.map((k) => (f.value ? String(props[k] ?? "") : `${k}=${props[k] ?? ""}`)));
      }
      case "list-units": case "list-unit-files": {
        let list = [...new Set([...Object.keys(h.units), ...UNIT_DIRS.flatMap((dd) => h.kids(dd).filter((k) => /\.(service|timer)$/.test(k)))])].sort();
        if (verb === "list-unit-files") {
          return ok(["UNIT FILE                              STATE           PRESET", ...list.map((n) => `${n.padEnd(38)} ${String(enabledState(h, n) || "").padEnd(15)} enabled`), "", `${list.length} unit files listed.`]);
        }
        if (f.failed || f.state === "failed") list = list.filter((n) => state(h, n).active === "failed");
        else list = list.filter((n) => f.all || state(h, n).active !== "inactive");
        const rows = list.map((n) => { const st = state(h, n); return `${st.active === "failed" ? "●" : " "} ${n.padEnd(34)} loaded ${st.active.padEnd(6)} ${st.sub.padEnd(7)} ${cfgOf(h, n).desc}`; });
        return ok(["  UNIT                               LOAD   ACTIVE SUB     DESCRIPTION", ...rows, "", "Legend: LOAD   → Reflects whether the unit definition was properly loaded.", "        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.", "        SUB    → The low-level unit activation state, values depend on unit type.", "", `${rows.length} loaded units listed.`]);
      }
      case "list-timers": return ok(["NEXT                        LEFT LAST                        PASSED UNIT                         ACTIVATES", `${longDate(h.clock + 3 * 3600000)} UTC   2h 59min ${longDate(h.clock - 21 * 3600000)} UTC 21h ago logrotate.timer              logrotate.service`, "", "1 timers listed."]);
      case "set-property": {
        const n = units[0];
        if (!unitFile(h, n)) return fail(`Failed to set unit properties on ${n}: Unit ${n} not found.`);
        const props = names.slice(1);
        const dir = `/etc/systemd/system.control/${n}.d`;
        for (const p of props) h.file(`${dir}/50-${p.split("=")[0]}.conf`, `# This is a drop-in unit file extension, created via "systemctl set-property"\n# or an equivalent operation. Do not edit.\n[Service]\n${p}\n`);
        const p = procOf(h, state(h, n).pid);
        if (p && p.onProperty) p.onProperty(h, props, p);
        return ok();
      }
      case "edit": return { out: [], err: [], code: 1, notes: [`(systemctl edit opens an editor, which this playground does not have. Write the drop-in yourself:`, `  sudo mkdir -p /etc/systemd/system/${units[0]}.d`, `  printf '[Service]\\nKey=value\\n' | sudo tee /etc/systemd/system/${units[0]}.d/override.conf`, `  sudo systemctl daemon-reload)`] };
      case "kill": {
        const n = units[0];
        const st = state(h, n);
        if (st.active !== "active") return fail(`Failed to kill unit ${n}: No main process to kill`);
        signal(h, st.pid, sigName(f.signal || f.s || "TERM") || "TERM", "root");
        return ok();
      }
      case "reboot": return L.CMDS.reboot(c, []);
      case "poweroff": return fail("(the playground will not power off its only server; try reboot)");
      case "default": case "isolate": {
        if (!h.emergency) return ok();
        h.emergency = false;
        const rootM = h.mounts.find((m) => m.mnt === "/");
        if (h.read("/etc/fstab") !== h.fstabSeen && h.fstabSeen != null) h.log("systemd", "/etc/fstab changed on disk; the old version is still in use. Run 'systemctl daemon-reload'.", { pid: 1, prio: 4 });
        if (!mountFstab(h, true)) return { out: [], err: [], code: 1, notes: ["(local-fs.target failed again: still in emergency mode. journalctl -xb shows why.)"] };
        if (rootM) rootM.ro = false;
        h.booting = true;
        bootUp(h, true);
        h.sess = h.newSession(h.scenario.user || "ubuntu");
        return { out: [], err: [], code: 0, notes: ["(the boot continues to multi-user.target; you are logged in again)"] };
      }
      default: return fail(`Unknown command verb '${verb}', expected one of: status, start, stop, restart, enable, disable, mask, unmask, daemon-reload, reset-failed, is-active, is-enabled, cat, show, list-units.`);
    }
  };

  CMDS.journalctl = (c, args) => {
    const h = c.h;
    // -b takes an optional boot offset: -b, -b 0, -b -1.
    const a = args.flatMap((x, i) => (x === "-b" ? [/^-?\d+$/.test(args[i + 1] || "") ? `--boot=${args[i + 1]}` : "--boot=0"] : /^-?\d+$/.test(x) && args[i - 1] === "-b" ? [] : [x]));
    const { f } = opts(a, "unpS");
    if (f.boot !== undefined) f.b = f.boot;
    if (c.user !== "root" && !h.groupsOf(c.user).some((g) => g === "adm" || g === "systemd-journal")) {
      return { out: ["-- No entries --"], err: [], code: 0, notes: ["(Hint: You are currently not seeing messages from other users and the system. Users in groups 'adm', 'systemd-journal' can see all messages. Pass -q to turn off this notice.)"] };
    }
    if (f["disk-usage"]) return ok([`Archived and active journals take up ${human(h.journalBytes || 312 * MiB)}B in the file system.`.replace("BB", "B")]);
    if (f["vacuum-size"] || f["vacuum-time"]) {
      const before = h.journalBytes || 312 * MiB;
      const target = f["vacuum-size"] ? L.parseSize(f["vacuum-size"].replace(/([KMG])$/i, "$1")) : 64 * MiB;
      h.journalBytes = Math.min(before, target || before);
      return ok([`Vacuuming done, freed ${human(before - h.journalBytes)}B of archived journals from /var/log/journal/ec2a1f3e9c6b4d0f8e21a7c35d90b1f4.`.replace("BB", "B")]);
    }
    const units = [f.u, ...a.filter((x, i) => a[i - 1] === "-u" || a[i - 1] === "--unit").slice(1)].filter((x) => typeof x === "string").map(unitName);
    let list = h.journal.slice().sort((a, b) => a.t - b.t);
    if (f.k) list = h.kmsg.filter((e) => e.boot === h.boots).map((e) => ({ t: h.boot + e.t * 1000, ident: "kernel", msg: e.msg, boot: e.boot }));
    if (units.length) list = list.filter((e) => units.includes(e.unit) || (units.includes("ssh.service") && e.ident === "sshd"));
    if (f.b !== undefined) {
      const which = f.b === true ? 0 : Number(f.b);
      if (which < 0 && h.boots + which < 0) return fail(`Data from the specified boot (${which}) is not available: No such boot ID in journal`);
      list = list.filter((e) => e.boot === h.boots + (which <= 0 ? which : which - 1 - h.boots));
    }
    if (f.p) { const max = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 }[f.p] ?? Number(f.p); list = list.filter((e) => e.prio <= max); }
    const since = f.since || f.S;
    if (typeof since === "string") {
      const m = /^(\d+)\s*(min|minutes?|h|hours?) ago$/.exec(since);
      const from = since === "today" ? h.clock - (h.clock % 86400000) : m ? h.clock - Number(m[1]) * (m[2].startsWith("h") ? 3600000 : 60000) : null;
      if (from != null) list = list.filter((e) => e.t >= from);
    }
    if (f.grep || f.g) list = list.filter((e) => new RegExp(f.grep || f.g, "i").test(e.msg));
    if (f["list-boots"]) return ok(["IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY", ...Array.from({ length: h.boots + 1 }, (_, i) => `${String(i - h.boots).padStart(3)} 4f1c${i}a9e3b2d74c08ad61e5f9c2b7a10 ${longDate(h.boot - (h.boots - i) * 86400000)} UTC ${longDate(h.clock)} UTC`)]);
    const n = f.n != null ? Number(f.n === true ? 10 : f.n) : f.e || f.f ? (f.e ? 1000 : 10) : null;
    if (n != null) list = list.slice(-n);
    if (f.r || f.reverse) list.reverse();
    const out = list.length ? list.map((e) => jline(h, e)) : ["-- No entries --"];
    const notes = f.f || f.follow ? ["(journalctl -f keeps following; the playground shows the last lines and returns)"] : [];
    return { out, err: [], code: 0, notes };
  };
  CMDS.dmesg = (c, args) => {
    const h = c.h;
    if (c.user !== "root" && h.sysctl["kernel.dmesg_restrict"] === "1") return fail("dmesg: read kernel buffer failed: Operation not permitted");
    const { f } = opts(args);
    return ok(h.kmsg.filter((e) => e.boot === h.boots).map((e) => (f.T ? `[${longDate(h.boot + e.t * 1000).replace(/^(\w+) (\d+)-(\d+)-(\d+)/, (m, dd, y, mo, da) => `${dd} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mo) - 1]} ${da}`)} ${new Date(h.boot + e.t * 1000).getUTCFullYear()}] ${e.msg}`.replace(/ \d{4}-\d\d-\d\d/, "") : `[${e.t.toFixed(6).padStart(12)}] ${e.msg}`)));
  };

  // --- disks -------------------------------------------------------------------------

  CMDS.df = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    let ms = h.mounts.filter((m) => !m.gone && (f.a || m.type !== "swap"));
    if (rest.length) {
      const pick = [];
      for (const r of rest) {
        const look = h.lookup(norm(r, c.cwd), c.user);
        if (look.err) return fail(`df: ${r}: ${ERR[look.err]}`);
        pick.push(h.mountOf(look.path));
      }
      ms = [...new Set(pick)];
    }
    const rows = ms.map((m) => {
      const u = h.usage(m);
      if (f.i) {
        const iu = Math.min(u.inodes, m.inodes || u.inodes);
        return [m.dev, String(m.inodes || 0), String(iu), String(Math.max(0, (m.inodes || 0) - iu)), m.inodes ? Math.ceil(iu / m.inodes * 100) + "%" : "-", m.mnt];
      }
      const reserved = m.type === "ext4" ? m.size * 0.05 : 0;
      const used = Math.min(u.bytes, m.size);
      const avail = Math.max(0, m.size - used - reserved);
      const pct = used + avail ? Math.ceil(used / (used + avail) * 100) : 0;
      const sz = (b) => (f.h ? human(b) : String(Math.round(b / 1024)));
      return [m.dev, ...(f.T ? [m.type] : []), sz(m.size), sz(used), sz(avail), pct + "%", m.mnt];
    });
    const head = f.i ? ["Filesystem", "Inodes", "IUsed", "IFree", "IUse%", "Mounted on"] : ["Filesystem", ...(f.T ? ["Type"] : []), f.h ? "Size" : "1K-blocks", "Used", f.h ? "Avail" : "Available", "Use%", "Mounted on"];
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
    return ok(all.map((r) => r.map((v, i) => (i === 0 || i === r.length - 1 || (f.T && i === 1) ? v.padEnd(i === r.length - 1 ? 0 : w[i]) : v.padStart(w[i]))).join(" ").trimEnd()));
  };
  const blkSize = (b) => { const g = b / GiB; return g >= 1 ? (Number.isInteger(Math.round(g * 10) / 10) ? Math.round(g) : (Math.round(g * 10) / 10)) + "G" : Math.round(b / MiB) + "M"; };
  CMDS.lsblk = (c, args) => {
    const h = c.h;
    const { f } = opts(args);
    const w = Math.max(7, ...h.disks.flatMap((dk) => (dk.parts || []).map((p) => p.name.length + 2)));
    const mp = (p) => { const m = h.mounts.find((x) => x.dev === "/dev/" + p.name && !x.gone); return m ? m.mnt : p.swap ? "[SWAP]" : ""; };
    const out = [f.f ? `${"NAME".padEnd(w)} FSTYPE FSVER LABEL           UUID                                 FSAVAIL FSUSE% MOUNTPOINTS` : `${"NAME".padEnd(w)} MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS`];
    h.disks.forEach((dk, di) => {
      out.push(f.f ? dk.name : `${dk.name.padEnd(w)} ${(259 + ":" + di * 16).padEnd(7)}  0 ${blkSize(dk.size).padStart(5)}  0 disk `);
      (dk.parts || []).forEach((p, i) => {
        const tree = i === dk.parts.length - 1 ? "└─" : "├─";
        if (f.f) {
          const m = h.mounts.find((x) => x.dev === "/dev/" + p.name && !x.gone);
          const u = m && h.usage(m);
          out.push(`${(tree + p.name).padEnd(w)} ${(p.fs || "").padEnd(6)} ${(p.fs === "ext4" ? "1.0" : p.fs === "vfat" ? "FAT32" : "").padEnd(5)} ${(p.label || "").padEnd(15)} ${(p.uuid || "").padEnd(36)} ${m ? human(Math.max(0, m.size * 0.95 - u.bytes)).padStart(7) + " " + (Math.ceil(u.bytes / m.size * 100) + "%").padStart(6) : "              "} ${mp(p)}`.trimEnd());
        } else out.push(`${(tree + p.name).padEnd(w)} ${(259 + ":" + (di * 16 + i + 1)).padEnd(7)}  0 ${blkSize(p.size).padStart(5)}  ${p.ro ? 1 : 0} part ${mp(p)}`.trimEnd());
      });
    });
    return ok(out);
  };
  CMDS.blkid = (c) => {
    if (c.user !== "root") return fail([], 2);
    return ok(c.h.disks.flatMap((dk) => dk.parts || []).filter((p) => p.uuid).map((p) => `/dev/${p.name}: ${p.label ? `LABEL="${p.label}" ` : ""}UUID="${p.uuid}" BLOCK_SIZE="4096" TYPE="${p.fs}" PARTUUID="${p.partuuid || "9e1d4c7a-0" + p.name.slice(-1)}"`));
  };
  CMDS.findmnt = (c, args) => {
    const h = c.h;
    const target = args.find((a) => a.startsWith("/"));
    const list = h.mounts.filter((m) => !m.gone && (!target || m.mnt === target));
    if (!list.length) return fail([], 1);
    return ok(["TARGET    SOURCE    FSTYPE OPTIONS", ...list.map((m) => `${m.mnt.padEnd(9)} ${m.dev.padEnd(9)} ${m.type.padEnd(6)} ${m.ro ? "ro" : "rw"},relatime`)]);
  };
  const fstabHint = (h) => (h.fstabSeen != null && h.read("/etc/fstab") !== h.fstabSeen ? ["mount: (hint) your fstab has been modified, but systemd still uses", "       the old version; use 'systemctl daemon-reload' to reload."] : []);
  CMDS.mount = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "ot");
    if (!rest.length && !f.a) return ok(h.mounts.filter((m) => !m.gone).map((m) => `${m.dev} on ${m.mnt} type ${m.type} (${m.ro ? "ro" : "rw"},relatime${m.mnt === "/" ? ",discard,errors=remount-ro" : ""})`));
    const o = f.o || "defaults";
    if (c.user !== "root") return fail(`mount: ${rest[rest.length - 1] || "/"}: must be superuser to use mount.`, 1);
    if (/remount/.test(o)) {
      const m = h.mounts.find((x) => x.mnt === norm(rest[0] || "/", c.cwd) && !x.gone);
      if (!m) return fail(`mount: ${rest[0]}: mount point not mounted or bad option.`, 32);
      const part = h.disks.flatMap((dk) => dk.parts || []).find((p) => "/dev/" + p.name === m.dev);
      if (/(^|,)rw(,|$)/.test(o)) {
        if (part && part.errors) h.dmesg(`EXT4-fs (${part.name}): warning: mounting fs with errors, running e2fsck is recommended`, (h.clock - h.boot) / 1000);
        m.ro = false;
        if (part) part.ro = false;
      }
      if (/(^|,)ro(,|$)/.test(o)) m.ro = true;
      return { out: [], err: fstabHint(h), code: 0 };
    }
    const err = [...fstabHint(h)];
    if (f.a) {
      for (const e of fstab(h)) {
        if (e.mnt === "/" || e.type === "swap" || e.opts.includes("noauto") || h.mounts.some((m) => m.mnt === e.mnt && !m.gone)) continue;
        const dev = findDev(h, e.spec);
        if (!dev) { if (!e.opts.includes("nofail")) err.push(`mount: ${e.mnt}: can't find ${e.spec}.`); continue; }
        if (dev.errorsHard) { err.push(`mount: ${e.mnt}: wrong fs type, bad option, bad superblock on /dev/${dev.name}, missing codepage or helper program, or other error.`, "       dmesg(1) may have more information after failed mount system call."); continue; }
        if (!h.fs.has(e.mnt)) { err.push(`mount: ${e.mnt}: mount point does not exist.`); continue; }
        doMount(h, dev, e.mnt, e.opts, e.type);
      }
      return { out: [], err, code: err.length > fstabHint(h).length ? 32 : 0 };
    }
    let dev, mnt;
    if (rest.length === 1) {
      const e = fstab(h).find((x) => x.mnt === norm(rest[0], c.cwd) || x.spec === rest[0]);
      if (!e) return fail(`mount: ${rest[0]}: can't find in /etc/fstab.`, 1);
      dev = findDev(h, e.spec);
      mnt = e.mnt;
      if (!dev) return fail([...err, `mount: ${mnt}: can't find ${e.spec}.`], 32);
    } else {
      dev = findDev(h, rest[0]);
      mnt = norm(rest[1], c.cwd);
      if (!dev) return fail(`mount: ${mnt}: special device ${rest[0]} does not exist.`, 32);
    }
    if (h.mounts.some((m) => m.mnt === mnt && !m.gone)) return fail(`mount: ${mnt}: /dev/${dev.name} already mounted on ${mnt}.`, 32);
    if (!h.fs.has(mnt)) return fail(`mount: ${mnt}: mount point does not exist.`, 32);
    doMount(h, dev, mnt, o, f.t);
    return { out: [], err, code: 0 };
  };
  CMDS.umount = (c, args) => {
    const h = c.h;
    const target = norm(args.filter((a) => !a.startsWith("-"))[0] || "", c.cwd);
    const m = h.mounts.find((x) => (x.mnt === target || x.dev === target) && !x.gone);
    if (c.user !== "root") return fail(`umount: ${target}: must be superuser to unmount.`, 32);
    if (!m) return fail(`umount: ${target}: not mounted.`, 32);
    const inside = (p) => p === m.mnt || p.startsWith(m.mnt + "/");
    const busy = h.procs.some((p) => (p.cwd && inside(p.cwd)) || p.fds.some((fd) => inside(fd.path))) || inside(h.sess.cwd);
    if (busy && !args.includes("-l")) return fail(`umount: ${m.mnt}: target is busy.`, 32);
    m.gone = true;
    return ok();
  };
  CMDS.fsck = CMDS["e2fsck"] = CMDS["fsck.ext4"] = (c, args) => {
    const h = c.h;
    const devArg = args.find((a) => a.startsWith("/dev/")) || "";
    const part = h.disks.flatMap((dk) => dk.parts || []).find((p) => "/dev/" + p.name === devArg);
    const head = c.name === "fsck" ? ["fsck from util-linux 2.39.3", "e2fsck 1.47.0 (5-Feb-2023)"] : ["e2fsck 1.47.0 (5-Feb-2023)"];
    if (c.user !== "root") return fail([...head.slice(0, -1), `${c.name === "fsck" ? "fsck.ext4" : c.name}: Permission denied while trying to open ${devArg}`, "", "You must have r/w access to the filesystem or be root"], 8);
    if (!part) return fail([...head, `${c.name === "fsck" ? "fsck.ext4" : c.name}: No such file or directory while trying to open ${devArg}`, "Possibly non-existent device?"], 8);
    if (h.mounts.some((m) => m.dev === devArg && !m.gone)) return fail([...head.slice(-1), `${devArg} is mounted.`, `e2fsck: Cannot continue, aborting.`, ""], 8);
    const files = `${part.iused || 41208}/${part.inodes || 6553600} files`;
    if (!part.errors) return ok([...head, `${devArg}: clean, ${files}, 9124467/26214144 blocks`]);
    if (!args.some((a) => /^-[a-z]*[yp]/.test(a))) return { out: [...head, `${devArg} contains a file system with errors, check forced.`, "Pass 1: Checking inodes, blocks, and sizes", "Inode 1572883 has an invalid extent node (blk 6324224, lblk 0)", "Clear<y>? "], err: [], code: 4, notes: ["(fsck asks before every fix. Run it again with -y to answer yes to all, or -p to fix what is safe)"] };
    part.errors = false;
    part.errorsHard = false;
    return { out: [...head, `${devArg} contains a file system with errors, check forced.`, "Pass 1: Checking inodes, blocks, and sizes", "Inode 1572883 has an invalid extent node (blk 6324224, lblk 0)", "Clear? yes", "",
      "Inode 1572883 extent tree (at level 1) could be shorter.  Optimize? yes", "", "Pass 1E: Optimizing extent trees", "Pass 2: Checking directory structure", "Pass 3: Checking directory connectivity", "Pass 4: Checking reference counts", "Pass 5: Checking group summary information",
      "Block bitmap differences:  -(6324224--6324231)", "Fix? yes", "", "Free blocks count wrong for group #193 (21542, counted=21550).", "Fix? yes", "", "", `${devArg}: ***** FILE SYSTEM WAS MODIFIED *****`, `${devArg}: ${files} (0.4% non-contiguous), 9124467/26214144 blocks`], err: [], code: 1 };
  };
  CMDS.growpart = (c, args) => {
    const h = c.h;
    const [diskArg, num] = args;
    const dk = h.disks.find((x) => "/dev/" + x.name === diskArg);
    if (!dk) return fail(`FAILED: ${diskArg}: does not exist`, 2);
    if (c.user !== "root") return fail(`FAILED: failed to get start and size for ${diskArg}${num}`, 2);
    const p = (dk.parts || []).find((x) => x.name === dk.name + (/\d$/.test(dk.name) ? "p" : "") + num);
    if (!p) return fail(`FAILED: ${diskArg}: partition ${num} does not exist`, 2);
    const sectors = (b) => Math.round(b / 512);
    const others = dk.parts.filter((x) => x !== p).reduce((s, x) => s + x.size, 0) + MiB;
    const max = dk.size - others;
    if (p.size >= max - MiB) return { out: [`NOCHANGE: partition ${num} is size ${sectors(p.size)}. it cannot be grown`], err: [], code: 1 };
    const old = p.size;
    p.size = max;
    return ok([`CHANGED: partition=${num} start=227328 old: size=${sectors(old)} end=${sectors(old) + 227327} new: size=${sectors(max)} end=${sectors(max) + 227327}`]);
  };
  CMDS.resize2fs = (c, args) => {
    const h = c.h;
    const devArg = args.find((a) => a.startsWith("/dev/")) || "";
    const part = h.disks.flatMap((dk) => dk.parts || []).find((p) => "/dev/" + p.name === devArg);
    if (!part) return fail(["resize2fs 1.47.0 (5-Feb-2023)", `open: No such file or directory while opening ${devArg}`]);
    if (c.user !== "root") return fail(["resize2fs 1.47.0 (5-Feb-2023)", `open: Permission denied while opening ${devArg}`]);
    const m = h.mounts.find((x) => x.dev === devArg && !x.gone);
    const fsSize = m ? m.size : part.fsSize || part.size;
    const blocks = (b) => Math.floor(b / 4096);
    if (blocks(part.size) <= blocks(fsSize)) return ok(["resize2fs 1.47.0 (5-Feb-2023)", `The filesystem is already ${blocks(fsSize)} (4k) blocks long.  Nothing to do!`, ""]);
    if (m) m.size = part.size;
    part.fsSize = part.size;
    return ok(["resize2fs 1.47.0 (5-Feb-2023)", `Filesystem at ${devArg} is mounted on ${m ? m.mnt : "/"}; on-line resizing required`, "old_desc_blocks = 3, new_desc_blocks = 7", `The filesystem on ${devArg} is now ${blocks(part.size)} (4k) blocks long.`, ""]);
  };
  CMDS.swapon = (c, args) => {
    const h = c.h, m = memStats(h);
    if (args.includes("--show") || args.includes("-s") || !args.length) return ok(h.mem.swap ? ["NAME      TYPE SIZE USED PRIO", `/swap.img file ${human(h.mem.swap * 1024)} ${human(m.swapUsed * 1024).padStart(4)}   -2`] : []);
    if (c.user !== "root") return fail(`swapon: /swap.img: swapon failed: Operation not permitted`);
    if (h.mem.swapOff) { h.mem.swap = h.mem.swapOff; h.mem.swapOff = 0; }
    return ok();
  };
  CMDS.swapoff = (c) => {
    const h = c.h, m = memStats(h);
    if (c.user !== "root") return fail("swapoff: /swap.img: swapoff failed: Operation not permitted");
    if (!h.mem.swap) return ok();
    // Everything in swap must fit back into free RAM.
    if (m.swapUsed > m.free + m.cache * 0.8) return fail("swapoff: /swap.img: swapoff failed: Cannot allocate memory", 255);
    h.mem.swapOff = h.mem.swap;
    h.mem.swap = 0;
    h.mem.swapBase = 0;
    return ok();
  };
  CMDS.truncate = (c, args) => {
    const { f, rest } = opts(args, "s");
    if (f.s == null) return fail(["truncate: you must specify either '--size' or '--reference'", "Try 'truncate --help' for more information."]);
    const err = [];
    for (const t of rest) {
      const path = norm(t, c.cwd);
      const r = c.h.lookup(path, c.user);
      if (r.node && r.node.virtual && r.node.write) { const e = r.node.write("", c.user); if (e) err.push(`truncate: cannot open '${t}' for writing: ${ERR[e] || e}`); continue; }
      if (r.err) { if (f.c) continue; const e = c.h.writeFile(path, "", c.user, false, c.umask); if (e) err.push(`truncate: cannot open '${t}' for writing: ${ERR[e]}`); continue; }
      if (!c.h.can(c.user, r.node, 2)) { err.push(`truncate: cannot open '${t}' for writing: ${ERR.EACCES}`); continue; }
      if (r.node.imm) { err.push(`truncate: cannot open '${t}' for writing: ${ERR.EPERM}`); continue; }
      const size = L.parseSize(String(f.s).replace(/^0$/, "0")) || 0;
      delete r.node.gen;
      r.node.data = "";
      r.node.size = size;
      r.node.mt = c.h.clock;
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  };

  // --- network -----------------------------------------------------------------------

  const ipNum = (ip) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
  const inNet = (ip, cidr) => { const [net, bits] = cidr.split("/"); const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0; return (ipNum(ip) & mask) >>> 0 === (ipNum(net) & mask) >>> 0; };
  const isIp = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
  const myIps = (h) => h.net.ifaces.filter((i) => i.up).map((i) => i.ip.split("/")[0]);
  function routeTo(h, ip) {
    if (ip.startsWith("127.") || myIps(h).includes(ip)) return { local: true };
    const eth = h.net.ifaces.find((i) => i.name !== "lo" && i.up);
    if (eth && inNet(ip, eth.ip.replace(/\.\d+\//, ".0/"))) return { dev: eth.name };
    const def = h.net.routes.find((r) => r.dst === "default");
    if (!def) return null;
    return { via: def.via, dev: def.dev };
  }
  function nameservers(h) {
    return lines(h.read("/etc/resolv.conf") || "").map((l) => /^\s*nameserver\s+(\S+)/.exec(l)).filter(Boolean).map((m) => m[1]);
  }
  // DNS: ask the nameservers in /etc/resolv.conf, in order.
  function dns(h, name, server) {
    const fq = name.replace(/\.$/, "");
    const search = (/^\s*search\s+(.+)$/m.exec(h.read("/etc/resolv.conf") || "") || [])[1];
    const servers = server ? [server] : nameservers(h);
    if (!servers.length) servers.push("127.0.0.1");
    for (const s of servers) {
      const srv = h.world.dns[s];
      if (!srv || !routeTo(h, s) || (srv.needsDefault && !h.net.routes.some((r) => r.dst === "default"))) continue;
      const tries = fq.includes(".") ? [fq] : [fq, ...(search ? search.split(/\s+/).map((d) => `${fq}.${d}`) : [])];
      for (const t of tries) if (h.world.records[t]) return { ip: h.world.records[t], server: s, name: t };
      return { nx: true, server: s };
    }
    return { timeout: true, servers };
  }
  // The C library: /etc/hosts first, then DNS (nsswitch "files dns").
  function resolve(h, name) {
    if (isIp(name)) return { ip: name };
    if (name === "localhost") return { ip: "127.0.0.1" };
    for (const l of lines(h.read("/etc/hosts") || "")) {
      const f = l.replace(/#.*/, "").trim().split(/\s+/);
      if (f.length > 1 && f.slice(1).includes(name)) return { ip: f[0], hosts: true };
    }
    return dns(h, name);
  }
  // Is a remote host allowed in on a port by the firewall?
  function inbound(h, port, from) {
    const fw = h.net.fw;
    if (!fw.active) return true;
    return fw.rules.some((r) => r.action === "ALLOW" && (r.port === port || r.port == null) && (!r.from || inNet(from, r.from.includes("/") ? r.from : r.from + "/32")));
  }
  function listener(h, ip, port) {
    for (const p of h.procs) for (const l of p.listen) if (l.port === port && (l.addr === "0.0.0.0" || l.addr === "*" || l.addr === ip || (ip.startsWith("127.") && l.addr.startsWith("127.")))) return p;
    return null;
  }
  // An HTTP request from this host. Returns {code, body, headers} or {err, exit}.
  function http(h, url, timeout) {
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url) || /^()([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) return { exit: 3, err: `curl: (3) URL rejected: Malformed input to a URL function` };
    const scheme = m[1] || "http", host = m[2], port = Number(m[3] || (scheme === "https" ? 443 : 80)), path = m[4] || "/";
    const r = resolve(h, host);
    if (!r.ip) return { exit: 6, err: `curl: (6) Could not resolve host: ${host}` };
    const route = routeTo(h, r.ip);
    if (!route) return { exit: 7, err: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server` };
    if (route.local) {
      const p = listener(h, r.ip, port);
      if (!p) return { exit: 7, err: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server` };
      const res = p.http ? p.http(h, path, p) : { code: 200, body: ["ok"] };
      return { ...res, ip: r.ip, port, host };
    }
    const remote = h.world.hosts[r.ip];
    const svc = remote && remote.ports && remote.ports[port];
    if (!svc) return { exit: 28, err: timeout ? `curl: (28) Connection timed out after ${timeout * 1000 + 1} milliseconds` : `curl: (28) Failed to connect to ${host} port ${port} after 134106 ms: Couldn't connect to server` };
    if (scheme === "https" && h.clockSkew && Math.abs(h.clockSkew) > 3600000) {
      return { exit: 60, err: ["curl: (60) SSL certificate problem: certificate is not yet valid", "More details here: https://curl.se/docs/sslcerts.html", "", "curl failed to verify the legitimacy of the server and therefore could not", "establish a secure connection to it. To learn more about this situation and", "how to fix it, please visit the web page mentioned above."] };
    }
    const res = typeof svc === "function" ? svc(h, path) : svc;
    return { code: 200, body: [], ...res, ip: r.ip, port, host };
  }
  const REASON = { 200: "OK", 301: "Moved Permanently", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
  CMDS.curl = (c, args) => {
    const { f, rest } = opts(args, "omwXHd");
    const url = rest[0];
    if (!url) return fail(["curl: try 'curl --help' or 'curl --manual' for more information"], 2);
    const r = http(c.h, url, f.m || f["max-time"] || f["connect-timeout"]);
    const verbose = f.v ? [`*   Trying ${r.ip || url}:${r.port || 80}...`] : [];
    if (r.exit) return { out: [], err: f.s && !f.S ? [] : [...verbose, ...[].concat(r.err)], code: r.exit };
    const headers = [`HTTP/1.1 ${r.code} ${REASON[r.code] || ""}`, `Server: ${r.server || "nginx/1.24.0 (Ubuntu)"}`, `Date: ${longDate(c.h.clock).replace(/^(\w+) (\d+)-(\d+)-(\d+)/, "$1, $4 Oct $2")} GMT`, `Content-Type: ${r.type || "text/html"}`, ...(r.headers || [])];
    if (f.f && r.code >= 400) return { out: [], err: [`curl: (22) The requested URL returned error: ${r.code}`], code: 22 };
    const out = f.I ? headers : f.w ? [String(f.w).replace(/%\{http_code\}/g, String(r.code)).replace(/\\n/g, "")] : r.body || [];
    if (f.o) { c.h.writeFile(norm(f.o, c.cwd), (r.body || []).join("\n") + "\n", c.user, false, c.umask); return ok(f.w ? out : []); }
    if (f.v) return { out, err: [...verbose, `* Connected to ${r.host} (${r.ip}) port ${r.port}`, `> GET ${url.replace(/^\w+:\/\/[^/]+/, "") || "/"} HTTP/1.1`, `> Host: ${r.host}${r.port === 80 ? "" : ":" + r.port}`, "> User-Agent: curl/8.5.0", "> Accept: */*", ">", ...headers.map((x) => "< " + x), "<"], code: 0 };
    return ok(out);
  };
  CMDS.wget = (c, args) => {
    const url = args.find((a) => !a.startsWith("-"));
    if (!url || !/^https?:\/\/[^/:]+/.test(url)) return fail(["wget: missing URL", "Usage: wget [OPTION]... [URL]..."], 1);
    const r = http(c.h, url || "", 10);
    if (r.exit === 6) return fail([`--${L.isoDay(c.h.clock)} ${hms(c.h.clock)}--  ${url}`, `Resolving ${/\/\/([^/:]+)/.exec(url)[1]}... failed: Temporary failure in name resolution.`, `wget: unable to resolve host address '${/\/\/([^/:]+)/.exec(url)[1]}'`], 4);
    if (r.exit) return fail([`--${L.isoDay(c.h.clock)} ${hms(c.h.clock)}--  ${url}`, "failed: Connection timed out."], 4);
    return ok([`--${L.isoDay(c.h.clock)} ${hms(c.h.clock)}--  ${url}`, `HTTP request sent, awaiting response... ${r.code} ${REASON[r.code]}`]);
  };
  CMDS.ping = (c, args) => {
    const { f, rest } = opts(args, "cWi");
    const host = rest[0];
    if (!host) return fail("ping: usage error: Destination address required", 1);
    const n = Number(f.c || 4);
    const r = resolve(c.h, host);
    if (!r.ip) return fail(r.nx ? `ping: ${host}: Name or service not known` : `ping: ${host}: Temporary failure in name resolution`, 2);
    const route = routeTo(c.h, r.ip);
    if (!route) return fail("ping: connect: Network is unreachable", 2);
    const alive = route.local || (c.h.world.hosts[r.ip] && c.h.world.hosts[r.ip].ping !== false);
    const head = `PING ${host} (${r.ip}) 56(84) bytes of data.`;
    const notes = f.c ? [] : ["(ping runs until Ctrl+C; the playground sends 4, like ping -c 4)"];
    if (!alive) return { out: [head, "", `--- ${host} ping statistics ---`, `${n} packets transmitted, 0 received, 100% packet loss, time ${(n - 1) * 1000 + 62}ms`, ""], err: [], code: 1, notes };
    const ms = route.local ? 0.031 : (c.h.world.hosts[r.ip].rtt || 0.6);
    return { out: [head, ...Array.from({ length: n }, (_, i) => `64 bytes from ${r.ip}: icmp_seq=${i + 1} ttl=${route.local ? 64 : 63} time=${(ms * (1 + i * 0.07)).toFixed(3)} ms`), "", `--- ${host} ping statistics ---`,
      `${n} packets transmitted, ${n} received, 0% packet loss, time ${(n - 1) * 1001}ms`, `rtt min/avg/max/mdev = ${ms.toFixed(3)}/${(ms * 1.1).toFixed(3)}/${(ms * 1.21).toFixed(3)}/${(ms * 0.07).toFixed(3)} ms`], err: [], code: 0, notes };
  };
  CMDS.dig = (c, args) => {
    const h = c.h;
    const server = (args.find((a) => a.startsWith("@")) || "").slice(1) || null;
    const short = args.includes("+short");
    const name = args.find((a) => !a.startsWith("@") && !a.startsWith("+") && !a.startsWith("-") && !/^(A|AAAA|MX|NS|TXT|CNAME)$/.test(a)) || ".";
    const r = dns(h, name, server);
    const banner = `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${args.join(" ")}`;
    if (r.timeout) {
      const errs = r.servers.flatMap((s) => [`;; communications error to ${s}#53: timed out`]);
      return { out: short ? errs.concat(";; no servers could be reached") : [...errs, ...errs, ...errs.slice(0, 1), "", banner, ";; global options: +cmd", ";; no servers could be reached"], err: [], code: 9 };
    }
    if (short) return ok(r.ip ? [r.ip] : []);
    const fq = (r.name || name).replace(/\.?$/, ".");
    return ok([banner, ";; global options: +cmd", ";; Got answer:", `;; ->>HEADER<<- opcode: QUERY, status: ${r.nx ? "NXDOMAIN" : "NOERROR"}, id: 41352`, `;; flags: qr rd ra; QUERY: 1, ANSWER: ${r.ip ? 1 : 0}, AUTHORITY: ${r.nx ? 1 : 0}, ADDITIONAL: 1`, "",
      ";; OPT PSEUDOSECTION:", "; EDNS: version: 0, flags:; udp: 1232", ";; QUESTION SECTION:", `;${fq}\t\tIN\tA`, "", ...(r.ip ? [";; ANSWER SECTION:", `${fq}\t300\tIN\tA\t${r.ip}`, ""] : []),
      ";; Query time: 4 msec", `;; SERVER: ${r.server}#53(${r.server}) (UDP)`, `;; WHEN: ${longDate(h.clock).replace(/^(\w+) (\d+)-(\d+)-(\d+)/, "$1 Oct $4")} UTC ${new Date(h.clock).getUTCFullYear()}`, `;; MSG SIZE  rcvd: ${r.ip ? 60 : 108}`, ""]);
  };
  CMDS.nslookup = (c, args) => {
    const name = args.find((a) => !a.startsWith("-"));
    const r = dns(c.h, name || "", args[1] && !args[1].startsWith("-") ? args[1] : null);
    if (r.timeout) return { out: r.servers.map((s) => `;; communications error to ${s}#53: timed out`).concat(r.servers.map((s) => `;; communications error to ${s}#53: timed out`), [";; no servers could be reached", ""]), err: [], code: 1 };
    if (r.nx) return { out: [`Server:\t\t${r.server}`, `Address:\t${r.server}#53`, "", `** server can't find ${name}: NXDOMAIN`, ""], err: [], code: 1 };
    return ok([`Server:\t\t${r.server}`, `Address:\t${r.server}#53`, "", "Non-authoritative answer:", `Name:\t${r.name}`, `Address: ${r.ip}`, ""]);
  };
  CMDS.host = (c, args) => {
    const r = dns(c.h, args[0] || "");
    if (r.timeout) return fail(`;; communications error to ${r.servers[0]}#53: timed out\n;; no servers could be reached`, 1);
    if (r.nx) return fail(`Host ${args[0]} not found: 3(NXDOMAIN)`, 1);
    return ok([`${r.name} has address ${r.ip}`]);
  };
  CMDS.getent = (c, args) => {
    const [db, key] = args;
    const h = c.h;
    if (db === "hosts" || db === "ahosts") { const r = resolve(h, key || ""); return r.ip ? ok([`${r.ip.padEnd(15)} ${key}`]) : fail([], 2); }
    if (db === "passwd") { const l = lines(h.read("/etc/passwd") || "").filter((x) => !key || x.startsWith(key + ":")); return l.length ? ok(l) : fail([], 2); }
    if (db === "group") { const l = lines(h.read("/etc/group") || "").filter((x) => !key || x.startsWith(key + ":")); return l.length ? ok(l) : fail([], 2); }
    return fail(`Unknown database: ${db}`);
  };
  CMDS.nc = (c, args) => {
    const rest = args.filter((a) => !a.startsWith("-"));
    const [host, port] = rest;
    const r = resolve(c.h, host || "");
    if (!r.ip) return fail(`nc: getaddrinfo for host "${host}" port ${port}: Temporary failure in name resolution`);
    const route = routeTo(c.h, r.ip);
    const open = route && (route.local ? listener(c.h, r.ip, Number(port)) : (c.h.world.hosts[r.ip] || { ports: {} }).ports[Number(port)]);
    return open ? { out: [], err: [`Connection to ${host} (${r.ip}) ${port} port [tcp/*] succeeded!`], code: 0 } : fail(route && route.local ? `nc: connect to ${host} port ${port} (tcp) failed: Connection refused` : `nc: connect to ${host} port ${port} (tcp) timed out: Operation now in progress`);
  };
  CMDS.ss = (c, args) => {
    const h = c.h;
    const { f } = opts(args);
    const rows = [];
    for (const p of h.procs) for (const l of p.listen) {
      if (l.proto === "udp" ? !f.u : !f.t) continue;
      const users = f.p && c.user === "root" ? `users:(("${p.comm}",pid=${p.pid},fd=${l.fd || 6})${(l.workers || []).map((w) => `,("${p.comm}",pid=${w},fd=${l.fd || 6})`).join("")})` : "";
      rows.push(`${f.u && f.t ? (l.proto || "tcp").padEnd(5) + " " : ""}${l.proto === "udp" ? "UNCONN" : "LISTEN"} 0      ${l.proto === "udp" ? "0  " : "511"}    ${(`${l.addr === "*" ? "*" : l.addr}:${l.port}`).padStart(20)} ${(l.addr.includes(":") ? "[::]:*" : "0.0.0.0:*").padStart(14)}    ${users}`.trimEnd());
    }
    const head = `${f.u && f.t ? "Netid " : ""}State  Recv-Q Send-Q        Local Address:Port      Peer Address:Port Process`;
    return ok([head, ...rows]);
  };
  CMDS.ip = (c, args) => {
    const h = c.h;
    const a = args.filter((x) => !/^-(4|6|br|c|color)$/.test(x));
    const brief = args.includes("-br");
    const [obj = "", verb = "show", ...rest] = a;
    if (/^a(ddr(ess)?)?$/.test(obj)) {
      if (brief) return ok(h.net.ifaces.map((i) => `${i.name.padEnd(16)} ${(i.up ? (i.name === "lo" ? "UNKNOWN" : "UP") : "DOWN").padEnd(14)} ${i.ip}`));
      return ok(h.net.ifaces.flatMap((i, n) => [`${n + 1}: ${i.name}: <${i.name === "lo" ? "LOOPBACK" : "BROADCAST,MULTICAST"},${i.up ? "UP,LOWER_UP" : ""}> mtu ${i.mtu} qdisc ${i.name === "lo" ? "noqueue" : "mq"} state ${i.up ? (i.name === "lo" ? "UNKNOWN" : "UP") : "DOWN"} group default qlen 1000`,
        `    link/${i.name === "lo" ? "loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00" : `ether ${i.mac} brd ff:ff:ff:ff:ff:ff`}`, `    inet ${i.ip}${i.name === "lo" ? " scope host lo" : ` metric 100 brd ${i.ip.replace(/\.\d+\/\d+$/, ".255")} scope global dynamic ${i.name}`}`,
        `       valid_lft ${i.name === "lo" ? "forever preferred_lft forever" : "3121sec preferred_lft 3121sec"}`]));
    }
    if (/^l(ink)?$/.test(obj)) return ok(h.net.ifaces.flatMap((i, n) => [`${n + 1}: ${i.name}: <${i.name === "lo" ? "LOOPBACK" : "BROADCAST,MULTICAST"},UP,LOWER_UP> mtu ${i.mtu} qdisc mq state UP mode DEFAULT group default qlen 1000`, `    link/ether ${i.mac || "00:00:00:00:00:00"} brd ff:ff:ff:ff:ff:ff`]));
    if (/^r(o(ute)?)?$/.test(obj)) {
      if (verb === "show" || verb === "list" || verb === "ls") {
        return ok(h.net.routes.map((r) => (r.dst === "default" ? `default via ${r.via} dev ${r.dev} proto ${r.proto || "dhcp"} src ${myIps(h)[1] || ""} metric 100` : `${r.dst} dev ${r.dev} proto kernel scope link src ${myIps(h)[1] || ""} metric 100`)));
      }
      if (verb === "get") { const rt = routeTo(h, rest[0] || ""); return rt ? ok([`${rest[0]} ${rt.via ? `via ${rt.via} ` : ""}dev ${rt.dev || "lo"} src ${myIps(h)[1]} uid 1000`, "    cache"]) : fail("RTNETLINK answers: Network is unreachable", 2); }
      if (verb === "add" || verb === "del" || verb === "delete" || verb === "replace") {
        if (c.user !== "root") return fail("RTNETLINK answers: Operation not permitted", 2);
        const dst = rest[0] === "default" || rest[0] === "0.0.0.0/0" ? "default" : rest[0];
        const via = rest[rest.indexOf("via") + 1];
        const dev = rest.includes("dev") ? rest[rest.indexOf("dev") + 1] : "eth0";
        const has = h.net.routes.find((r) => r.dst === dst);
        if (verb.startsWith("del")) { if (!has) return fail("RTNETLINK answers: No such process", 2); h.net.routes = h.net.routes.filter((r) => r !== has); return ok(); }
        if (has && verb === "add") return fail("RTNETLINK answers: File exists", 2);
        const eth = h.net.ifaces.find((i) => i.name === dev);
        if (!eth) return fail(`Cannot find device "${dev}"`, 1);
        if (via && !inNet(via, eth.ip.replace(/\.\d+\//, ".0/"))) return fail("Error: Nexthop has invalid gateway.", 2);
        if (has) h.net.routes = h.net.routes.filter((r) => r !== has);
        h.net.routes.unshift({ dst, via, dev, proto: "static" });
        return ok();
      }
    }
    return fail(`Object "${obj}" is unknown, try "ip help".`, 1);
  };
  CMDS.ufw = (c, args) => {
    const h = c.h, fw = h.net.fw;
    if (c.user !== "root") return fail("ERROR: You need to be root to run this script", 1);
    const [verb, ...rest] = args;
    const portOf = (s) => { const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(s || ""); return m ? { port: Number(m[1]), proto: m[2] || "" } : null; };
    const save = () => { h.file("/etc/ufw/ufw.conf", `# /etc/ufw/ufw.conf\nENABLED=${fw.enabled ? "yes" : "no"}\nLOGLEVEL=low\n`); };
    switch (verb) {
      case "status": {
        if (!fw.active) return ok(["Status: inactive"]);
        const rule = (r, i) => `${rest[0] === "numbered" ? `[${String(i + 1).padStart(2)}] ` : ""}${(r.port == null ? "Anywhere" : r.port + (r.proto ? "/" + r.proto : "")).padEnd(26)} ${r.action === "ALLOW" ? "ALLOW IN   " : "DENY IN    "} ${r.from || "Anywhere"}`;
        return ok(["Status: active", ...(rest[0] === "verbose" ? ["Logging: on (low)", "Default: deny (incoming), allow (outgoing), deny (routed)", "New profiles: skip"] : []), "", "To                         Action      From", "--                         ------      ----", ...fw.rules.map(rule), ""]);
      }
      case "enable": fw.active = fw.enabled = true; save(); return ok(["Command may disrupt existing ssh connections. Proceed with operation (y|n)? y", "Firewall is active and enabled on system startup"]);
      case "disable": fw.active = fw.enabled = false; save(); return ok(["Firewall stopped and disabled on system startup"]);
      case "reload": return ok([fw.active ? "Firewall reloaded" : "Firewall not enabled (skipping reload)"]);
      case "allow": case "deny": {
        let rule;
        if (rest[0] === "from") {
          const port = rest.includes("port") ? Number(rest[rest.indexOf("port") + 1]) : null;
          rule = { action: verb.toUpperCase(), from: rest[1], port, proto: rest.includes("proto") ? rest[rest.indexOf("proto") + 1] : "" };
        } else {
          const named = { OpenSSH: 22, ssh: 22, http: 80, https: 443, "Nginx Full": 80 };
          const p = portOf(rest[0]) || (named[rest[0]] ? { port: named[rest[0]], proto: "tcp" } : null);
          if (!p) return fail(`ERROR: Could not find a profile matching '${rest[0]}'`);
          rule = { action: verb.toUpperCase(), ...p };
        }
        if (fw.rules.some((r) => r.port === rule.port && r.from === rule.from && r.action === rule.action)) return ok(["Skipping adding existing rule", "Skipping adding existing rule (v6)"]);
        fw.rules.push(rule);
        return ok(rule.from ? ["Rule added"] : ["Rule added", "Rule added (v6)"]);
      }
      case "delete": {
        const p = portOf(rest[1] || rest[0]);
        const before = fw.rules.length;
        fw.rules = fw.rules.filter((r) => !(p && r.port === p.port));
        return before === fw.rules.length ? fail("Could not delete non-existent rule") : ok(["Rule deleted", "Rule deleted (v6)"]);
      }
      default: return fail(`ERROR: Invalid syntax\n\nUsage: ufw COMMAND`);
    }
  };
  CMDS.iptables = (c, args) => {
    if (c.user !== "root") return fail(["iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)", ""], 4);
    const fw = c.h.net.fw;
    if (!args.includes("-L") && !args.includes("-S")) return fail("(this playground manages the firewall through ufw: try sudo ufw status)", 1);
    return ok([`Chain INPUT (policy ${fw.active ? "DROP" : "ACCEPT"})`, "target     prot opt source               destination", ...(fw.active ? ["ufw-before-input  all  --  0.0.0.0/0            0.0.0.0/0", ...fw.rules.map((r) => `ACCEPT     tcp  --  ${(r.from || "0.0.0.0/0").padEnd(20)} 0.0.0.0/0            tcp dpt:${r.port}`)] : [])]);
  };
  CMDS.hostname = (c, args) => {
    if (args[0] === "-I") return ok([myIps(c.h).filter((ip) => !ip.startsWith("127.")).join(" ") + " "]);
    if (args.length && !args[0].startsWith("-")) {
      if (c.user !== "root") return fail("hostname: you must be root to change the host name");
      c.h.hostname = args[0];
      return ok();
    }
    return ok([c.h.hostname]);
  };
  CMDS.hostnamectl = (c, args) => {
    const h = c.h;
    if (args[0] === "set-hostname" || args[0] === "hostname" && args[1]) {
      if (c.user !== "root") return fail("Could not set static hostname: Access denied");
      h.hostname = args[1];
      h.file("/etc/hostname", args[1] + "\n");
      return ok();
    }
    return ok([` Static hostname: ${h.hostname}`, `       Icon name: computer-vm`, `         Chassis: vm 🖴`.replace(" 🖴", ""), `      Machine ID: ec2a1f3e9c6b4d0f8e21a7c35d90b1f4`, `Operating System: Ubuntu 24.04.1 LTS`, `          Kernel: Linux 6.8.0-1015-aws`, `    Architecture: x86-64`]);
  };
  CMDS.uname = (c, args) => ok([args.includes("-r") ? c.h.kernel : args.includes("-a") ? `Linux ${c.h.hostname} ${c.h.kernel} #16-Ubuntu SMP Mon Aug 19 20:17:21 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux` : "Linux"]);
  CMDS.lscpu = (c) => ok(["Architecture:             x86_64", "  CPU op-mode(s):         32-bit, 64-bit", `CPU(s):                   ${c.h.cpus || 2}`, "  On-line CPU(s) list:    0,1", "Vendor ID:                GenuineIntel", "  Model name:             Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz"]);

  // --- users and sudo ---------------------------------------------------------------------

  // Parse sudoers: /etc/sudoers then /etc/sudoers.d (files without a dot or ~).
  function sudoers(h) {
    const files = ["/etc/sudoers", ...h.kids("/etc/sudoers.d").filter((k) => !/[.~]/.test(k)).map((k) => "/etc/sudoers.d/" + k)];
    const rules = [], warn = [];
    for (const path of files) {
      const n = h.fs.get(path);
      if (!n) continue;
      if (n.m & 0o002) { warn.push(`sudo: ${path} is world writable`); continue; }
      if (n.u !== "root") { warn.push(`sudo: ${path} is owned by uid ${(h.user(n.u) || { uid: 1000 }).uid}, should be 0`); continue; }
      const ls = lines(n.data || "");
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i].trim();
        if (!l || l.startsWith("#") || l.startsWith("@") || /^Defaults\b/.test(l) || /^[A-Z_]+_Alias\b/.test(l)) continue;
        const m = /^(%?[\w.-]+)\s+([\w.,-]+)\s*=\s*(?:\(([\w:, ]+)\)\s*)?((?:NOPASSWD|PASSWD|SETENV):\s*)?(\S.*)$/.exec(l);
        if (!m || !m[5].split(/\s*,\s*/).every((x) => x === "ALL" || /^\/\S+( .*)?$/.test(x))) return { error: { path, line: i + 1 }, warn };
        rules.push({ who: m[1], nopasswd: /NOPASSWD/.test(m[4] || ""), cmds: m[5].split(/\s*,\s*/), runas: m[3] || "root" });
      }
    }
    return { rules, warn };
  }
  function sudoAllowed(h, user, cmdline) {
    const s = sudoers(h);
    if (s.error) return s;
    const groups = h.groupsOf(user);
    const mine = s.rules.filter((r) => r.who === user || (r.who.startsWith("%") && groups.includes(r.who.slice(1))));
    const hit = mine.find((r) => r.cmds.some((x) => x === "ALL" || cmdline === x || cmdline.startsWith(x + " ") || (x.endsWith(" *") && cmdline.startsWith(x.slice(0, -1)))));
    return { rules: mine, hit, warn: s.warn };
  }
  CMDS.sudo = (c, args, stdin) => {
    const h = c.h;
    // sudo's own options come first; the command and its options follow.
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += /^-[uUgC]$/.test(args[i]) ? 2 : 1;
    const { f } = opts(args.slice(0, i), "uUgC");
    const realRest = args.slice(i);
    const err = [];
    const resolved = resolve(h, h.hostname);
    if (!resolved.ip) err.push(`sudo: unable to resolve host ${h.hostname}: ${resolved.timeout ? "Temporary failure in name resolution" : "Name or service not known"}`);
    const s = sudoers(h);
    if (s.error) {
      return fail([...err, `>>> ${s.error.path}: syntax error near line ${s.error.line} <<<`, `sudo: parse error in ${s.error.path} near line ${s.error.line}`, "sudo: no valid sudoers sources found, quitting", "sudo: error initializing audit plugin sudoers_audit"], 1);
    }
    err.push(...s.warn);
    const target = f.u || "root";
    if (f.l) {
      const who = f.U || c.user;
      if (f.U && c.user !== "root") return fail([...err, `Sorry, user ${c.user} is not allowed to list another user's privileges.`]);
      const a = sudoAllowed(h, who, "");
      if (!a.rules.length) return { out: [`User ${who} is not allowed to run sudo on ${h.hostname}.`], err, code: 1 };
      return { out: [`Matching Defaults entries for ${who} on ${h.hostname}:`, "    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty", "", `User ${who} may run the following commands on ${h.hostname}:`, ...a.rules.map((r) => `    (${r.runas}) ${r.nopasswd ? "NOPASSWD: " : ""}${r.cmds.join(", ")}`)], err, code: 0 };
    }
    if (f.k) return ok();
    const login = f.i || f.s || (realRest[0] === "su" && (realRest[1] === "-" || realRest.length === 1)) || (realRest[0] === "-i");
    if (!realRest.length && !login) return fail(["usage: sudo -h | -K | -k | -V", "usage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]", "usage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [<command>]"], 1);
    const sc = { ...c, user: target, env: { ...c.env, HOME: (h.user(target) || {}).home || "/root", USER: target, LOGNAME: target, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin" }, umask: 0o022 };
    let path;
    if (!login) {
      const w = realRest[0] && L.which(sc, realRest[0], null, true);
      if (realRest[0] && realRest[0].includes("/")) {
        path = norm(realRest[0], c.cwd);
        const r = h.lookup(path, "root");
        if (r.err || r.node.t !== "f" || !(r.node.m & 0o111)) return fail([...err, `sudo: ${realRest[0]}: command not found`], 1);
      } else if (!w || w.builtin) return fail([...err, `sudo: ${realRest[0]}: command not found`], 1);
      else path = w.path;
    }
    if (c.user !== "root") {
      const line = login ? "ALL" : [path, ...realRest.slice(1)].join(" ");
      const a = sudoAllowed(h, c.user, line);
      if (!a.rules.length) return fail([...err, `${c.user} is not in the sudoers file.`], 1);
      if (!a.hit) return fail([...err, `Sorry, user ${c.user} is not allowed to execute '${line}' as ${target} on ${h.hostname}.`], 1);
    }
    if (login) {
      h.sess = { ...h.newSession(target), outer: h.sess };
      return { out: [], err, code: 0 };
    }
    const res = L.exec(sc, [path, ...realRest.slice(1)], stdin);
    return { ...res, err: [...err, ...(res.err || [])] };
  };
  CMDS.su = (c, args) => {
    const h = c.h;
    const target = args.filter((a) => a !== "-" && a !== "-l")[0] || "root";
    if (!h.user(target)) return fail(`su: user ${target} does not exist or the user entry does not contain all the required fields`);
    if (c.user !== "root") return fail(["Password: ", "su: Authentication failure"]);
    const u = h.user(target);
    if (/nologin|false/.test(u.shell)) return fail("This account is currently not available.");
    h.sess = { ...h.newSession(target), outer: h.sess };
    return ok();
  };
  CMDS.visudo = (c, args) => {
    const h = c.h;
    if (c.user !== "root") return fail("visudo: /etc/sudoers: Permission denied");
    if (!args.includes("-c")) return { out: [], err: [], code: 1, notes: ["(visudo opens an editor, which this playground does not have. Edit with sed -i or tee, then check with: visudo -c)"] };
    const s = sudoers(h);
    if (s.error) return fail([`>>> ${s.error.path}: syntax error near line ${s.error.line} <<<`, `parse error in ${s.error.path} near line ${s.error.line}`], 1);
    const files = ["/etc/sudoers", ...h.kids("/etc/sudoers.d").filter((k) => !/[.~]/.test(k)).map((k) => "/etc/sudoers.d/" + k)];
    const out = [], err = [];
    for (const p of files) {
      const n = h.fs.get(p);
      if ((n.m & 0o777) !== 0o440 || n.u !== "root") err.push(`${p}: bad permissions, should be mode 0440`); else out.push(`${p}: parsed OK`);
    }
    return { out, err, code: err.length ? 1 : 0 };
  };
  function editLines(h, path, fn) {
    const n = h.fs.get(path);
    n.data = fn(lines(n.data)).join("\n") + "\n";
  }
  CMDS.useradd = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "sGgdcu");
    const name = rest[0];
    if (c.user !== "root") return fail("useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.", 1);
    if (!name) return fail("Usage: useradd [options] LOGIN", 2);
    if (h.user(name)) return fail(`useradd: user '${name}' already exists`, 9);
    for (const g of String(f.G || "").split(",").filter(Boolean)) if (!h.groups().some((x) => x.name === g)) return fail(`useradd: group '${g}' does not exist`, 6);
    const uid = Math.max(1000, ...h.users().filter((u) => u.uid < 60000).map((u) => u.uid)) + 1;
    const home = f.d || `/home/${name}`;
    const shell = f.s || "/bin/sh";
    editLines(h, "/etc/group", (l) => [...l, `${name}:x:${uid}:`]);
    editLines(h, "/etc/passwd", (l) => [...l, `${name}:x:${uid}:${uid}:${f.c || ""}:${home}:${shell}`]);
    if (h.fs.has("/etc/shadow")) editLines(h, "/etc/shadow", (l) => [...l, `${name}:!:20391:0:99999:7:::`]);
    for (const g of String(f.G || "").split(",").filter(Boolean)) addToGroup(h, name, g);
    if (f.m || f["create-home"]) {
      h.dir(home, { u: name, g: name, m: 0o750 });
      h.file(`${home}/.bashrc`, "# ~/.bashrc: executed by bash(1) for non-login shells.\n", { u: name, g: name });
      h.file(`${home}/.profile`, "# ~/.profile: executed by the command interpreter for login shells.\n", { u: name, g: name });
    }
    return ok();
  };
  const addToGroup = (h, user, group) => editLines(h, "/etc/group", (l) => l.map((x) => {
    const p = x.split(":");
    if (p[0] !== group) return x;
    const m = p[3] ? p[3].split(",") : [];
    if (!m.includes(user)) m.push(user);
    p[3] = m.join(",");
    return p.join(":");
  }));
  CMDS.usermod = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "Gsdgl");
    const name = rest[0];
    if (c.user !== "root") return fail("usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.", 1);
    if (!h.user(name)) return fail(`usermod: user '${name}' does not exist`, 6);
    if (f.G) {
      const want = String(f.G).split(",");
      const missing = want.find((g) => !h.groups().some((x) => x.name === g));
      if (missing) return fail(`usermod: group '${missing}' does not exist`, 6);
      // Without -a, -G replaces every supplementary group.
      editLines(h, "/etc/group", (l) => l.map((x) => {
        const p = x.split(":");
        let m = p[3] ? p[3].split(",") : [];
        if (!f.a) m = m.filter((u) => u !== name);
        if (want.includes(p[0]) && !m.includes(name)) m.push(name);
        p[3] = m.join(",");
        return p.join(":");
      }));
    }
    if (f.s) editLines(h, "/etc/passwd", (l) => l.map((x) => (x.startsWith(name + ":") ? x.replace(/:[^:]*$/, ":" + f.s) : x)));
    if (f.L) editLines(h, "/etc/shadow", (l) => l.map((x) => (x.startsWith(name + ":") ? x.replace(/^([^:]+):/, "$1:!") : x)));
    return ok();
  };
  CMDS.gpasswd = (c, args) => {
    const h = c.h;
    const i = args.indexOf("-a");
    if (i < 0) return fail("Usage: gpasswd [option] GROUP", 2);
    const [user, group] = [args[i + 1], args[i + 2]];
    if (c.user !== "root") return fail("gpasswd: Permission denied.", 1);
    if (!h.user(user)) return fail(`gpasswd: user '${user}' does not exist`, 3);
    if (!h.groups().some((g) => g.name === group)) return fail(`gpasswd: group '${group}' does not exist in /etc/group`, 3);
    addToGroup(h, user, group);
    return ok([`Adding user ${user} to group ${group}`]);
  };
  CMDS.groupadd = (c, args) => {
    const h = c.h;
    const name = args.filter((a) => !a.startsWith("-"))[0];
    if (c.user !== "root") return fail("groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.", 10);
    if (h.groups().some((g) => g.name === name)) return fail(`groupadd: group '${name}' already exists`, 9);
    const gid = Math.max(1000, ...h.groups().filter((g) => g.gid < 60000).map((g) => g.gid)) + 1;
    editLines(h, "/etc/group", (l) => [...l, `${name}:x:${gid}:`]);
    return ok();
  };
  CMDS.userdel = (c, args) => {
    const h = c.h;
    const name = args.filter((a) => !a.startsWith("-"))[0];
    if (c.user !== "root") return fail("userdel: Permission denied.\nuserdel: cannot lock /etc/passwd; try again later.", 1);
    if (!h.user(name)) return fail(`userdel: user '${name}' does not exist`, 6);
    editLines(h, "/etc/passwd", (l) => l.filter((x) => !x.startsWith(name + ":")));
    return ok();
  };
  CMDS.passwd = (c, args) => {
    const name = args.filter((a) => !a.startsWith("-"))[0] || c.user;
    if (name !== c.user && c.user !== "root") return fail("passwd: You may not view or modify password information for " + name + ".");
    if (args.includes("-S")) return ok([`${name} P 2026-10-01 0 99999 7 -1`]);
    return { out: ["New password: ", "Retype new password: ", "passwd: password updated successfully"], err: [], code: 0, notes: ["(the playground typed a practice password for you)"] };
  };
  CMDS.chage = (c, args) => ok(["Last password change\t\t\t\t\t: Oct 01, 2026", "Password expires\t\t\t\t\t: never", "Account expires\t\t\t\t\t\t: never"].filter(() => args.includes("-l")));
  CMDS.last = (c) => ok([`${c.h.sess.user.padEnd(8)} pts/0        203.0.113.24     ${longDate(c.h.clock - 600000).slice(0, 16)}   still logged in`, "", "wtmp begins Thu Oct  1 08:00:12 2026"]);

  // ssh from this host, and sshd's checks for logins to it.
  function keyProblem(h, path, user) {
    const r = h.lookup(path, user);
    if (r.err) return { missing: true };
    const n = r.node;
    if (!h.can(user, n, 4)) return { lines: [`Load key "${path}": Permission denied`] };
    if (n.m & 0o077) {
      return { lines: ["@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@", "@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @", "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        `Permissions 0${(n.m & 0o777).toString(8)} for '${path}' are too open.`, "It is required that your private key files are NOT accessible by others.", "This private key will be ignored.", `Load key "${path}": bad permissions`] };
    }
    return null;
  }
  CMDS.ssh = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "ipoF");
    const [dest, ...cmd] = rest;
    if (!dest) return fail(["usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]", "           destination [command [argument ...]]"], 255);
    const [user, host] = dest.includes("@") ? dest.split("@") : [c.user, dest];
    const r = resolve(h, host);
    if (!r.ip) return fail(`ssh: Could not resolve hostname ${host}: ${r.nx ? "Name or service not known" : "Temporary failure in name resolution"}`, 255);
    const target = h.world.hosts[r.ip] || (routeTo(h, r.ip) && routeTo(h, r.ip).local ? { ssh: "self" } : null);
    if (!routeTo(h, r.ip)) return fail(`ssh: connect to host ${host} port 22: Network is unreachable`, 255);
    if (!target || !target.ssh) return fail(`ssh: connect to host ${host} port 22: Connection timed out`, 255);
    const home = c.env.HOME;
    const keys = f.i ? [norm(f.i, c.cwd)] : [`${home}/.ssh/id_rsa`, `${home}/.ssh/id_ecdsa`, `${home}/.ssh/id_ed25519`];
    const err = [];
    let accepted = false;
    for (const k of keys) {
      const p = keyProblem(h, k, c.user);
      if (p && p.missing) { if (f.i) err.push(`Warning: Identity file ${k} not accessible: No such file or directory.`); continue; }
      if (p) { err.push(...p.lines); continue; }
      if (target.ssh === "self" ? sshdAccepts(h, user).ok : target.ssh.users && target.ssh.users.includes(user) && (!target.ssh.key || target.ssh.key === k.replace(home, "~"))) accepted = true;
    }
    if (!accepted) return fail([...err, `${user}@${host}: Permission denied (publickey).`], 255);
    if (!cmd.length) return { out: [`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-1015-aws x86_64)`, "", `Last login: ${longDate(h.clock - 86400000)} from 10.0.1.10`, "logout", `Connection to ${host} closed.`], err, code: 0, notes: ["(the playground logs out straight away; run a command on the other host with ssh host command)"] };
    if (cmd[0] === "hostname") return { out: [target.name || host], err, code: 0 };
    return { out: [], err, code: 0, notes: [`(connected as ${user}@${host}; the playground runs only hostname on other machines)`] };
  };
  // sshd StrictModes: home, ~/.ssh and authorized_keys must not be writable by others.
  function sshdAccepts(h, user) {
    const u = h.user(user);
    if (!u) return { ok: false, why: `Invalid user ${user} from 10.0.1.30 port 51122` };
    const check = [[u.home, "directory"], [`${u.home}/.ssh`, "directory"], [`${u.home}/.ssh/authorized_keys`, "file"]];
    for (const [p, kind] of check) {
      const n = h.fs.get(p);
      if (!n) return { ok: false, why: `Authentication refused: could not open ${kind} '${p}': No such file or directory` };
      if ((n.u !== user && n.u !== "root") || n.m & 0o022) return { ok: false, why: `Authentication refused: bad ownership or modes for ${kind} ${p}` };
    }
    return { ok: true };
  }

  // --- packages ----------------------------------------------------------------------------

  function aptNet(h) {
    const r = resolve(h, "archive.ubuntu.com");
    if (!r.ip) return { err: `Temporary failure resolving 'archive.ubuntu.com'` };
    if (!routeTo(h, r.ip)) return { err: "Could not connect to archive.ubuntu.com:80 (91.189.91.83), connection timed out" };
    if (h.clockSkew && h.clockSkew < -3600000) return { skew: true };
    return {};
  }
  CMDS.apt = CMDS["apt-get"] = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    const [verb, ...pkgs] = rest;
    const lock = ["E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)", "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?"];
    const read = ["Reading package lists... Done", "Building dependency tree... Done", "Reading state information... Done"];
    if (verb === "list") return ok(["Listing... Done", ...Object.entries(h.pkgs.installed).filter(([n]) => !pkgs.length || pkgs.some((p) => n.includes(p.replace("*", "")))).map(([n, v]) => `${n}/noble-updates,now ${v} amd64 [installed]`)]);
    if (verb === "policy" || c.name === "apt-cache") return ok(pkgs.flatMap((p) => [`${p}:`, `  Installed: ${h.pkgs.installed[p] || "(none)"}`, `  Candidate: ${(h.pkgs.repo[p] || {}).ver || "(none)"}`]));
    if (verb === "search") return ok(["Sorting... Done", "Full Text Search... Done", ...Object.keys(h.pkgs.repo).filter((n) => n.includes(pkgs[0] || "")).map((n) => `${n}/noble ${h.pkgs.repo[n].ver} amd64`)]);
    const holder = h.procs.find((p) => p.holdsDpkg);
    const busy = ["update", "install", "remove", "purge", "upgrade"].includes(verb) && c.user === "root";
    if (busy && h.dpkgBroken) return fail(["E: dpkg was interrupted, you must manually run 'sudo dpkg --configure -a' to correct the problem. "], 100);
    if (busy && holder && verb !== "update") {
      if (h.fs.has("/var/lib/dpkg/lock-frontend")) return fail([`E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process ${holder.pid} (${holder.comm})`, "N: Be aware that removing the lock file is not a solution and may break your system.", "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?"], 100);
      h.dpkgBroken = true;
      return fail([...read, `dpkg: error: dpkg database lock was locked by another process with pid ${holder.pid}`, "Note: removing the lock file is always wrong, can damage the locked area", "and the entire system. See <https://wiki.debian.org/Teams/Dpkg/FAQ#db-lock>.", "E: Sub-process /usr/bin/dpkg returned an error code (2)"], 100);
    }
    if (c.user !== "root") return fail(verb === "update" ? ["Reading package lists... Done", "E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)", "E: Unable to lock directory /var/lib/apt/lists/", "W: Problem unlinking the file /var/cache/apt/pkgcache.bin - RemoveCaches (13: Permission denied)"] : lock, 100);
    if (verb === "update") {
      const n = aptNet(h);
      const suites = ["noble", "noble-updates", "noble-backports", "noble-security"];
      if (n.err) return { out: [...suites.map((s, i) => `Err:${i + 1} http://archive.ubuntu.com/ubuntu ${s} InRelease\n  ${n.err}`.split("\n")).flat(), "Reading package lists... Done"], err: suites.map((s) => `W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/${s}/InRelease  ${n.err}`).concat("W: Some index files failed to download. They have been ignored, or old ones used instead."), code: 0 };
      if (n.skew) return { out: suites.map((s, i) => `Get:${i + 1} http://archive.ubuntu.com/ubuntu ${s} InRelease [126 kB]`).concat("Reading package lists... Done"), err: suites.map((s) => `E: Release file for http://archive.ubuntu.com/ubuntu/dists/${s}/InRelease is not valid yet (invalid for another 3d 2h 41min 7s). Updates for this repository will not be applied.`), code: 100 };
      h.pkgs.updated = true;
      return ok([...suites.map((s, i) => `Hit:${i + 1} http://archive.ubuntu.com/ubuntu ${s} InRelease`), ...read, "All packages are up to date."]);
    }
    if (verb === "install") {
      const out = [...read];
      const err = [];
      const add = [];
      for (const p of pkgs) {
        if (h.pkgs.installed[p]) { out.push(`${p} is already the newest version (${h.pkgs.installed[p]}).`); continue; }
        if (!h.pkgs.repo[p]) { err.push(`E: Unable to locate package ${p}`); continue; }
        add.push(p);
      }
      if (err.length) return { out, err, code: 100 };
      if (!add.length) return ok([...out, "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."]);
      const n = aptNet(h);
      if (n.err) return { out: [...out, "The following NEW packages will be installed:", "  " + add.join(" ")], err: add.map((p) => `E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/main/${p[0]}/${p}/${p}_${h.pkgs.repo[p].ver}_amd64.deb  ${n.err}`).concat("E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?"), code: 100 };
      out.push("The following NEW packages will be installed:", "  " + add.join(" "), `0 upgraded, ${add.length} newly installed, 0 to remove and 0 not upgraded.`);
      if (!f.y && !f.yes) out.push("After this operation, 1,214 kB of additional disk space will be used.", "Do you want to continue? [Y/n] Y");
      for (const p of add) {
        const pk = h.pkgs.repo[p];
        out.push(`Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${p} amd64 ${pk.ver} [${pk.kb || 120} kB]`, `Selecting previously unselected package ${p}.`, `Unpacking ${p} (${pk.ver}) ...`, `Setting up ${p} (${pk.ver}) ...`);
        h.pkgs.installed[p] = pk.ver;
        for (const b of pk.bins || []) h.bin(b);
        if (pk.install) out.push(...(pk.install(h) || []));
      }
      out.push("Processing triggers for man-db (2.12.0-4build2) ...");
      return ok(out);
    }
    if (verb === "remove" || verb === "purge") {
      const out = [...read];
      for (const p of pkgs) {
        if (!h.pkgs.installed[p]) { out.push(`Package '${p}' is not installed, so not removed`); continue; }
        out.push("The following packages will be REMOVED:", `  ${p}${verb === "purge" ? "*" : ""}`, "0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.", `Removing ${p} (${h.pkgs.installed[p]}) ...`);
        delete h.pkgs.installed[p];
        const pk = h.pkgs.repo[p] || {};
        if (pk.remove) pk.remove(h);
        for (const b of pk.bins || []) h.fs.delete(b);
      }
      return ok(out);
    }
    if (verb === "upgrade") return ok([...read, "Calculating upgrade... Done", "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."]);
    return fail(`E: Invalid operation ${verb}`, 100);
  };
  CMDS["apt-cache"] = (c, args) => CMDS.apt(c, args);
  CMDS.dpkg = (c, args) => {
    const h = c.h;
    if (args[0] === "-l") {
      const want = args.slice(1);
      const rows = Object.entries(h.pkgs.installed).filter(([n]) => !want.length || want.includes(n)).map(([n, v]) => `ii  ${n.padEnd(22)} ${v.padEnd(28)} amd64        ${(h.pkgs.repo[n] || {}).desc || n}`);
      if (want.length && !rows.length) return fail(`dpkg-query: no packages found matching ${want[0]}`);
      return ok(["Desired=Unknown/Install/Remove/Purge/Hold", "| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend", "|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)", "||/ Name                   Version                      Architecture Description", "+++-======================-============================-============-=================================", ...rows]);
    }
    if (args[0] === "--configure") {
      if (c.user !== "root") return fail("dpkg: error: requested operation requires superuser privilege", 2);
      const holder = h.procs.find((p) => p.holdsDpkg);
      if (holder) return fail([`dpkg: error: dpkg frontend lock was locked by another process with pid ${holder.pid}`, "Note: removing the lock file is always wrong, can damage the locked area", "and the entire system. See <https://wiki.debian.org/Teams/Dpkg/FAQ#db-lock>."], 2);
      const was = h.dpkgBroken;
      h.dpkgBroken = false;
      if (!h.fs.has("/var/lib/dpkg/lock-frontend")) h.file("/var/lib/dpkg/lock-frontend", "", { m: 0o640 });
      return ok(was ? ["Setting up libssl3t64:amd64 (3.0.13-0ubuntu3.4) ...", "Processing triggers for libc-bin (2.39-0ubuntu8.3) ..."] : []);
    }
    if (args[0] === "-S") { const p = Object.entries(h.pkgs.repo).find(([, v]) => (v.bins || []).includes(args[1])); return p ? ok([`${p[0]}: ${args[1]}`]) : fail(`dpkg-query: no path found matching pattern ${args[1]}`); }
    return fail("dpkg: error: need an action option", 2);
  };
  // Ubuntu's command-not-found answer for tools that a package provides.
  L.notInstalled = (name) => {
    const h = L.current;
    if (!h) return null;
    const pkg = Object.entries(h.pkgs.repo).find(([n, v]) => !h.pkgs.installed[n] && (v.bins || []).some((b) => basename(b) === name));
    const extra = { dnf: "dnf", yum: "yum", ifconfig: "net-tools", netstat: "net-tools" }[name];
    if (!pkg && !extra) return null;
    return [`Command '${name}' not found, but can be installed with:`, "", `sudo apt install ${pkg ? pkg[0] : extra}`];
  };

  // --- cron ----------------------------------------------------------------------------------

  function cronField(spec, v, lo, hi) {
    return spec.split(",").some((part) => {
      const [range, step] = part.split("/");
      const [a, b] = range === "*" ? [lo, hi] : range.split("-").map(Number);
      const end = range === "*" || range.includes("-") ? b : step ? hi : a;
      return v >= a && v <= end && (v - a) % Number(step || 1) === 0;
    });
  }
  const cronValid = (f) => f.length === 5 && f.every((x) => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(x));
  // Read every crontab cron would load: [{file, user, sched, cmd, env}] and errors.
  function crontabs(h) {
    const jobs = [], errors = [];
    const read = (path, owner, system) => {
      const text = h.read(path);
      if (text == null) return;
      const env = {};
      const tag = system ? `*system*${basename(path) === "crontab" ? "" : basename(path)}` : owner;
      for (const raw of lines(text)) {
        const l = raw.trim();
        if (!l || l.startsWith("#")) continue;
        const e = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l);
        if (e) { env[e[1]] = e[2].replace(/^"(.*)"$/, "$1"); continue; }
        const f = l.split(/\s+/);
        const sched = l.startsWith("@") ? [{ "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@reboot": "@reboot" }[f[0]] || "x"] : f.slice(0, 5);
        const at = l.startsWith("@") ? 1 : 5;
        const user = system ? f[at] : owner;
        if (!cronValid(sched.join(" ").split(" ")) || (system && !h.user(user))) {
          if (system && cronValid(sched.join(" ").split(" "))) errors.push({ tag, path, msg: "Error: bad username; while reading " + path });
          errors.push({ tag, path, msg: `(${tag}) ERROR (Syntax error, this crontab file will be ignored)` });
          return;
        }
        jobs.push({ path, tag, user, sched: sched.join(" "), cmd: f.slice(at + (system ? 1 : 0)).join(" "), env: { ...env } });
      }
    };
    read("/etc/crontab", "root", true);
    for (const k of h.kids("/etc/cron.d")) if (!/[.~]/.test(k)) read(`/etc/cron.d/${k}`, "root", true);
    for (const k of h.kids("/var/spool/cron/crontabs")) read(`/var/spool/cron/crontabs/${k}`, k, false);
    return { jobs, errors };
  }
  // Run the jobs due in each minute that passed. Jobs run as their user, from
  // their home, with cron's own small environment.
  function cronTick(h, from, to) {
    if (!isUp(h, "cron.service") || h.inCron) return;
    const { jobs } = crontabs(h);
    h.inCron = true;
    for (let t = Math.floor(from / 60000) * 60000 + 60000; t <= to && t - from < 3700000; t += 60000) {
      const dt = new Date(t);
      for (const j of jobs) {
        const [mi, hr, dom, mon, dow] = j.sched.split(" ");
        if (!(cronField(mi, dt.getUTCMinutes(), 0, 59) && cronField(hr, dt.getUTCHours(), 0, 23) && cronField(dom, dt.getUTCDate(), 1, 31) && cronField(mon, dt.getUTCMonth() + 1, 1, 12) && cronField(dow, dt.getUTCDay(), 0, 6))) continue;
        const pid = h.nextPid++;
        const u = h.user(j.user);
        h.log("CRON", `(${j.user}) CMD (${j.cmd})`, { pid, unit: "cron.service", t });
        const saved = h.clock;
        h.clock = t;
        const term = [];
        const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", HOME: u.home, LOGNAME: j.user, ...j.env };
        L.runLine(h, j.cmd, term, { h, user: j.user, env, cwd: u.home, umask: 0o022, args: [], script: "/bin/sh", line: 1, cron: true, own: { cwd: u.home } });
        h.clock = saved;
        const printed = term.length || h.status !== 0;
        j.last = { t, ok: h.status === 0, out: term.map(([x]) => x) };
        h.cronRuns = (h.cronRuns || []).concat({ ...j.last, tag: j.tag, cmd: j.cmd, user: j.user });
        if (printed && term.length) h.log("CRON", `(CRON) info (No MTA installed, discarding output)`, { pid, unit: "cron.service", t });
      }
    }
    h.inCron = false;
  }
  CMDS.crontab = (c, args, stdin) => {
    const h = c.h;
    const { f, rest } = opts(args, "u");
    const who = f.u || c.user;
    if (f.u && c.user !== "root") return fail(`must be privileged to use -u`);
    const path = `/var/spool/cron/crontabs/${who}`;
    if (f.l) { const t = h.read(path); return t == null ? fail(`no crontab for ${who}`) : ok(lines(t)); }
    if (f.r) { if (!h.fs.has(path)) return fail(`no crontab for ${who}`); h.fs.delete(path); return ok(); }
    const install = (text) => {
      if (text && !text.endsWith("\n")) return fail(["new crontab file is missing newline before EOF, can't install."], 1);
      const bad = lines(text).map((l, i) => [l.trim(), i]).find(([l]) => l && !l.startsWith("#") && !/^[A-Za-z_]\w*\s*=/.test(l) && !l.startsWith("@") && !cronValid(l.split(/\s+/).slice(0, 5)));
      if (bad) return fail([`"-":${bad[1] + 1}: bad minute`, "errors in crontab file, can't install."], 1);
      h.file(path, text, { u: who, g: "crontab", m: 0o600, mt: h.clock });
      return ok();
    };
    if (f.e) {
      const editor = c.env.VISUAL || c.env.EDITOR;
      const tmp = `/tmp/crontab.Xq81Zd/crontab`;
      if (!editor || /^(vi|vim|nano|editor|emacs)$/.test(basename(editor.split(" ")[0]))) {
        return { out: h.read(path) == null ? [`no crontab for ${who} - using an empty one`] : [], err: [], code: 1, notes: ["(crontab -e opens an editor, which this playground does not have. Do the same edit with a script:", "  crontab -l > /tmp/my.cron        # save the current crontab", "  echo '*/5 * * * * /usr/local/bin/job.sh' >> /tmp/my.cron", "  crontab /tmp/my.cron             # install it", "or let crontab -e run a sed script as its editor: EDITOR=\"sed -i 's/old/new/'\" crontab -e)"] };
      }
      const before = h.read(path) || "";
      h.dir(dirname(tmp), { u: c.user, g: c.user, m: 0o700 });
      h.file(tmp, before, { u: c.user, g: c.user, m: 0o600 });
      const term = [];
      L.runLine(h, `${editor} ${tmp}`, term, { ...c, args: [] });
      const after = h.read(tmp) || "";
      h.fs.delete(tmp);
      h.fs.delete(dirname(tmp));
      const said = term.map(([x]) => x);
      if (after === before) return { out: [], err: [...said, "crontab: no changes made to crontab"], code: 0 };
      const res = install(after);
      return res.code ? res : { out: [], err: [...said, "crontab: installing new crontab"], code: 0 };
    }
    const src = rest[0];
    if (src === "-" || (!src && stdin)) {
      const text = (stdin || []).join("\n") + (stdin && stdin.noNewline ? "" : "\n");
      return install(stdin && stdin.length ? text : "");
    }
    if (src) {
      const r = h.lookup(norm(src, c.cwd), c.user);
      if (r.err) return fail(`${src}: ${ERR[r.err]}`);
      return install(r.node.data || "");
    }
    return fail(["crontab: usage error: file name or - (for stdin) must be specified", "Usage:", " crontab [options] file", " crontab [options]", " crontab -n [hostname]"]);
  };

  // --- time, sysctl, reboot ----------------------------------------------------------------------

  CMDS.timedatectl = (c, args) => {
    const h = c.h;
    if (args[0] === "set-ntp") {
      if (c.user !== "root") return fail("Failed to set ntp: Access denied");
      const on = /^(true|yes|1|on)$/.test(args[1] || "");
      if (!unitFile(h, "systemd-timesyncd.service")) return fail("Failed to set ntp: NTP not supported");
      if (on) { CMDS.systemctl({ ...c, user: "root" }, ["enable", "--now", "systemd-timesyncd"]); } else CMDS.systemctl({ ...c, user: "root" }, ["disable", "--now", "systemd-timesyncd"]);
      return ok();
    }
    if (args[0] === "set-timezone") return c.user === "root" ? ok() : fail("Failed to set time zone: Access denied");
    if (args[0] === "timesync-status" || args[0] === "show-timesync") return ok(isUp(h, "systemd-timesyncd.service") ? ["       Server: 169.254.169.123 (169.254.169.123)", "Poll interval: 34min 8s (min: 32s; max 34min 8s)", "         Leap: normal", "      Version: 4", "       Offset: +312us"] : ["Failed to query server: Could not activate remote peer: unit is masked."].slice(0, 0));
    const synced = isUp(h, "systemd-timesyncd.service") && !h.clockSkew;
    return ok([`               Local time: ${longDate(h.clock)} UTC`, `           Universal time: ${longDate(h.clock)} UTC`, `                 RTC time: ${longDate(h.clock).slice(4)}`, "                Time zone: Etc/UTC (UTC, +0000)",
      `System clock synchronized: ${synced ? "yes" : "no"}`, `              NTP service: ${isUp(h, "systemd-timesyncd.service") ? "active" : "inactive"}`, "          RTC in local TZ: no"]);
  };
  function applySysctlFiles(h) {
    const applied = [];
    const files = ["/etc/sysctl.conf", ...h.kids("/etc/sysctl.d").filter((k) => k.endsWith(".conf")).map((k) => `/etc/sysctl.d/${k}`)];
    for (const p of files) {
      const t = h.read(p);
      if (t == null) continue;
      applied.push(`* Applying ${p} ...`);
      for (const l of lines(t)) {
        const m = /^\s*([\w.]+)\s*=\s*(\S+)\s*$/.exec(l);
        if (m && !l.trim().startsWith("#")) { h.sysctl[m[1]] = m[2]; applied.push(`${m[1]} = ${m[2]}`); }
      }
    }
    return applied;
  }
  CMDS.sysctl = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "p");
    if (f.a) return ok(Object.entries(h.sysctl).map(([k, v]) => `${k} = ${v}`));
    if (f.system) { if (c.user !== "root") return fail("sysctl: permission denied on key \"net.ipv4.ip_forward\""); return ok(applySysctlFiles(h)); }
    if (f.p !== undefined) {
      if (c.user !== "root") return fail("sysctl: permission denied on key \"net.ipv4.ip_forward\"");
      const p = f.p === true ? "/etc/sysctl.conf" : f.p;
      const t = h.read(p);
      if (t == null) return fail(`sysctl: cannot open "${p}": No such file or directory`);
      const out = [];
      for (const l of lines(t)) { const m = /^\s*([\w.]+)\s*=\s*(\S+)/.exec(l); if (m) { h.sysctl[m[1]] = m[2]; out.push(`${m[1]} = ${m[2]}`); } }
      return ok(out);
    }
    const out = [], err = [];
    for (const a of rest) {
      const [k, v] = a.split("=");
      if (!(k in h.sysctl)) { err.push(`sysctl: cannot stat /proc/sys/${k.replace(/\./g, "/")}: No such file or directory`); continue; }
      if (v == null) { out.push(f.n ? h.sysctl[k] : `${k} = ${h.sysctl[k]}`); continue; }
      if (c.user !== "root") { err.push(`sysctl: permission denied on key "${k}"`); continue; }
      h.sysctl[k] = v;
      out.push(`${k} = ${v}`);
    }
    return { out, err, code: err.length ? 1 : 0 };
  };
  CMDS.reboot = CMDS.shutdown = (c, args) => {
    if (c.user !== "root") return fail(["Call to Reboot failed: Access denied"], 1);
    if (c.name === "shutdown" && !args.includes("-r")) return fail("(the playground will not power off its only server; try: sudo reboot)");
    c.h.rebooting = true;
    return ok();
  };

  // --- hooks the core calls --------------------------------------------------------------------

  L.builtin = builtin;
  L.procfs = procfs;
  L.onTick = (h, sec) => {
    const from = h.clock - sec * 1000;
    if (h.everyTick) h.everyTick(h, sec);
    cronTick(h, from, h.clock);
  };
  L.onWrite = (h, path) => { if (h.onWrite) h.onWrite(h, path); };
  L.onClockSet = (h) => { h.clockSkew = 0; };

  Object.assign(L, { spawn, signal, die, procOf, statOf, cpuStats, memStats, start, stop, bootUp, reboot, state, isUp, enabledState, cfgOf, unitFile, parseUnit, changedOnDisk,
    resolve, dns, routeTo, inbound, listener, http, sudoers, sudoAllowed, sshdAccepts, keyProblem, crontabs, cronTick, fstab, findDev, doMount, mountFstab, applySysctlFiles, ago, upFor, unitName });
})(typeof window !== "undefined" ? window : globalThis);
