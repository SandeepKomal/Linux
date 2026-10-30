// Linux Quest simulator, part 1: the modelled host (files, users, sessions)
// and a small bash: quoting, variables, globs, pipes, redirects, && and ||,
// scripts with a shebang, and the file and text commands.
//
// Nothing here touches the DOM, so tests/ can drive it under Node. Every
// error message is the one the real tool prints.
"use strict";

(function (root) {
  const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const d = (ms) => new Date(ms);
  const hms = (ms) => `${pad(d(ms).getUTCHours())}:${pad(d(ms).getUTCMinutes())}:${pad(d(ms).getUTCSeconds())}`;
  const stamp = (ms) => `${MON[d(ms).getUTCMonth()]} ${pad(d(ms).getUTCDate())} ${hms(ms)}`;
  const isoDay = (ms) => `${d(ms).getUTCFullYear()}-${pad(d(ms).getUTCMonth() + 1)}-${pad(d(ms).getUTCDate())}`;
  const longDate = (ms) => `${DAY[d(ms).getUTCDay()]} ${isoDay(ms)} ${hms(ms)}`;
  // ls shows the time for files from the last six months, the year otherwise.
  const lsTime = (ms, now) => `${MON[d(ms).getUTCMonth()]} ${String(d(ms).getUTCDate()).padStart(2)} ` +
    (now - ms < 182 * 86400000 && ms <= now + 3600000 ? hms(ms).slice(0, 5) : " " + d(ms).getUTCFullYear());

  // GNU -h sizes: one decimal below 10, rounded up.
  function human(bytes) {
    if (bytes < 1024) return String(Math.max(0, Math.round(bytes)));
    let v = bytes, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < 4);
    const r = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v);
    return (r < 10 ? r.toFixed(1) : String(r >= 1024 ? 1024 : r)) + "KMGTP"[i];
  }
  function parseSize(s) {
    const m = /^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i.exec(String(s));
    return m ? Math.round(Number(m[1]) * { "": 1, K: KiB, M: MiB, G: GiB, T: GiB * 1024 }[m[2].toUpperCase()]) : null;
  }

  const ERR = {
    ENOENT: "No such file or directory", EACCES: "Permission denied", ENOTDIR: "Not a directory", EISDIR: "Is a directory",
    EROFS: "Read-only file system", ENOSPC: "No space left on device", EPERM: "Operation not permitted", ELOOP: "Too many levels of symbolic links",
    EEXIST: "File exists", ENOTEMPTY: "Directory not empty", EBUSY: "Device or resource busy", E2BIG: "Argument list too long", ESTALE: "Stale file handle",
    // A hard NFS mount whose server is gone never answers; shell() reports the hang.
    EHUNG: "\u0000hung"
  };

  function norm(p, cwd) {
    const parts = [];
    for (const x of (p.startsWith("/") ? p : `${cwd}/${p}`).split("/")) {
      if (!x || x === ".") continue;
      if (x === "..") parts.pop(); else parts.push(x);
    }
    return "/" + parts.join("/");
  }
  const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
  const basename = (p) => p.replace(/\/+$/, "").replace(/^.*\//, "") || "/";
  const globRe = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

  function modeStr(n) {
    const t = { d: "d", l: "l", c: "c" }[n.t] || "-";
    const m = n.m;
    const r = (b, ch) => (m & b ? ch : "-");
    const x = (b, sp, on, off) => (m & sp ? (m & b ? on : off) : r(b, "x"));
    return t + r(0o400, "r") + r(0o200, "w") + x(0o100, 0o4000, "s", "S") + r(0o40, "r") + r(0o20, "w") + x(0o10, 0o2000, "s", "S") +
      r(0o4, "r") + r(0o2, "w") + x(0o1, 0o1000, "t", "T");
  }
  // chmod modes: octal, or symbolic like u+x, go-w, a=r, +x, u=rwX.
  function parseMode(spec, old, isDir, umask) {
    if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8) | (isDir && spec.length < 4 ? old & 0o6000 : 0);
    let m = old;
    for (const clause of spec.split(",")) {
      const c = /^([ugoa]*)([+=-])([rwxXst]*)$/.exec(clause);
      if (!c) return null;
      const who = c[1] || "a";
      let bits = 0;
      for (const p of c[3]) {
        const b = p === "r" ? 4 : p === "w" ? 2 : p === "x" || (p === "X" && (isDir || old & 0o111)) ? 1 : 0;
        for (const [w, sh] of [["u", 6], ["g", 3], ["o", 0]]) if (who.includes(w) || who.includes("a")) bits |= b << sh;
        if (p === "s") bits |= (who.includes("u") || who.includes("a") ? 0o4000 : 0) | (who.includes("g") || who.includes("a") ? 0o2000 : 0);
        if (p === "t") bits |= 0o1000;
      }
      // With no who, + and = respect the umask, as GNU chmod does.
      if (!c[1]) bits &= ~umask;
      const mask = (who.includes("u") || who.includes("a") ? 0o4700 : 0) | (who.includes("g") || who.includes("a") ? 0o2070 : 0) |
        (who.includes("o") || who.includes("a") ? 0o1007 : 0);
      m = c[2] === "+" ? m | bits : c[2] === "-" ? m & ~bits : (m & ~mask) | bits;
    }
    return m;
  }

  const ELF = "\u007fELF";
  const ok = (out = [], code = 0) => ({ out, err: [], code });
  const fail = (err, code = 1, out = []) => ({ out, err: [].concat(err), code });
  const lines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

  // --- the host ----------------------------------------------------------------

  class Host {
    constructor(scenario) {
      this.scenario = scenario;
      this.fs = new Map();
      this.clock = scenario.clock || Date.UTC(2026, 9, 30, 9, 14, 0);
      this.boot = this.clock - (scenario.uptime || 12 * 86400000 + 3 * 3600000 + 41 * 60000);
      this.procs = [];
      this.nextPid = 4200;
      this.units = {};
      this.loaded = {};
      this.apps = {};
      this.tools = {};
      this.journal = [];
      this.kmsg = [];
      this.mounts = [];
      this.disks = [];
      this.status = 0;
      this.boots = 0;
      this.history = [];
      root.LQSim.current = this;
      root.LQSim.world(this);
      if (scenario.setup) scenario.setup(this);
      root.LQSim.bootUp(this, true);
      if (scenario.after) scenario.after(this);
      this.sess = this.newSession(scenario.user || this.defaultUser);
    }

    newSession(user) {
      const u = this.user(user);
      const env = {
        PATH: user === "root" ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
          : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin",
        HOME: u.home, USER: user, LOGNAME: user, SHELL: u.shell, LANG: "C.UTF-8", TERM: "xterm-256color", PWD: u.home
      };
      // A login shell also picks up the exports in the user's startup files.
      for (const f of [`${u.home}/.profile`, `${u.home}/.bashrc`, `${u.home}/.bash_profile`]) {
        for (const m of (this.read(f) || "").matchAll(/^\s*export\s+([A-Za-z_]\w*)=["']?([^"'\n]*)["']?\s*$/gm)) env[m[1]] = m[2];
      }
      return { user, cwd: u.home, env, umask: this.profileUmask(user), nofile: 1024, outer: null, groups: this.groupsOf(user) };
    }
    // A login shell reads the umask from the user's profile, or 002 (022 for root).
    profileUmask(user) {
      const u = this.user(user);
      for (const f of ["/etc/profile", `${u.home}/.profile`, `${u.home}/.bashrc`]) {
        const m = /^\s*umask\s+([0-7]{3,4})\s*$/m.exec(this.read(f) || "");
        if (m) return parseInt(m[1], 8);
      }
      return user === "root" ? 0o022 : 0o002;
    }
    tick(sec) {
      this.clock += sec * 1000;
      if (root.LQSim.onTick) root.LQSim.onTick(this, sec);
    }

    // Files. Nodes: {t: f|d|l|c, u, g, m, data, size, to, imm, mt}.
    put(path, node) {
      const p = norm(path, "/");
      if (p !== "/" && !this.fs.has(dirname(p))) this.put(dirname(p), { t: "d", u: "root", g: "root", m: 0o755 });
      this.fs.set(p, { u: "root", g: "root", mt: this.clock - 30 * 86400000, ...node });
      return this.fs.get(p);
    }
    file(path, data = "", o = {}) { return this.put(path, { t: "f", m: 0o644, data, ...o }); }
    dir(path, o = {}) { return this.put(path, { t: "d", m: 0o755, ...o }); }
    link(path, to, o = {}) { return this.put(path, { t: "l", m: 0o777, to, ...o }); }
    bin(path, o = {}) { return this.put(path, { t: "f", m: 0o755, data: ELF, size: 142000, ...o }); }
    read(path) {
      const r = this.lookup(path, "root");
      if (r.err || r.node.t !== "f") return null;
      return r.node.gen ? r.node.gen(this).join("\n") + "\n" : r.node.data;
    }
    sizeOf(n) { return n.t === "d" ? 4096 : n.t === "l" ? n.to.length : n.size != null ? n.size : (n.gen ? n.gen(this).join("\n").length + 1 : n.data.length); }
    kids(path) {
      const pre = path === "/" ? "/" : path + "/";
      const out = [];
      for (const k of this.fs.keys()) if (k.startsWith(pre) && k !== "/" && !k.slice(pre.length).includes("/")) out.push(k.slice(pre.length));
      return out.sort();
    }
    walk(path) {
      const pre = path === "/" ? "/" : path + "/";
      return [...this.fs.keys()].filter((k) => k.startsWith(pre) && k !== path);
    }

    // Resolve a path for a user: search permission on each directory,
    // symlinks followed (the last one only when follow is true).
    lookup(path, user, follow = true, depth = 0) {
      if (path.startsWith("/proc/") || path === "/proc") return root.LQSim.procfs(this, path, user);
      const nfs = this.hasNfs && this.mountOf(path);
      if (nfs && nfs.nfs && (nfs.stale || nfs.hung)) { if (nfs.hung) this.hungHit = nfs; return { err: nfs.stale ? "ESTALE" : "EHUNG" }; }
      const parts = path.split("/").filter(Boolean);
      let cur = "";
      for (let i = 0; i < parts.length; i++) {
        const dir = this.fs.get(cur || "/");
        if (user !== "root" && dir && !this.can(user, dir, 1)) return { err: "EACCES" };
        const next = cur + "/" + parts[i];
        const n = this.fs.get(next);
        if (!n) return { err: "ENOENT", parent: i === parts.length - 1 ? cur || "/" : null };
        if (n.t === "l" && (i < parts.length - 1 || follow)) {
          if (depth > 8) return { err: "ELOOP" };
          const target = norm(n.to, cur || "/") + "/" + parts.slice(i + 1).join("/");
          return this.lookup(norm(target, "/"), user, follow, depth + 1);
        }
        if (i < parts.length - 1 && n.t !== "d") return { err: "ENOTDIR" };
        cur = next;
      }
      return { path: cur || "/", node: this.fs.get(cur || "/") };
    }
    // bit: 4 read, 2 write, 1 execute/search.
    can(user, n, bit) {
      if (user === "root") return bit !== 1 || n.t === "d" || (n.m & 0o111) !== 0;
      if (n.u === user) return ((n.m >> 6) & bit) !== 0;
      if (this.groupsOf(user).includes(n.g)) return ((n.m >> 3) & bit) !== 0;
      return (n.m & bit) !== 0;
    }
    mountOf(path) {
      return this.mounts.filter((m) => !m.gone && (path === m.mnt || path.startsWith(m.mnt === "/" ? "/" : m.mnt + "/")))
        .sort((a, b) => b.mnt.length - a.mnt.length)[0];
    }
    // Bytes in use on a mount: files under it plus what it holds that the
    // tree does not show (system files, deleted files a process keeps open).
    usage(m) {
      let bytes = m.base || 0, inodes = m.ibase || 0;
      for (const [p, n] of this.fs) {
        if (this.mountOf(p) !== m) continue;
        inodes += n.bulk ? n.bulk.n + 1 : 1;
        if (n.t === "f") bytes += Math.ceil(this.sizeOf(n) / 4096) * 4096;
        if (n.bulk) bytes += n.bulk.n * 4096;
      }
      for (const pr of this.procs) for (const f of pr.fds || []) if (f.deleted && f.mount === m.mnt) bytes += f.size;
      return { bytes, inodes };
    }
    // Can a write of `grow` bytes (and maybe a new inode) land at path?
    // ext4 keeps 5% of the blocks for root.
    writable(path, grow, newInode, user = "root") {
      const m = this.mountOf(path);
      if (!m) return null;
      if (m.ro) return "EROFS";
      const u = this.usage(m);
      const room = m.size * (user === "root" || m.type !== "ext4" ? 1 : 0.95);
      if (grow > 0 && u.bytes + grow > room) return "ENOSPC";
      if (newInode && m.inodes && u.inodes >= m.inodes) return "ENOSPC";
      return null;
    }
    // Write a file as a user, creating it with the umask. Returns an error code or null.
    writeFile(path, data, user, append, umask = 0o022) {
      const r = this.lookup(path, user);
      if (r.err === "ENOENT" && r.parent !== null) {
        const parent = this.lookup(dirname(path), user);
        if (parent.err) return parent.err;
        if (parent.node.t !== "d") return "ENOTDIR";
        // A read-only mount refuses before permissions are checked.
        if ((this.mountOf(parent.path) || {}).ro) return "EROFS";
        if (!this.can(user, parent.node, 2)) return "EACCES";
        if (parent.node.imm) return "EPERM";
        const target = parent.path === "/" ? "/" + basename(path) : parent.path + "/" + basename(path);
        const e = this.writable(target, Math.max(1, data.length), true, user);
        if (e) return e;
        const sg = parent.node.m & 0o2000;
        this.fs.set(target, { t: "f", u: user, g: sg ? parent.node.g : this.primaryGroup(user), m: 0o666 & ~umask, data, mt: this.clock });
        return null;
      }
      if (r.err) return r.err;
      const n = r.node;
      if (n.t === "d") return "EISDIR";
      if (n.virtual) return n.write ? n.write(data, user) : "EACCES";
      if (n.t === "c") return null;
      if (!this.can(user, n, 2)) return "EACCES";
      if (n.imm) return "EPERM";
      const before = this.sizeOf(n);
      const next = append ? (n.gen ? n.gen(this).join("\n") + "\n" : n.data) + data : data;
      const e = this.writable(r.path, next.length - before, false, user);
      if (e) return e;
      delete n.gen;
      delete n.size;
      n.data = next;
      n.mt = this.clock;
      if (root.LQSim.onWrite) root.LQSim.onWrite(this, r.path);
      return null;
    }

    // Users and groups come from /etc/passwd and /etc/group, so editing those
    // files (or useradd and usermod) is all there is.
    users() {
      return lines(this.read("/etc/passwd") || "").map((l) => l.split(":")).filter((f) => f.length >= 7)
        .map(([name, , uid, gid, gecos, home, shell]) => ({ name, uid: Number(uid), gid: Number(gid), gecos, home, shell }));
    }
    groups() {
      return lines(this.read("/etc/group") || "").map((l) => l.split(":")).filter((f) => f.length >= 4)
        .map(([name, , gid, members]) => ({ name, gid: Number(gid), members: members ? members.split(",") : [] }));
    }
    user(name) { return this.users().find((u) => u.name === name); }
    primaryGroup(name) {
      const u = this.user(name);
      const g = u && this.groups().find((x) => x.gid === u.gid);
      return g ? g.name : u ? String(u.gid) : name;
    }
    groupsOf(name) { return [this.primaryGroup(name), ...this.groups().filter((g) => g.members.includes(name)).map((g) => g.name)]; }

    log(ident, msg, o = {}) {
      this.journal.push({ t: o.t || this.clock, ident, pid: o.pid, msg, unit: o.unit, prio: o.prio == null ? 6 : o.prio, boot: this.boots });
    }
    dmesg(msg, t) { this.kmsg.push({ t: t == null ? this.clock : t, msg, boot: this.boots }); }
  }

  // --- the shell ---------------------------------------------------------------

  const OPS = ["2>&1", "2>>", "&>", ">&2", "&&", "||", ">>", "2>", "|", ";", "&", ">", "<"];

  // Words are lists of segments: u (unquoted), d (double quotes), s (single).
  function lex(line) {
    const toks = [];
    let word = null, i = 0;
    const add = (text, q) => { (word = word || []).push({ text, q }); };
    const end = () => { if (word) toks.push({ w: word }); word = null; };
    while (i < line.length) {
      const c = line[i];
      if (c === " " || c === "\t") { end(); i++; continue; }
      if (c === "#" && !word) break;
      // ( list ) runs a group of commands as one, so its output can be piped.
      if (c === "(" && !word) {
        let depth = 0, k = i, q = null;
        for (; k < line.length; k++) {
          const ch = line[k];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === "'" || ch === '"') q = ch;
          else if (ch === "(") depth++;
          else if (ch === ")" && --depth === 0) break;
        }
        if (k >= line.length) return { error: "unexpected EOF while looking for matching `)'" };
        toks.push({ w: [{ text: line.slice(i + 1, k), q: "group" }] });
        i = k + 1;
        continue;
      }
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) return { error: "unexpected EOF while looking for matching `''" };
        add(line.slice(i + 1, j), "s");
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1, s = "";
        while (j < line.length && line[j] !== '"') {
          if (line[j] === "\\" && '"\\$`'.includes(line[j + 1] || "")) { s += "\\" + line[j + 1]; j += 2; } else s += line[j++];
        }
        if (j >= line.length) return { error: "unexpected EOF while looking for matching `\"'" };
        add(s, "d");
        i = j + 1;
        continue;
      }
      if (c === "\\") { add(line[i + 1] || "", "s"); i += 2; continue; }
      const op = !word || !/^2/.test(OPS.find((o) => line.startsWith(o, i)) || "") ? OPS.find((o) => line.startsWith(o, i)) : null;
      if (op && !(op.startsWith("2") && word)) { end(); toks.push({ op }); i += op.length; continue; }
      let j = i, s = "";
      while (j < line.length && !" \t'\"\\|&;<>".includes(line[j])) {
        if (line[j] === "$" && line[j + 1] === "(") {
          let depth = 0, k = j + 1;
          for (; k < line.length; k++) { if (line[k] === "(") depth++; else if (line[k] === ")" && --depth === 0) break; }
          if (k >= line.length) return { error: "unexpected EOF while looking for matching `)'" };
          s += line.slice(j, k + 1);
          j = k + 1;
        } else s += line[j++];
      }
      add(s, "u");
      i = j;
    }
    end();
    return { toks };
  }

  // [{op, pipe: [{words, redirs}]}]; op is how it joins the previous item.
  function parse(line) {
    const lx = lex(line);
    if (lx.error) return lx;
    const items = [];
    let pipe = [], cmd = { words: [], redirs: [] }, join = ";";
    const unexpected = (t) => ({ error: `syntax error near unexpected token \`${t}'` });
    const toks = lx.toks;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.w) { cmd.words.push(t.w); continue; }
      if (/^(>|>>|<|2>|2>>|&>)$/.test(t.op)) {
        const target = toks[i + 1];
        if (!target || !target.w) return unexpected(target ? target.op : "newline");
        cmd.redirs.push({ op: t.op, target: target.w });
        i++;
        continue;
      }
      if (t.op === "2>&1" || t.op === ">&2") { cmd.redirs.push({ op: t.op }); continue; }
      if (!cmd.words.length && !cmd.redirs.length) return unexpected(t.op);
      pipe.push(cmd);
      cmd = { words: [], redirs: [] };
      if (t.op === "|") continue;
      items.push({ op: join, pipe });
      pipe = [];
      join = t.op === "&" ? ";" : t.op;
    }
    if (cmd.words.length || cmd.redirs.length) pipe.push(cmd);
    else if (pipe.length) return unexpected("newline");
    if (pipe.length) items.push({ op: join, pipe });
    else if (join === "&&" || join === "||") return unexpected("newline");
    return { items };
  }

  // $VAR, ${VAR}, $?, $1 and $(command) inside unquoted and double-quoted text.
  function expandVars(text, c) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) { out += text[++i]; continue; }
      if (ch !== "$") { out += ch; continue; }
      if (text[i + 1] === "(") {
        let depth = 0, k = i + 1;
        for (; k < text.length; k++) { if (text[k] === "(") depth++; else if (text[k] === ")" && --depth === 0) break; }
        out += capture(c, text.slice(i + 2, k)).replace(/\n+$/, "");
        i = k;
        continue;
      }
      const m = /^\{([^}]*)\}|^([A-Za-z_][A-Za-z0-9_]*|[?$#0-9])/.exec(text.slice(i + 1));
      if (!m) { out += ch; continue; }
      const name = m[1] || m[2];
      out += name === "?" ? String(c.h.status) : name === "$" ? "4093" : name === "#" ? String((c.args || []).length)
        : /^\d$/.test(name) ? (name === "0" ? c.script || "-bash" : (c.args || [])[Number(name) - 1] || "") : (c.env[name] ?? "");
      i += m[0].length;
    }
    return out;
  }
  // Expand a word into zero or more arguments: tilde, variables, globs.
  function expandWord(segs, c) {
    let text = "", glob = false, quoted = false;
    segs.forEach((sg, i) => {
      if (sg.q === "s") { text += sg.text; quoted = true; return; }
      let t = sg.q === "d" ? expandVars(sg.text.replace(/\\(?=[^"\\$`])/g, "\\\\"), c) : sg.text;
      if (sg.q === "u") {
        if (i === 0) t = t.replace(/^~([a-z_][a-z0-9_-]*)?(?=\/|$)/, (m, u) => (u ? (c.h.user(u) || { home: m }).home : c.env.HOME));
        if (/[*?]/.test(t)) glob = true;
        t = expandVars(t, c);
      } else quoted = true;
      text += t;
    });
    if (glob) {
      const hits = globPaths(c, text);
      if (hits.length) return hits;
    }
    if (!quoted && segs.every((s) => s.q === "u") && segs.some((s) => s.text.includes("$"))) return text.split(/\s+/).filter(Boolean);
    return [text];
  }
  function globPaths(c, pattern) {
    const abs = pattern.startsWith("/");
    const parts = pattern.split("/").filter(Boolean);
    let paths = [abs ? "/" : c.cwd];
    for (const part of parts) {
      const next = [];
      for (const p of paths) {
        if (!/[*?]/.test(part)) { if (c.h.lookup(norm(part, p), c.user).node) next.push(norm(part, p)); continue; }
        const r = c.h.lookup(p, c.user);
        if (!r.node || r.node.t !== "d" || !c.h.can(c.user, r.node, 4)) continue;
        const re = globRe(part);
        const bulk = r.node.bulk;
        if (bulk && re.test(bulk.prefix + "x")) { next.push({ bulk: r.path, n: bulk.n }); continue; }
        for (const k of c.h.kids(r.path)) if (re.test(k) && (part.startsWith(".") || !k.startsWith("."))) next.push(norm(k, p));
      }
      paths = next;
    }
    const base = c.cwd === "/" ? "/" : c.cwd + "/";
    return paths.flatMap((p) => (typeof p === "object" ? [{ bulk: p.bulk, n: p.n }] : [abs ? p : p.startsWith(base) ? p.slice(base.length) : p]));
  }

  // Run a command line; returns terminal lines as [text, class].
  function shell(h, line) {
    const term = [];
    if (root.LQSim.before) {
      const stop = root.LQSim.before(h, line, term);
      if (stop) return term;
    }
    h.history.push(line);
    runLine(h, line, term, ctxOf(h));
    h.tick(1);
    if (h.hungHit) {
      const m = h.hungHit;
      h.hungHit = null;
      term.splice(0, term.length, ["^C", ""], [`(the command hung in state D, waiting for ${m.server} to answer for ${m.mnt}; the playground interrupted it. On a hard NFS mount Ctrl+C often does not work)`, "dim"]);
    }
    if (h.rebooting) {
      h.rebooting = false;
      term.push([`Connection to ${h.hostname} closed by remote host.`, ""]);
      root.LQSim.reboot(h);
      term.push(["(the server restarts; the playground logs you in again)", "dim"]);
      if (h.emergency) term.push(...h.scenario.intro ? h.scenario.intro.map((l) => [l, ""]) : [["You are in emergency mode.", ""]]);
      else term.push([`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux ${h.kernel} x86_64)`, ""], ["", ""], [`Last login: ${root.LQSim.longDate(h.clock - 60000)} from 203.0.113.24`, ""]);
    }
    return term;
  }
  function ctxOf(h) {
    const s = h.sess;
    return { h, user: s.user, env: s.env, cwd: s.cwd, umask: s.umask, args: [], term: null };
  }
  function runLine(h, line, term, c) {
    const p = parse(line);
    if (p.error) { term.push([`-bash: ${p.error}`, "err"]); h.status = 2; return 2; }
    for (const item of p.items) {
      if (item.op === "&&" && h.status !== 0) continue;
      if (item.op === "||" && h.status === 0) continue;
      const res = runPipe(c.script ? { ...c, cwd: c.own ? c.own.cwd : c.cwd } : { ...ctxOf(h), args: c.args }, item.pipe, term);
      h.status = res.code;
      for (const l of res.out) term.push([l, ""]);
      if (res.exit) return res.code;
    }
    return h.status;
  }
  function capture(c, line) {
    const p = parse(line);
    if (p.error) return "";
    const out = [];
    for (const item of p.items) out.push(...runPipe(c, item.pipe, c.term || []).out);
    return out.join("\n");
  }
  function runPipe(c, pipe, term) {
    let input = null, res = { out: [], code: 0 };
    pipe.forEach((cmd, i) => {
      res = runSimple({ ...c, term, piped: i < pipe.length - 1 || cmd.redirs.some((r) => r.op === ">" || r.op === ">>") }, cmd, input);
      input = res.out;
    });
    return res;
  }
  function runSimple(c, cmd, stdin) {
    const { h } = c;
    const fail = (msg) => { c.term.push([msg, "err"]); return { out: [], code: 1 }; };
    const group = cmd.words.length === 1 && cmd.words[0][0].q === "group";
    if (group) {
      const term = [];
      const code = runLine(h, cmd.words[0][0].text, term, { ...c, script: c.script || "-bash", own: c.own || { cwd: c.cwd } });
      for (const [t, k] of term) if (k) c.term.push([t, k]);
      return { out: term.filter(([, k]) => !k).map(([t]) => t), code };
    }
    let argv = cmd.words.flatMap((w) => expandWord(w, c));
    const env = {};
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      const [k, ...v] = argv.shift().split("=");
      env[k] = v.join("=");
    }
    if (!argv.length && !cmd.redirs.length) { Object.assign(c.env, env); return ok(); }
    // The shell opens redirections as the logged-in user, before sudo runs.
    let outFile = null, errTo = null, input = stdin;
    for (const r of cmd.redirs) {
      if (r.op === "2>&1") { errTo = "out"; continue; }
      if (r.op === ">&2") continue;
      const target = expandWord(r.target, c)[0];
      if (typeof target !== "string") return fail("-bash: ambiguous redirect");
      const path = norm(target, c.cwd);
      if (r.op === "<") {
        const rr = h.lookup(path, c.user);
        if (rr.err || !h.can(c.user, rr.node, 4)) return fail(`-bash: ${target}: ${ERR[rr.err || "EACCES"]}`);
        input = lines(rr.node.gen ? rr.node.gen(h).join("\n") : rr.node.data || "");
        continue;
      }
      if (path === "/dev/null") { if (r.op.startsWith("2")) errTo = "null"; else if (r.op === "&>") { errTo = "null"; outFile = { path, null: true }; } else outFile = { path, null: true }; continue; }
      const append = r.op === ">>" || r.op === "2>>";
      const e = h.writeFile(path, "", c.user, true, c.umask);
      if (e) return fail(`-bash: ${target}: ${ERR[e]}`);
      if (!append) {
        const e2 = h.writeFile(path, "", c.user, false, c.umask);
        if (e2) return fail(`-bash: ${target}: ${ERR[e2]}`);
      }
      if (r.op.startsWith("2")) errTo = { path, target };
      else { outFile = { path, target }; if (r.op === "&>") errTo = "out"; }
    }
    let res = argv.length ? exec({ ...c, envOver: env }, argv, input) : ok();
    if (typeof res.code !== "number") res = ok(res.out || []);
    let out = res.out || [];
    const err = res.err || [];
    if (errTo === "out") out = out.concat(err);
    else if (errTo && errTo !== "null") h.writeFile(errTo.path, err.map((l) => l + "\n").join(""), c.user, true, c.umask);
    else if (errTo !== "null") for (const l of err) c.term.push([l, "err"]);
    for (const n of res.notes || []) c.term.push([n, "dim"]);
    if (outFile) {
      if (!outFile.null && out.length) {
        const e = h.writeFile(outFile.path, out.map((l) => l + "\n").join(""), c.user, true, c.umask);
        if (e) c.term.push([`-bash: ${outFile.target}: ${ERR[e]}`, "err"]);
      }
      out = [];
    }
    return { out, code: res.code, exit: res.exit };
  }

  const BUILTINS = new Set(["cd", "pwd", "echo", "printf", "export", "unset", "umask", "ulimit", "exit", "logout", "type", "alias", "set",
    "source", ".", "true", "false", ":", "history", "test", "[", "command", "help", "kill"]);

  // Find a command: builtins, then PATH. Returns {builtin} or {path, node} or null.
  function which(c, name, path, external) {
    if (BUILTINS.has(name) && !external) return { builtin: name };
    for (const dir of (path || c.env.PATH || "").split(":")) {
      if (!dir) continue;
      const p = norm(name, dir);
      const r = c.h.lookup(p, c.user);
      if (r.node && r.node.t === "f" && r.node.m & 0o111) return { path: p, node: r.node };
    }
    return null;
  }

  function exec(c, argv, stdin) {
    const [name, ...args] = argv;
    // A glob over a folder of a million files is too long for one command line.
    if (argv.some((a) => typeof a === "object")) {
      const w = typeof name === "string" && which(c, name);
      return fail(`-bash: ${w && w.path ? w.path : name}: ${ERR.E2BIG}`, 126);
    }
    const env = { ...c.env, ...(c.envOver || {}) };
    const cc = { ...c, env, name };
    const where = c.script ? `${c.script}: line ${c.line}: ` : "-bash: ";
    if (name.includes("/")) {
      const path = norm(name, c.cwd);
      const r = c.h.lookup(path, c.user);
      if (r.err) return fail(`${where}${name}: ${ERR[r.err]}`, 127);
      if (r.node.t === "d") return fail(`${where}${name}: Is a directory`, 126);
      if (!c.h.can(c.user, r.node, 1) || (c.user !== "root" && !c.h.can(c.user, r.node, 4) && r.node.data !== ELF)) {
        return fail(`${where}${name}: ${ERR.EACCES}`, 126);
      }
      const m = c.h.mountOf(r.path);
      if (m && /noexec/.test(m.opts || "")) return fail(`${where}${name}: ${ERR.EACCES}`, 126);
      return runFile(cc, r.path, r.node, args, stdin);
    }
    if (BUILTINS.has(name)) return root.LQSim.builtin(cc, name, args, stdin);
    const w = which(cc, name);
    if (!w) {
      const known = root.LQSim.notInstalled && root.LQSim.notInstalled(name);
      if (known && !c.script) return fail(known, 127);
      if (c.cron) return fail(c.h.distro === "rhel" ? `/bin/sh: line 1: ${name}: command not found` : `/bin/sh: 1: ${name}: not found`, 127);
      // Ubuntu's command-not-found handler drops the "-bash: " prefix; RHEL keeps it.
      return fail(c.script || c.h.distro === "rhel" ? `${where}${name}: command not found` : `${name}: command not found`, 127);
    }
    return runFile(cc, w.path, w.node, args, stdin);
  }

  function runFile(c, path, node, args, stdin) {
    const data = node.data || "";
    if (data === ELF) {
      const fn = CMDS[basename(path)] || c.h.tools[path];
      if (!fn) return fail(`${basename(path)}: this playground does not run it by hand; use systemctl`, 1);
      return fn(c, args, stdin || null) || ok();
    }
    if (!data.startsWith("#!")) return runScript(c, path, data, args);
    const first = data.split("\n")[0];
    const interp = first.slice(2).replace(/^ +/, "").split(" ")[0];
    const ir = c.h.lookup(interp, "root");
    if (ir.err) return fail(`-bash: ${c.name}: ${first.slice(2).replace(/\r/g, "^M")}: bad interpreter: No such file or directory`, 126);
    return runScript(c, path, data, args);
  }
  // Run a script line by line; `set -e` stops at the first failure.
  // A script's errors are returned, so the caller's 2>&1 or 2>file applies to them.
  function runScript(c, path, data, args) {
    const term = [];
    const sc = { ...c, script: c.name, args, env: { ...c.env }, cron: false, own: { cwd: c.cwd } };
    const done = (code) => ({ out, err: term.map(([t]) => t), code });
    let errexit = false, code = 0;
    const out = [];
    const src = data.split("\n");
    for (let i = 0; i < src.length; i++) {
      // A Windows line ending stays on the line, as it does in bash.
      const line = src[i].replace(/^\s+/, "");
      if (!line.trim() || line.startsWith("#")) continue;
      if (/^set\s+-[a-z]*e/.test(line) && !line.includes("\r")) { errexit = true; continue; }
      const m = /^exit(?:\s+(\d+))?$/.exec(line.trim());
      if (m) return done(Number(m[1] || 0));
      const p = parse(line);
      if (p.error) { term.push([`${c.name}: line ${i + 1}: ${p.error}`, "err"]); return done(2); }
      for (const item of p.items) {
        if (item.op === "&&" && code !== 0) continue;
        if (item.op === "||" && code === 0) continue;
        const res = runPipe({ ...sc, cwd: sc.own.cwd, line: i + 1 }, item.pipe, term);
        out.push(...res.out);
        code = res.code;
        c.h.status = code;
      }
      if (errexit && code !== 0) return done(code);
    }
    return done(code);
  }

  // --- options -------------------------------------------------------------------

  // Split args into flags and operands. Short flags combine (-la); `spec`
  // lists the flags that take a value, e.g. "n" for head -n 5.
  function opts(args, spec = "") {
    const f = {}, rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a !== "string" || a === "-" || !a.startsWith("-") || /^-\d/.test(a) && !spec.includes("#")) { rest.push(a); continue; }
      if (a === "--") { rest.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--")) {
        const [k, v] = a.slice(2).split(/=(.*)/s);
        f[k] = v !== undefined ? v : true;
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const k = a[j];
        if (spec.includes(k)) { f[k] = a.slice(j + 1) || args[++i]; break; }
        f[k] = true;
      }
    }
    return { f, rest };
  }

  // --- files ---------------------------------------------------------------------

  const CMDS = {};
  function lsLong(c, path, n, name) {
    const h = c.h;
    const size = h.sizeOf(n);
    return { mode: modeStr(n) + (n.acl ? "+" : ""), links: n.t === "d" ? 2 + h.kids(path).filter((k) => h.fs.get(norm(k, path)).t === "d").length : 1,
      u: n.u, g: n.g, size, time: lsTime(n.mt || h.clock, h.clock), name: name + (n.t === "l" ? ` -> ${n.to}` : "") };
  }
  function table(rows, keys, rightAlign) {
    const w = keys.map((k) => Math.max(...rows.map((r) => String(r[k]).length)));
    return rows.map((r) => keys.map((k, i) => (i === keys.length - 1 ? String(r[k]) : rightAlign.includes(k) ? String(r[k]).padStart(w[i]) : String(r[k]).padEnd(w[i]))).join(" "));
  }

  CMDS.ls = (c, args) => {
    const { f, rest } = opts(args);
    const h = c.h;
    const long = f.l || f.n || f.g || f.o;
    const all = f.a || f.A;
    const targets = rest.length ? rest : ["."];
    const out = [], err = [];
    const fmtSize = (n) => (f.h ? human(n) : String(n));
    const render = (entries, dirPath) => {
      // One name per line into a pipe or file, as GNU ls does; columns on the terminal.
      const shown = (e) => (f.Z && h.distro === "rhel" ? `unconfined_u:object_r:${root.LQSim.rhelLabel(h, e.path)}:s0 ${e.name}` : e.name);
      if (!long) return !entries.length ? [] : c.piped || f["1"] || f.Z ? entries.map(shown) : [entries.map(shown).join("  ")];
      const rows = entries.map((e) => {
        const r = lsLong(c, e.path, e.node, e.name);
        if (f.n) { r.u = String((h.user(r.u) || { uid: r.u }).uid); r.g = String((h.groups().find((g) => g.name === r.g) || { gid: r.g }).gid); }
        r.size = fmtSize(r.size);
        // On SELinux systems ls marks labelled files with a dot; -Z shows the label.
        if (h.distro === "rhel") { r.mode = r.mode.replace(/\+?$/, "."); if (f.Z) r.g += " " + `unconfined_u:object_r:${root.LQSim.rhelLabel(h, e.path)}:s0`; }
        return r;
      });
      const total = entries.reduce((s, e) => s + (e.node.t === "f" ? Math.ceil(h.sizeOf(e.node) / 4096) * 4 : e.node.t === "d" ? 4 : 0), 0);
      return [...(dirPath ? [`total ${f.h ? human(total * 1024) : total}`] : []), ...table(rows, ["mode", "links", "u", "g", "size", "time", "name"], ["links", "size"])];
    };
    const files = [], dirs = [];
    for (const t of targets) {
      if (typeof t === "object") { err.push(`-bash: /usr/bin/ls: ${ERR.E2BIG}`); continue; }
      const path = norm(t, c.cwd);
      const r = h.lookup(path, c.user, !(long && !t.endsWith("/")) || f.L);
      const rr = r.node && r.node.t === "l" ? h.lookup(path, c.user, true) : r;
      if (r.err) { err.push(`ls: cannot access '${t}': ${ERR[r.err]}`); continue; }
      if (rr.node && rr.node.t === "d" && !f.d) dirs.push({ t, path: rr.path, node: rr.node });
      else files.push({ name: t, path, node: r.node });
    }
    if (files.length) out.push(...render(files, null));
    for (const dd of dirs) {
      if (targets.length > 1) { if (out.length) out.push(""); out.push(`${dd.t}:`); }
      if (!h.can(c.user, dd.node, 4)) { err.push(`ls: cannot open directory '${dd.t}': ${ERR.EACCES}`); continue; }
      if (dd.node.virtual) { out.push(...render(dd.node.list(), dd.path)); continue; }
      if (dd.node.bulk) {
        const b = dd.node.bulk;
        const sample = b.names.slice(0, 3);
        sample.count = b.n + c.h.kids(dd.path).length;
        return { out: sample, err, code: 0, notes: c.piped ? [] : [`(… ${b.n.toLocaleString("en")} files named ${b.prefix}…; the playground prints the first three. Count them with: ls ${dd.t} | wc -l)`] };
      }
      let names = h.kids(dd.path).filter((k) => all || !k.startsWith("."));
      if (f.a) names = [".", "..", ...names];
      const entries = names.map((k) => ({ name: k, path: k === "." ? dd.path : k === ".." ? dirname(dd.path) : norm(k, dd.path) }))
        .map((e) => ({ ...e, node: h.fs.get(e.path) }));
      if (f.t) entries.sort((a, b) => (b.node.mt || 0) - (a.node.mt || 0));
      if (f.S) entries.sort((a, b) => h.sizeOf(b.node) - h.sizeOf(a.node));
      if (f.r) entries.reverse();
      out.push(...render(entries, dd.path));
    }
    return { out, err, code: err.length ? 2 : 0 };
  };

  CMDS.cat = (c, args, stdin) => {
    const { rest } = opts(args);
    if (!rest.length) return ok(stdin || []);
    const out = [], err = [];
    for (const t of rest) {
      const r = c.h.lookup(norm(t, c.cwd), c.user);
      if (r.err) { err.push(`${c.name}: ${t}: ${ERR[r.err]}`); continue; }
      if (r.node.t === "d") { err.push(`${c.name}: ${t}: Is a directory`); continue; }
      if (!r.node.virtual && !c.h.can(c.user, r.node, 4)) { err.push(`${c.name}: ${t}: ${ERR.EACCES}`); continue; }
      if (r.node.data === ELF) { out.push("\u007fELF\u0002\u0001\u0001 (binary data)"); continue; }
      out.push(...(r.node.gen ? r.node.gen(c.h) : lines(r.node.data || "")));
    }
    return { out, err, code: err.length ? 1 : 0 };
  };
  CMDS.less = CMDS.more = (c, args, stdin) => {
    const res = CMDS.cat({ ...c, name: c.name }, args.filter((a) => !a.startsWith("+") && !a.startsWith("-")), stdin);
    return { ...res, notes: res.out.length ? ["(less pages through the file; the playground prints it all. Press nothing to quit.)"] : [] };
  };
  // head and tail read files or stdin. tail -f shows a snapshot: the playground does not follow.
  function headTail(tail) {
    return (c, args, stdin) => {
      const a = args.map((x) => (/^-\d+$/.test(x) ? "-n" + x.slice(1) : x));
      const { f, rest } = opts(a, "nc");
      const n = Number(String(f.n || "10").replace(/^\+/, ""));
      const from = tail && String(f.n || "").startsWith("+");
      const src = rest.length ? CMDS.cat(c, rest, null) : ok(stdin || []);
      const pick = (l) => (tail ? (from ? l.slice(n - 1) : l.slice(Math.max(0, l.length - n))) : l.slice(0, n));
      const res = { ...src, out: pick(src.out) };
      if (tail && (f.f || f.F)) res.notes = ["(following the file; the playground shows a snapshot and returns. On a server, Ctrl+C stops tail -f.)"];
      return res;
    };
  }
  CMDS.head = headTail(false);
  CMDS.tail = headTail(true);

  CMDS.grep = (c, args, stdin) => {
    const { f, rest } = opts(args, "emABC");
    let pattern = f.e != null ? f.e : rest.shift();
    if (pattern == null) return fail(["Usage: grep [OPTION]... PATTERNS [FILE]...", "Try 'grep --help' for more information."], 2);
    let re;
    try {
      const src = f.F ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : f.E || c.name === "egrep" ? pattern : pattern.replace(/\\([|()+?{}])/g, "$1§").replace(/(^|[^§])([|()+?{}])/g, "$1\\$2").replace(/([|()+?{}])§/g, "$1");
      re = new RegExp(f.w ? `\\b(?:${src})\\b` : src, f.i ? "i" : "");
    } catch { return fail("grep: Unmatched ( or \\(", 2); }
    const out = [], err = [];
    let matched = 0;
    const scan = (text, label) => {
      let n = 0;
      text.forEach((l, i) => {
        if (re.test(l) === !f.v) {
          n++;
          if (!f.c && !f.l && !f.q) out.push((label && rest.length + (f.r || f.R ? 2 : 0) > 1 && !f.h ? label + ":" : "") + (f.n ? `${i + 1}:` : "") + (f.o ? (l.match(re) || [l])[0] : l));
        }
      });
      if (f.c) out.push((label && rest.length > 1 ? label + ":" : "") + n);
      if (f.l && n) out.push(label);
      matched += n;
    };
    if (!rest.length) scan(stdin || [], null);
    for (const t of rest) {
      const path = norm(t, c.cwd);
      const r = c.h.lookup(path, c.user);
      if (r.err) { err.push(`grep: ${t}: ${ERR[r.err]}`); continue; }
      if (r.node.t === "d") {
        if (!(f.r || f.R)) { err.push(`grep: ${t}: Is a directory`); continue; }
        for (const p of c.h.walk(r.path)) {
          const n = c.h.fs.get(p);
          if (n.t !== "f" || n.data === ELF) continue;
          if (!c.h.can(c.user, n, 4)) { err.push(`grep: ${t.replace(/\/$/, "")}${p.slice(r.path.length)}: ${ERR.EACCES}`); continue; }
          scan(n.gen ? n.gen(c.h) : lines(n.data), t.replace(/\/$/, "") + p.slice(r.path.length));
        }
        continue;
      }
      if (!r.node.virtual && !c.h.can(c.user, r.node, 4)) { err.push(`grep: ${t}: ${ERR.EACCES}`); continue; }
      if (r.node.data === ELF) { if (re.test("ELF")) out.push(`grep: ${t}: binary file matches`); continue; }
      scan(r.node.gen ? r.node.gen(c.h) : lines(r.node.data || ""), t);
    }
    if (f.s) err.length = 0;
    return { out: f.q ? [] : out, err, code: err.length && !matched ? 2 : matched ? 0 : 1 };
  };
  CMDS.egrep = CMDS.grep;

  CMDS.wc = (c, args, stdin) => {
    const { f, rest } = opts(args);
    const count = (ls) => (f.l ? ls.length : f.w ? ls.join(" ").split(/\s+/).filter(Boolean).length : f.c ? ls.reduce((s, l) => s + l.length + 1, 0) : null);
    if (!rest.length) {
      const ls = stdin || [];
      if (f.l) return ok([String(ls.count != null ? ls.count : ls.length)]);
      if (f.w || f.c) return ok([String(count(ls))]);
      return ok([`${String(ls.length).padStart(7)} ${String(ls.join(" ").split(/\s+/).filter(Boolean).length).padStart(7)} ${String(ls.reduce((s, l) => s + l.length + 1, 0)).padStart(7)}`]);
    }
    const out = [], err = [];
    for (const t of rest) {
      const r = CMDS.cat(c, [t], null);
      if (r.err.length) { err.push(...r.err.map((e) => e.replace(/^cat/, "wc"))); continue; }
      out.push(f.l || f.w || f.c ? `${count(r.out)} ${t}` : `${r.out.length} ${r.out.join(" ").split(/\s+/).filter(Boolean).length} ${r.out.reduce((s, l) => s + l.length + 1, 0)} ${t}`);
    }
    return { out, err, code: err.length ? 1 : 0 };
  };

  // sort -h understands the sizes du -h prints.
  CMDS.sort = (c, args, stdin) => {
    const { f, rest } = opts(args, "kt");
    const src = rest.length ? CMDS.cat(c, rest, null).out : [...(stdin || [])];
    const key = (l) => {
      const fields = f.t ? l.split(f.t) : l.trim().split(/\s+/);
      return f.k ? (fields[Number(String(f.k).split(",")[0]) - 1] || "") : l.trim();
    };
    const num = (s) => {
      const m = /^(-?\d+(?:\.\d+)?)([KMGTP]?)/.exec(s);
      return m ? Number(m[1]) * (f.h ? 1024 ** " KMGTP".indexOf(m[2] || " ") : 1) : 0;
    };
    src.sort((a, b) => (f.n || f.h ? num(key(a)) - num(key(b)) : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    if (f.r) src.reverse();
    return ok(f.u ? [...new Set(src)] : src);
  };
  CMDS.uniq = (c, args, stdin) => {
    const { f } = opts(args);
    const out = [];
    for (const l of stdin || []) {
      const last = out[out.length - 1];
      if (last && last.l === l) last.n++; else out.push({ l, n: 1 });
    }
    return ok(out.map((x) => (f.c ? `${String(x.n).padStart(7)} ${x.l}` : x.l)));
  };
  CMDS.cut = (c, args, stdin) => {
    const { f, rest } = opts(args, "dfc");
    const src = rest.length ? CMDS.cat(c, rest, null).out : stdin || [];
    const pick = (spec, n) => spec.split(",").flatMap((r) => {
      const [a, b] = r.split("-");
      const lo = Number(a || 1), hi = r.includes("-") ? Number(b || n) : lo;
      return Array.from({ length: Math.max(0, Math.min(hi, n) - lo + 1) }, (_, i) => lo + i - 1);
    });
    if (f.c) return ok(src.map((l) => pick(f.c, l.length).map((i) => l[i]).join("")));
    const dlm = f.d == null ? "\t" : f.d;
    return ok(src.map((l) => (l.includes(dlm) ? pick(String(f.f || "1"), l.split(dlm).length).map((i) => l.split(dlm)[i]).join(dlm) : l)));
  };
  // awk: enough for '{print $1, $NF}' and -F.
  CMDS.awk = (c, args, stdin) => {
    const { f, rest } = opts(args, "F");
    const prog = rest.shift() || "";
    const m = /^\s*(?:\/(.*)\/\s*)?\{\s*print\s*(.*?)\s*;?\s*\}\s*$/.exec(prog) || /^\s*\/(.*)\/\s*$/.exec(prog);
    if (!m) return fail(`awk: this playground understands '{print $1}' and '/pattern/'`, 2);
    const src = rest.length ? CMDS.cat(c, rest, null).out : stdin || [];
    const re = m[1] ? new RegExp(m[1]) : null;
    return ok(src.filter((l) => !re || re.test(l)).map((l) => {
      const fs = f.F ? l.split(f.F) : l.trim().split(/\s+/);
      if (!m[2]) return l;
      return m[2].split(/\s*,\s*/).map((e) => (e === "$0" ? l : e === "$NF" ? fs[fs.length - 1] : /^\$\d+$/.test(e) ? fs[Number(e.slice(1)) - 1] || "" : e.replace(/^"|"$/g, ""))).join(" ");
    }));
  };
  CMDS.tr = (c, args, stdin) => {
    const { f, rest } = opts(args);
    const unesc = (s) => (s || "").replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const a = unesc(rest[0]);
    return ok((stdin || []).map((l) => [...l].filter((ch) => !(f.d && a.includes(ch))).join("")));
  };
  CMDS.xargs = (c, args, stdin) => {
    const words = (stdin || []).join(" ").split(/\s+/).filter(Boolean);
    const argv = args.length ? args : ["echo"];
    return exec(c, [...argv, ...words], null);
  };
  CMDS.tee = (c, args, stdin) => {
    const { f, rest } = opts(args);
    const data = (stdin || []).map((l) => l + "\n").join("");
    const err = [];
    for (const t of rest) {
      const e = c.h.writeFile(norm(t, c.cwd), data, c.user, Boolean(f.a), c.umask);
      if (e) err.push(`tee: ${t}: ${ERR[e]}`);
    }
    return { out: stdin || [], err, code: err.length ? 1 : 0 };
  };
  CMDS.basename = (c, args) => ok([basename(args[0] || "")]);
  CMDS.dirname = (c, args) => ok([dirname(args[0] || ".")]);

  CMDS.touch = (c, args) => {
    const err = [];
    for (const t of opts(args).rest) {
      const path = norm(t, c.cwd);
      const r = c.h.lookup(path, c.user);
      if (r.node) {
        if (!c.h.can(c.user, r.node, 2) && r.node.u !== c.user && c.user !== "root") { err.push(`touch: cannot touch '${t}': ${ERR.EACCES}`); continue; }
        const m = c.h.mountOf(r.path);
        if (m && m.ro) { err.push(`touch: cannot touch '${t}': ${ERR.EROFS}`); continue; }
        if (r.node.imm) { err.push(`touch: setting times of '${t}': ${ERR.EPERM}`); continue; }
        r.node.mt = c.h.clock;
        continue;
      }
      const e = c.h.writeFile(path, "", c.user, true, c.umask);
      if (e) err.push(`touch: cannot touch '${t}': ${ERR[e]}`);
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  };
  function mkdirOne(c, path, mode) {
    const h = c.h;
    const parent = h.lookup(dirname(path), c.user);
    if (parent.err) return parent.err;
    if (!h.can(c.user, parent.node, 2)) return "EACCES";
    const e = h.writable(path, 4096, true);
    if (e) return e;
    const sg = parent.node.m & 0o2000;
    h.fs.set(norm(basename(path), parent.path), { t: "d", u: c.user, g: sg ? parent.node.g : h.primaryGroup(c.user), m: (mode != null ? mode : 0o777 & ~c.umask) | sg, mt: h.clock });
    return null;
  }
  CMDS.mkdir = (c, args) => {
    const { f, rest } = opts(args, "m");
    const err = [];
    for (const t of rest) {
      const path = norm(t, c.cwd);
      const parts = f.p ? path.split("/").filter(Boolean).map((x, i, a) => "/" + a.slice(0, i + 1).join("/")) : [path];
      for (const p of parts) {
        const r = c.h.lookup(p, c.user);
        if (r.node) { if (!f.p) err.push(`mkdir: cannot create directory '${t}': ${ERR.EEXIST}`); continue; }
        const e = mkdirOne(c, p, f.m ? parseInt(f.m, 8) : null);
        if (e) { err.push(`mkdir: cannot create directory '${f.p ? p : t}': ${ERR[e]}`); break; }
      }
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  };
  function removable(c, path) {
    const h = c.h;
    const parent = h.fs.get(dirname(path));
    if (!parent) return "ENOENT";
    const n = h.fs.get(path);
    if (h.mountOf(path) && h.mountOf(path).ro) return "EROFS";
    if (n.imm || parent.imm) return "EPERM";
    if (c.user === "root") return null;
    if (!h.can(c.user, parent, 2) || !h.can(c.user, parent, 1)) return "EACCES";
    if (parent.m & 0o1000 && n.u !== c.user && parent.u !== c.user) return "EPERM";
    return null;
  }
  function unlink(h, path) {
    const n = h.fs.get(path);
    // A process still writing the file keeps its space until it closes it.
    for (const p of h.procs) for (const fd of p.fds || []) if (fd.path === path) { fd.deleted = true; fd.size = h.sizeOf(n); fd.mount = (h.mountOf(path) || {}).mnt; }
    for (const k of h.walk(path)) h.fs.delete(k);
    h.fs.delete(path);
  }
  CMDS.rm = (c, args) => {
    const { f, rest } = opts(args);
    const err = [];
    const recursive = f.r || f.R || f.recursive;
    for (const t of rest) {
      if (typeof t === "object") { err.push(`-bash: /usr/bin/rm: ${ERR.E2BIG}`); continue; }
      const path = norm(t, c.cwd);
      if (path === "/" && !f["no-preserve-root"]) { err.push("rm: it is dangerous to operate recursively on '/'", "rm: use --no-preserve-root to override this failsafe"); continue; }
      const r = c.h.lookup(path, c.user, false);
      if (r.err) { if (!f.f) err.push(`rm: cannot remove '${t}': ${ERR[r.err]}`); continue; }
      if (r.node.virtual) { err.push(`rm: cannot remove '${t}': ${ERR.EACCES}`); continue; }
      if (r.node.t === "d" && !recursive) { err.push(`rm: cannot remove '${t}': Is a directory`); continue; }
      if (c.h.mounts.some((m) => m.mnt === r.path && !m.gone)) { err.push(`rm: cannot remove '${t}': ${ERR.EBUSY}`); continue; }
      const e = removable(c, r.path);
      if (e) { err.push(`rm: cannot remove '${t}': ${ERR[e]}`); continue; }
      if (r.node.t === "d" && c.user !== "root") {
        const blocked = c.h.walk(r.path).find((k) => !c.h.can(c.user, c.h.fs.get(dirname(k)), 2));
        if (blocked) { err.push(`rm: cannot remove '${blocked.replace(r.path, t)}': ${ERR.EACCES}`); continue; }
      }
      unlink(c.h, r.path);
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  };
  CMDS.rmdir = (c, args) => {
    const err = [];
    for (const t of args) {
      const path = norm(t, c.cwd);
      const r = c.h.lookup(path, c.user, false);
      if (r.err) { err.push(`rmdir: failed to remove '${t}': ${ERR[r.err]}`); continue; }
      if (r.node.t !== "d") { err.push(`rmdir: failed to remove '${t}': Not a directory`); continue; }
      if (c.h.kids(r.path).length || r.node.bulk) { err.push(`rmdir: failed to remove '${t}': ${ERR.ENOTEMPTY}`); continue; }
      const e = removable(c, r.path);
      if (e) { err.push(`rmdir: failed to remove '${t}': ${ERR[e]}`); continue; }
      c.h.fs.delete(r.path);
    }
    return { out: [], err, code: err.length ? 1 : 0 };
  };
  // cp and mv: files and directories, onto a file or into a directory.
  function copyMove(move) {
    return (c, args) => {
      const { f, rest } = opts(args);
      const tool = move ? "mv" : "cp";
      if (rest.length < 2) return fail([`${tool}: missing destination file operand after '${rest[0] || ""}'`, `Try '${tool} --help' for more information.`]);
      const h = c.h;
      const destArg = rest.pop();
      const dest = norm(destArg, c.cwd);
      const dr = h.lookup(dest, c.user);
      const err = [];
      for (const t of rest) {
        const src = norm(t, c.cwd);
        const sr = h.lookup(src, c.user, !move);
        if (sr.err) { err.push(`${tool}: cannot stat '${t}': ${ERR[sr.err]}`); continue; }
        if (sr.node.t === "d" && !move && !(f.r || f.R || f.a)) { err.push(`cp: -r not specified; omitting directory '${t}'`); continue; }
        if (!move && !h.can(c.user, sr.node, 4)) { err.push(`cp: cannot open '${t}' for reading: ${ERR.EACCES}`); continue; }
        const target = dr.node && dr.node.t === "d" ? norm(basename(src), dr.path) : dest;
        const parent = h.lookup(dirname(target), c.user);
        if (parent.err || !h.can(c.user, parent.node, 2)) {
          err.push(`${tool}: cannot ${move ? "move" : "create regular file"} '${move ? t : destArg}'${move ? ` to '${destArg}'` : ""}: ${ERR[parent.err || "EACCES"]}`);
          continue;
        }
        const ro = h.writable(target, move ? 0 : h.sizeOf(sr.node), true);
        if (ro) { err.push(`${tool}: cannot create regular file '${destArg}': ${ERR[ro]}`); continue; }
        if (move) {
          const e = removable(c, sr.path);
          if (e) { err.push(`mv: cannot move '${t}' to '${destArg}': ${ERR[e]}`); continue; }
          for (const k of [sr.path, ...h.walk(sr.path)]) {
            const n = h.fs.get(k);
            // mv keeps the SELinux label a file had where it was created.
            if (h.distro === "rhel" && !n.ctx) n.ctx = root.LQSim.rhelLabel(h, k);
            h.fs.delete(k);
            h.fs.set(target + k.slice(sr.path.length), n);
          }
          for (const p of h.procs) for (const fd of p.fds || []) if (fd.path === sr.path) fd.path = target;
          continue;
        }
        for (const k of [sr.path, ...h.walk(sr.path)]) {
          const n = h.fs.get(k) || sr.node;
          const keep = f.a || f.p;
          h.fs.set(target + k.slice(sr.path.length), { ...n, u: keep ? n.u : c.user, g: keep ? n.g : h.primaryGroup(c.user),
            m: keep ? n.m : n.m & ~c.umask & 0o7777, mt: keep ? n.mt : h.clock, imm: false, gen: undefined,
            data: n.gen ? n.gen(h).join("\n") + "\n" : n.data });
        }
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    };
  }
  CMDS.cp = copyMove(false);
  CMDS.mv = copyMove(true);

  CMDS.ln = (c, args) => {
    const { f, rest } = opts(args);
    if (!f.s) return fail("ln: this playground makes symbolic links only: ln -s TARGET LINK_NAME");
    if (rest.length < 2) return fail(["ln: missing file operand", "Try 'ln --help' for more information."]);
    const [target, name] = rest;
    const h = c.h;
    let path = norm(name, c.cwd);
    const existing = h.lookup(path, c.user, !(f.n || f.T));
    // Without -n, a link to a directory is followed: the new link lands inside it.
    if (existing.node && existing.node.t === "d" && !f.T) path = norm(basename(target), existing.path);
    const here = h.fs.get(path);
    if (here && !f.f) return fail(`ln: failed to create symbolic link '${name}': ${ERR.EEXIST}`);
    const parent = h.lookup(dirname(path), c.user);
    if (parent.err || !h.can(c.user, parent.node, 2)) return fail(`ln: failed to create symbolic link '${name}': ${ERR[parent.err || "EACCES"]}`);
    if (here && here.t === "d") return fail(`ln: ${name}: cannot overwrite directory`);
    h.fs.set(path, { t: "l", u: c.user, g: h.primaryGroup(c.user), m: 0o777, to: target, mt: h.clock });
    return ok();
  };
  CMDS.readlink = (c, args) => {
    const { f, rest } = opts(args);
    const path = norm(rest[0] || "", c.cwd);
    if (f.f || f.e || f.m) { const r = c.h.lookup(path, c.user); return r.err ? fail([], 1) : ok([r.path]); }
    const n = c.h.fs.get(path);
    return n && n.t === "l" ? ok([n.to]) : fail([], 1);
  };
  CMDS.realpath = (c, args) => {
    const r = c.h.lookup(norm(args[0] || ".", c.cwd), c.user);
    return r.err ? fail(`realpath: ${args[0]}: ${ERR[r.err]}`) : ok([r.path]);
  };

  function chmodLike(tool) {
    return (c, args) => {
      const { f, rest } = opts(args.map((a) => (tool === "chmod" && /^-[rwxXst]+$/.test(a) ? "\u0000" + a : a)));
      const spec = (rest.shift() || "").replace(/^\u0000/, "");
      const h = c.h;
      const err = [];
      for (const t of rest) {
        const path = norm(t, c.cwd);
        const r = h.lookup(path, c.user);
        if (r.err) { err.push(`${tool}: cannot access '${t}': ${ERR[r.err]}`); continue; }
        for (const p of [r.path, ...(f.R ? h.walk(r.path) : [])]) {
          const n = h.fs.get(p) || r.node;
          if (n.t === "l") continue;
          const ro = h.mountOf(p) && h.mountOf(p).ro;
          if (tool === "chmod") {
            if ((c.user !== "root" && n.u !== c.user) || n.imm || ro) { err.push(`chmod: changing permissions of '${p === r.path ? t : p}': ${ERR[ro ? "EROFS" : "EPERM"]}`); continue; }
            const m = parseMode(spec, n.m, n.t === "d", c.umask);
            if (m === null) return fail([`chmod: invalid mode: '${spec}'`, "Try 'chmod --help' for more information."]);
            n.m = m;
          } else {
            const [u, g] = tool === "chgrp" ? [null, spec] : spec.split(/[:.]/);
            if (u && !h.user(u) && !/^\d+$/.test(u)) return fail(`chown: invalid user: '${spec}'`);
            if (g && !h.groups().some((x) => x.name === g) && !/^\d+$/.test(g)) return fail(`${tool}: invalid group: '${spec}'`);
            if (c.user !== "root" || n.imm || ro) { err.push(`${tool}: changing ${u ? "ownership" : "group"} of '${p === r.path ? t : p}': ${ERR[ro ? "EROFS" : "EPERM"]}`); continue; }
            if (u) n.u = u;
            if (g) n.g = g; else if (spec.endsWith(":")) n.g = h.primaryGroup(u);
          }
        }
      }
      return { out: [], err, code: err.length ? 1 : 0 };
    };
  }
  CMDS.chmod = chmodLike("chmod");
  CMDS.chown = chmodLike("chown");
  CMDS.chgrp = chmodLike("chgrp");
  CMDS.chattr = (c, args) => {
    const [spec, t] = args;
    const r = c.h.lookup(norm(t || "", c.cwd), c.user);
    if (!/^[+-]i$/.test(spec || "")) return fail("Usage: chattr [-pRVf] [-+=aAcCdDeijPsStTuFx] [-v version] files...");
    if (r.err) return fail(`chattr: ${ERR[r.err]} while trying to stat ${t}`);
    if (c.user !== "root") return fail(`chattr: Operation not permitted while setting flags on ${t}`);
    r.node.imm = spec === "+i";
    return ok();
  };
  CMDS.lsattr = (c, args) => {
    const out = [];
    for (const t of args) {
      const r = c.h.lookup(norm(t, c.cwd), c.user);
      if (r.err) return fail(`lsattr: ${ERR[r.err]} while trying to stat ${t}`);
      out.push(`${r.node.imm ? "----i---------e-------" : "--------------e-------"} ${t}`);
    }
    return ok(out);
  };
  CMDS.stat = (c, args) => {
    const { f, rest } = opts(args, "c");
    const out = [], err = [];
    for (const t of rest) {
      const r = c.h.lookup(norm(t, c.cwd), c.user, false);
      if (r.err) { err.push(`stat: cannot statx '${t}': ${ERR[r.err]}`); continue; }
      const n = r.node, h = c.h;
      const u = h.user(n.u) || { uid: n.u }, g = h.groups().find((x) => x.name === n.g) || { gid: n.g };
      const oct = (n.m & 0o7777).toString(8).padStart(4, "0");
      if (f.c) { out.push(f.c.replace(/%a/g, (n.m & 0o7777).toString(8)).replace(/%A/g, modeStr(n)).replace(/%U/g, n.u).replace(/%G/g, n.g).replace(/%s/g, h.sizeOf(n)).replace(/%n/g, t)); continue; }
      const kind = n.t === "d" ? "directory" : n.t === "l" ? "symbolic link" : h.sizeOf(n) ? "regular file" : "regular empty file";
      const iso = `${isoDay(n.mt || h.clock)} ${hms(n.mt || h.clock)}.000000000 +0000`;
      out.push(`  File: ${t}${n.t === "l" ? ` -> ${n.to}` : ""}`, `  Size: ${h.sizeOf(n)}\tBlocks: ${Math.ceil(h.sizeOf(n) / 4096) * 8}\tIO Block: 4096   ${kind}`,
        `Access: (${oct}/${modeStr(n)})  Uid: (${String(u.uid).padStart(5)}/${n.u.padStart(8)})   Gid: (${String(g.gid).padStart(5)}/${n.g.padStart(8)})`,
        `Access: ${iso}`, `Modify: ${iso}`, `Change: ${iso}`);
    }
    return { out, err, code: err.length ? 1 : 0 };
  };
  CMDS.file = (c, args) => ok(args.map((t) => {
    const r = c.h.lookup(norm(t, c.cwd), c.user, false);
    if (r.err) return `${t}: cannot open \`${t}' (${ERR[r.err]})`;
    const n = r.node;
    if (n.t === "d") return `${t}: directory`;
    if (n.t === "l") return `${t}: ${c.h.lookup(norm(t, c.cwd), c.user).err ? "broken " : ""}symbolic link to ${n.to}`;
    if (n.data === ELF) return `${t}: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, stripped`;
    const d = n.data || "";
    const crlf = d.includes("\r\n") ? ", with CRLF line terminators" : "";
    return `${t}: ${d.startsWith("#!/bin/bash") || d.startsWith("#!/usr/bin/env bash") ? "Bourne-Again shell script, ASCII text executable" : d.startsWith("#!") ? "POSIX shell script, ASCII text executable" : d ? "ASCII text" : "empty"}${crlf}`;
  }));

  // find: -name, -iname, -type, -size, -mtime, -mmin, -user, -perm, -xtype l,
  // -maxdepth, -newer is not needed here. Actions: -print, -ls, -delete.
  CMDS.find = (c, args) => {
    const h = c.h;
    const starts = [];
    let i = 0;
    while (i < args.length && !String(args[i]).startsWith("-")) starts.push(args[i++]);
    const tests = [];
    let maxdepth = Infinity, action = "print", execCmd = null;
    for (; i < args.length; i++) {
      const a = args[i], v = args[i + 1];
      if (a === "-maxdepth") { maxdepth = Number(v); i++; } else if (a === "-delete") action = "delete";
      else if (a === "-ls") action = "ls";
      else if (a === "-print") action = "print";
      else if (a === "-exec") { const end = args.indexOf(";", i); execCmd = args.slice(i + 1, end < 0 ? args.length : end); i = end < 0 ? args.length : end; action = "exec"; } else if (["-name", "-iname", "-type", "-xtype", "-size", "-mtime", "-mmin", "-user", "-group", "-perm", "-path"].includes(a)) {
        if (v == null) return fail(`find: missing argument to \`${a}'`);
        tests.push([a, v]);
        i++;
      } else if (a === "-o" || a === "-a" || a === "!" || a === "-not" || a === "(" || a === ")") {
        return fail("find: this playground supports tests joined by AND only");
      } else return fail(`find: unknown predicate \`${a}'`);
    }
    const now = h.clock;
    const pass = (p, n) => tests.every(([t, v]) => {
      if (t === "-name") return globRe(v).test(basename(p));
      if (t === "-iname") return new RegExp(globRe(v).source, "i").test(basename(p));
      if (t === "-path") return globRe(v).test(p);
      if (t === "-type") return v === n.t;
      if (t === "-xtype") return v === "l" ? n.t === "l" && Boolean(h.lookup(p, "root").err) : v === n.t;
      if (t === "-user") return n.u === v;
      if (t === "-group") return n.g === v;
      if (t === "-size") {
        const m = /^([+-]?)(\d+)([kMG]?)$/.exec(v);
        if (!m) return false;
        const unit = { "": 512, k: 1024, M: MiB, G: GiB }[m[3]];
        const size = Math.ceil(h.sizeOf(n) / unit);
        return m[1] === "+" ? size > Number(m[2]) : m[1] === "-" ? size < Number(m[2]) : size === Number(m[2]);
      }
      if (t === "-mtime" || t === "-mmin") {
        const per = t === "-mtime" ? 86400000 : 60000;
        const age = Math.floor((now - (n.mt || now)) / per);
        const m = /^([+-]?)(\d+)$/.exec(v);
        return m && (m[1] === "+" ? age > Number(m[2]) : m[1] === "-" ? age < Number(m[2]) : age === Number(m[2]));
      }
      if (t === "-perm") {
        const sym = /^([-/])?(.*)$/.exec(v);
        const want = /^[0-7]+$/.test(sym[2]) ? parseInt(sym[2], 8) : parseMode(sym[2], 0, false, 0);
        return sym[1] === "-" ? (n.m & want) === want : sym[1] === "/" ? (n.m & want) !== 0 : (n.m & 0o7777) === want;
      }
      return true;
    });
    const out = [], err = [];
    for (const s of starts.length ? starts : ["."]) {
      const base = norm(s, c.cwd);
      const r = h.lookup(base, c.user);
      if (r.err) { err.push(`find: '${s}': ${ERR[r.err]}`); continue; }
      const shown = (p) => (p === r.path ? s : s.replace(/\/$/, "") + p.slice(r.path === "/" ? 0 : r.path.length));
      const all = [r.path, ...h.walk(r.path)].filter((p) => (p === r.path ? 0 : p.slice(r.path.length).split("/").length - 1) <= maxdepth);
      for (const p of all) {
        const n = h.fs.get(p) || r.node;
        const parent = h.fs.get(dirname(p));
        if (c.user !== "root" && p !== r.path && parent && !h.can(c.user, parent, 5)) continue;
        if (n.t === "d" && c.user !== "root" && !h.can(c.user, n, 4) && p !== r.path) err.push(`find: '${shown(p)}': ${ERR.EACCES}`);
        if (n.bulk && maxdepth > 0) {
          const b = n.bulk;
          const bnode = { t: "f", m: 0o600, u: b.u, g: b.g, size: b.each, mt: now - b.age * 86400000 };
          const fake = norm(b.prefix + "0001", p);
          if (pass(fake, bnode)) {
            if (action === "delete") {
              const e = c.user === "root" || h.can(c.user, n, 2) ? null : "EACCES";
              if (e) err.push(`find: cannot delete '${shown(fake)}': ${ERR[e]}`); else n.bulk = null;
            } else {
              out.push(...b.names.slice(0, 3).map((k) => shown(norm(k, p))));
              out.count = (out.count || out.length - 3) + b.n;
              c.term.push([`(… ${b.n.toLocaleString("en")} files in ${shown(p)}; the playground prints the first three)`, "dim"]);
            }
          }
        }
        if (!pass(p, n)) continue;
        if (action === "delete") {
          if (n.t === "d" && h.kids(p).length) continue;
          const e = removable(c, p);
          if (e) err.push(`find: cannot delete '${shown(p)}': ${ERR[e]}`); else unlink(h, p);
        } else if (action === "ls") {
          out.push(`${String(1000 + out.length).padStart(8)} ${String(Math.ceil(h.sizeOf(n) / 1024)).padStart(6)} ${modeStr(n)}   1 ${n.u.padEnd(8)} ${n.g.padEnd(8)} ${String(h.sizeOf(n)).padStart(11)} ${lsTime(n.mt || now, now)} ${shown(p)}`);
        } else if (action === "exec") {
          const res = exec(c, execCmd.map((x) => (x === "{}" ? shown(p) : x)), null);
          out.push(...res.out);
          err.push(...res.err);
        } else out.push(shown(p));
      }
    }
    return { out, err, code: err.length ? 1 : 0 };
  };

  // du: block usage, so a 1-byte file counts 4.0K. Bulk folders hold many small files.
  CMDS.du = (c, args) => {
    const { f, rest } = opts(args, "d");
    const h = c.h;
    const depth = f["max-depth"] != null ? Number(f["max-depth"]) : f.d != null ? Number(f.d) : f.s ? 0 : Infinity;
    const out = [], err = [];
    const fmt = (b) => (f.h ? human(b) : String(Math.ceil(b / 1024)));
    let grand = 0;
    const one = (s) => {
      const base = norm(s, c.cwd);
      const r = h.lookup(base, c.user);
      if (r.err) { err.push(`du: cannot access '${s}': ${ERR[r.err]}`); return; }
      const sizes = new Map();
      const add = (p, b) => { for (let q = p; ; q = dirname(q)) { sizes.set(q, (sizes.get(q) || 0) + b); if (q === r.path || q === "/") break; } };
      const xdev = h.mountOf(r.path);
      for (const p of [r.path, ...h.walk(r.path)]) {
        const n = h.fs.get(p) || r.node;
        if (f.x && h.mountOf(p) !== xdev) continue;
        if (c.user !== "root" && p !== r.path && !h.can(c.user, h.fs.get(dirname(p)), 5)) {
          if (!err.some((e) => e.includes(`'${dirname(p)}'`))) err.push(`du: cannot read directory '${s.replace(/\/$/, "")}${dirname(p).slice(r.path.length)}': ${ERR.EACCES}`);
          continue;
        }
        add(p, n.t === "f" ? Math.ceil(h.sizeOf(n) / 4096) * 4096 : n.t === "d" ? 4096 : 0);
        if (n.bulk) add(p, n.bulk.n * 4096);
      }
      // Each mount's unmodelled system files count under one folder (/usr on /).
      for (const m of h.mounts) {
        const dir = m.mnt === "/" ? "/usr" : m.mnt;
        if (m.gone || !m.base || !(dir === r.path || dir.startsWith(r.path === "/" ? "/" : r.path + "/")) || (f.x && m !== xdev)) continue;
        add(dir, m.base);
      }
      const rows = [...sizes].filter(([p]) => {
        const lvl = p === r.path ? 0 : p.slice(r.path === "/" ? 0 : r.path.length).split("/").length - 1;
        const n = h.fs.get(p);
        return lvl <= depth && (n && n.t === "d" || f.a || p === r.path);
      }).sort((a, b) => (a[0].length < b[0].length ? 1 : -1));
      for (const [p, b] of rows) out.push(`${fmt(b)}\t${p === r.path ? s : s.replace(/\/$/, "") + p.slice(r.path === "/" ? 0 : r.path.length)}`);
      grand += sizes.get(r.path) || 0;
    };
    for (const s of rest.length ? rest : ["."]) if (typeof s === "string") one(s); else err.push(`-bash: /usr/bin/du: ${ERR.E2BIG}`);
    if (f.c) out.push(`${fmt(grand)}\ttotal`);
    return { out, err, code: err.length ? 1 : 0 };
  };

  // sed: s/a/b/[g], /re/d, and -i to edit in place; scripts with ; or -e.
  function sedScript(expr) {
    return expr.split(/;(?![^/]*\/[gi]*$)/).map((e) => e.trim()).filter(Boolean).map((e) => {
      let m = /^(?:(\d+|\$)|\/((?:\\.|[^/])*)\/)?\s*s(.)((?:\\.|(?!\3).)*)\3((?:\\.|(?!\3).)*)\3([gI]*)$/.exec(e);
      if (m) return { kind: "s", line: m[1], addr: m[2], re: m[4], to: m[5], flags: m[6] };
      m = /^(?:(\d+|\$)|\/((?:\\.|[^/])*)\/)\s*([da])\s*(.*)$/.exec(e);
      if (m) return { kind: m[3], line: m[1], addr: m[2], text: m[4].replace(/^\\/, "") };
      m = /^(\d+|\$)?([aid])\s*\\?(.*)$/.exec(e);
      if (m && m[1]) return { kind: m[2], line: m[1], text: m[3] };
      return null;
    });
  }
  const bre = (s) => s.replace(/\\([(){}|+?])/g, "§$1").replace(/(^|[^§])([(){}|+?])/g, "$1\\$2").replace(/§([(){}|+?])/g, "$1");
  function sedRun(prog, src, extended) {
    let out = [...src];
    for (const p of prog) {
      const hit = (l, i) => (p.line ? (p.line === "$" ? i === out.length - 1 : i === Number(p.line) - 1) : p.addr ? new RegExp(extended ? p.addr : bre(p.addr)).test(l) : true);
      if (p.kind === "s") {
        const re = new RegExp(extended ? p.re : bre(p.re), (p.flags.includes("g") ? "g" : "") + (p.flags.includes("I") ? "i" : ""));
        const to = p.to.replace(/\\(\d)/g, "$$$1").replace(/(^|[^\\])&/g, "$1$$&").replace(/\\&/g, "&").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\//g, "/");
        out = out.flatMap((l, i) => (hit(l, i) ? l.replace(re, to).split("\n") : [l]));
      } else if (p.kind === "d") out = out.filter((l, i) => !hit(l, i));
      else if (p.kind === "a") out = out.flatMap((l, i) => (hit(l, i) ? [l, p.text] : [l]));
      else if (p.kind === "i") out = out.flatMap((l, i) => (hit(l, i) ? [p.text, l] : [l]));
    }
    return out;
  }
  CMDS.sed = (c, args, stdin) => {
    const h = c.h;
    const exprs = [];
    const rest = [];
    let inPlace = false, extended = false, quiet = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-i" || /^-i\S/.test(a) || a === "--in-place") inPlace = true;
      else if (a === "-e") exprs.push(args[++i]);
      else if (a === "-E" || a === "-r") extended = true;
      else if (a === "-n") quiet = true;
      else if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes("i")) inPlace = true; if (/[Er]/.test(a)) extended = true; } else rest.push(a);
    }
    if (!exprs.length) exprs.push(rest.shift());
    if (exprs[0] == null) return fail(["Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]..."], 1);
    const prog = exprs.flatMap((e) => sedScript(e));
    if (prog.some((p) => !p)) return fail(`sed: -e expression #1, char ${exprs[0].length}: unknown command: \`${exprs[0].trim()[0] || "?"}'`);
    if (quiet) return ok([]);
    let bad;
    try { sedRun(prog, [""], extended); } catch { bad = true; }
    if (bad) return fail(`sed: -e expression #1, char ${exprs[0].length}: Invalid preceding regular expression`);
    if (!inPlace) {
      const src = rest.length ? CMDS.cat(c, rest, null) : ok(stdin || []);
      return { ...src, out: sedRun(prog, src.out, extended) };
    }
    const err = [];
    for (const t of rest) {
      const path = norm(t, c.cwd);
      const r = h.lookup(path, c.user);
      if (r.err) { err.push(`sed: can't read ${t}: ${ERR[r.err]}`); continue; }
      if (!h.can(c.user, r.node, 4)) { err.push(`sed: couldn't open file ${t}: ${ERR.EACCES}`); continue; }
      // sed -i writes a temporary file beside the original, then renames it.
      const dir = h.fs.get(dirname(r.path));
      const ro = h.writable(r.path, 0, false);
      if (ro) { err.push(`sed: couldn't open temporary file ${dirname(r.path)}/sedXk3pQa: ${ERR[ro]}`); continue; }
      if (!h.can(c.user, dir, 2)) { err.push(`sed: couldn't open temporary file ${dirname(r.path)}/sedXk3pQa: ${ERR.EACCES}`); continue; }
      if (r.node.imm) { err.push(`sed: cannot rename ${dirname(r.path)}/sedXk3pQa: ${ERR.EPERM}`); continue; }
      const text = r.node.gen ? r.node.gen(h).join("\n") + "\n" : r.node.data || "";
      const endsNl = text.endsWith("\n");
      const next = sedRun(prog, text.replace(/\n$/, "").split("\n"), extended).join("\n") + (endsNl ? "\n" : "");
      delete r.node.gen;
      delete r.node.size;
      r.node.data = next;
      r.node.mt = h.clock;
      // The new file belongs to whoever ran sed.
      if (c.user !== "root") { r.node.u = c.user; r.node.g = h.primaryGroup(c.user); }
      if (root.LQSim.onWrite) root.LQSim.onWrite(h, r.path);
    }
    return { out: [], err, code: err.length ? 4 : 0 };
  };

  CMDS.tar = (c, args) => {
    const { f, rest } = opts(args.map((a, i) => (i === 0 && /^[a-zA-Z]+$/.test(a) ? "-" + a : a)), "fC");
    const h = c.h;
    if (!f.f) return fail("tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now", 2);
    const archive = norm(f.f, c.cwd);
    if (f.c) {
      const files = [];
      for (const t of rest) {
        const r = h.lookup(norm(t, c.cwd), c.user);
        if (r.err) return fail([`tar: ${t}: Cannot stat: ${ERR[r.err]}`, "tar: Exiting with failure status due to previous errors"], 2);
        for (const p of [r.path, ...h.walk(r.path)]) {
          const n = h.fs.get(p);
          if (n.t === "f" && !h.can(c.user, n, 4)) return fail([`tar: ${p.slice(1)}: Cannot open: ${ERR.EACCES}`, "tar: Exiting with failure status due to previous errors"], 2);
          files.push(t.replace(/\/$/, "") + p.slice(r.path.length) + (n.t === "d" ? "/" : ""));
        }
      }
      const size = files.reduce((s, p) => s + (h.fs.get(norm(p, c.cwd)) ? h.sizeOf(h.fs.get(norm(p.replace(/\/$/, ""), c.cwd))) : 0), 0);
      const e = h.writeFile(archive, "", c.user, false, c.umask);
      if (e) return fail([`tar: ${f.f}: Cannot open: ${ERR[e]}`, "tar: Error is not recoverable: exiting now"], 2);
      const n = h.fs.get(archive);
      n.tar = files;
      n.size = Math.round(size * (f.z ? 0.3 : 1)) + 10240;
      return ok(f.v ? files : []);
    }
    const r = h.lookup(archive, c.user);
    if (r.err) return fail([`tar: ${f.f}: Cannot open: ${ERR[r.err]}`, "tar: Error is not recoverable: exiting now"], 2);
    const list = r.node.tar || [];
    if (f.t) return ok(list);
    if (f.x) {
      const dest = norm(f.C || ".", c.cwd);
      for (const p of list) {
        const target = norm(p, dest);
        const e = p.endsWith("/") ? (h.fs.get(target) ? null : mkdirOne(c, target)) : h.writeFile(target, "", c.user, false, c.umask);
        if (e) return fail([`tar: ${p}: Cannot open: ${ERR[e]}`, "tar: Exiting with failure status due to previous errors"], 2);
      }
      return ok(f.v ? list : []);
    }
    return fail("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.", 2);
  };

  CMDS.sleep = (c, args) => {
    const s = Number(String(args[0] || "").replace(/s$/, "").replace(/m$/, "")) * (/m$/.test(args[0] || "") ? 60 : 1);
    if (!Number.isFinite(s) || s < 0) return fail([`sleep: invalid time interval '${args[0] || ""}'`, "Try 'sleep --help' for more information."]);
    c.h.tick(Math.min(s, 3600));
    return ok([], 0);
  };
  CMDS.env = (c, args) => {
    if (args.length && !args[0].includes("=") && args[0] !== "-i") return exec(c, args, null);
    let env = { ...c.env };
    const rest = [...args];
    if (rest[0] === "-i") { env = {}; rest.shift(); }
    while (rest.length && rest[0].includes("=")) { const [k, ...v] = rest.shift().split("="); env[k] = v.join("="); }
    if (rest.length) return exec({ ...c, env }, rest, null);
    return ok(Object.entries(env).map(([k, v]) => `${k}=${v}`));
  };
  CMDS.printenv = (c, args) => (args.length ? (c.env[args[0]] != null ? ok([c.env[args[0]]]) : fail([], 1)) : CMDS.env(c, []));
  CMDS.which = (c, args) => {
    const out = [];
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      const w = which({ ...c, env: c.env }, a);
      if (w && w.path) out.push(w.path);
    }
    return { out, err: [], code: out.length === args.filter((x) => !x.startsWith("-")).length ? 0 : 1 };
  };
  CMDS.whoami = (c) => ok([c.user]);
  CMDS.id = (c, args) => {
    const { f, rest } = opts(args);
    const name = rest[0] || c.user;
    const u = c.h.user(name);
    if (!u) return fail(`id: '${name}': no such user`);
    const gs = c.h.groups();
    const gid = (g) => (gs.find((x) => x.name === g) || { gid: g }).gid;
    // A running session keeps the groups it logged in with.
    const mine = !rest[0] && c.h.sess.groups && c.user === c.h.sess.user ? c.h.sess.groups : c.h.groupsOf(name);
    if (f.u) return ok([String(u.uid)]);
    if (f.g) return ok([String(u.gid)]);
    if (f.G) return ok([f.n ? mine.join(" ") : mine.map(gid).join(" ")]);
    return ok([`uid=${u.uid}(${name}) gid=${u.gid}(${c.h.primaryGroup(name)}) groups=${[...new Set(mine)].map((g) => `${gid(g)}(${g})`).join(",")}`]);
  };
  CMDS.groups = (c, args) => {
    if (!args.length) return ok([(c.h.sess.groups && c.user === c.h.sess.user ? c.h.sess.groups : c.h.groupsOf(c.user)).join(" ")]);
    return ok(args.map((n) => (c.h.user(n) ? `${n} : ${c.h.groupsOf(n).join(" ")}` : `groups: '${n}': no such user`)));
  };
  CMDS.date = (c, args) => {
    const h = c.h;
    if (args[0] === "-s" || args[0] === "--set") {
      if (c.user !== "root") return fail("date: cannot set date: Operation not permitted");
      const t = Date.parse(String(args[1] || "").replace(" ", "T") + "Z");
      if (Number.isNaN(t)) return fail(`date: invalid date '${args[1] || ""}'`);
      h.clock = t;
      if (root.LQSim.onClockSet) root.LQSim.onClockSet(h);
    }
    if (args[0] && args[0].startsWith("+")) return ok([args[0].slice(1).replace(/%F/g, isoDay(h.clock)).replace(/%T/g, hms(h.clock)).replace(/%s/g, String(Math.floor(h.clock / 1000)))]);
    const dd = d(h.clock);
    return ok([`${DAY[dd.getUTCDay()]} ${MON[dd.getUTCMonth()]} ${String(dd.getUTCDate()).padStart(2)} ${hms(h.clock)} UTC ${dd.getUTCFullYear()}`]);
  };
  CMDS.dos2unix = (c, args) => {
    const err = [];
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const r = c.h.lookup(norm(t, c.cwd), c.user);
      if (r.err) { err.push(`dos2unix: ${t}: ${ERR[r.err]}`, `dos2unix: problems converting file ${t}`); continue; }
      if (!c.h.can(c.user, r.node, 2)) { err.push(`dos2unix: Failed to open temporary output file: ${ERR.EACCES}`); continue; }
      r.node.data = (r.node.data || "").replace(/\r\n/g, "\n");
      err.push(`dos2unix: converting file ${t} to Unix format...`);
    }
    return { out: [], err, code: 0 };
  };
  // bash FILE runs a script without needing its execute bit; bash -c runs a line.
  CMDS.bash = CMDS.sh = (c, args) => {
    if (args[0] === "-c") {
      const term = [];
      // sh is dash on Ubuntu, which words its errors differently from bash.
      const code = runLine(c.h, args[1] || "", term, { ...c, script: c.name, line: 1, args: args.slice(2), own: { cwd: c.cwd }, cron: basename(c.name) === "sh" });
      return { out: term.filter(([, k]) => !k).map(([t]) => t), err: term.filter(([, k]) => k).map(([t]) => t), code };
    }
    if (!args.length) return { out: [], err: [], code: 0, notes: ["(you are already in a shell; the playground does not nest them)"] };
    const path = norm(args[0], c.cwd);
    const r = c.h.lookup(path, c.user);
    if (r.err) return fail(`${c.name}: ${args[0]}: ${ERR[r.err]}`, 127);
    if (!c.h.can(c.user, r.node, 4)) return fail(`${c.name}: ${args[0]}: ${ERR.EACCES}`, 126);
    return runScript({ ...c, name: args[0] }, path, r.node.data || "", args.slice(1));
  };
  CMDS["run-parts"] = (c, args) => {
    const dir = args.filter((a) => !a.startsWith("-"))[0] || "";
    const r = c.h.lookup(norm(dir, c.cwd), c.user);
    if (r.err) return fail(`run-parts: failed to open directory ${dir}: ${ERR[r.err]}`);
    return ok();
  };
  CMDS.clear = () => ok();
  CMDS.true = () => ok();
  CMDS.false = () => fail([], 1);

  root.LQSim = Object.assign(root.LQSim || {}, {
    Host, shell, lex, parse, exec, runLine, opts, which, CMDS, ERR, ELF, KiB, MiB, GiB,
    norm, dirname, basename, human, parseSize, parseMode, modeStr, stamp, longDate, hms, isoDay, lsTime, lines, ok, fail, table, unlink, removable
  });
})(typeof window !== "undefined" ? window : globalThis);
