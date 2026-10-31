// DevOps Nimbus Linux simulator, part 2b: day-to-day admin tools with their own
// state: logrotate, journal files, the effective sshd configuration and
// fail2ban, NFS mounts, swap files, and TLS certificates.
"use strict";

(function (root) {
  const L = root.LQSim;
  const { CMDS, ok, fail, opts, norm, dirname, basename, lines, human, GiB, MiB } = L;

  // --- logrotate --------------------------------------------------------------------------------

  // Parse one logrotate file into stanzas: {paths, opts: {copytruncate, su, rotate, ...}}.
  function stanzas(text) {
    const out = [];
    let cur = null;
    for (const raw of lines(text)) {
      const l = raw.replace(/#.*/, "").trim();
      if (!l) continue;
      const head = /^(.+?)\s*\{$/.exec(l);
      if (head) { cur = { paths: head[1].split(/\s+/), opts: {} }; out.push(cur); continue; }
      if (l === "}") { cur = null; continue; }
      if (!cur) continue;
      if (cur.script != null) { if (l === "endscript") { cur.opts.postrotate = cur.script; cur.script = null; } else cur.script.push(l); continue; }
      if (l === "postrotate") { cur.script = []; continue; }
      const [k, ...v] = l.split(/\s+/);
      cur.opts[k] = v.length ? v.join(" ") : true;
    }
    return out;
  }
  // Rotate one log the way logrotate does: rename (or copy and truncate), then compress.
  function rotate(h, path, o) {
    const n = h.fs.get(path);
    if (!n || !h.sizeOf(n)) return [];
    const size = h.sizeOf(n);
    const out = [`rotating log ${path}, log->rotateCount is ${o.rotate || 4}`];
    for (const k of h.kids(dirname(path)).filter((k) => k.startsWith(basename(path) + ".")).sort().reverse()) h.fs.delete(norm(k, dirname(path)));
    if (o.copytruncate) {
      h.file(`${path}.1${o.compress ? ".gz" : ""}`, "", { u: n.u, g: n.g, m: n.m, size: o.compress ? Math.round(size / 9) : size });
      n.size = 0; n.data = "";
      out.push(`copying ${path} to ${path}.1`, `truncating ${path}`);
    } else {
      // Renaming keeps the writer's file handle on the old file, now called .1.
      h.fs.delete(path);
      h.fs.set(`${path}.1`, n);
      for (const p of h.procs) for (const fd of p.fds) if (fd.path === path) fd.path = `${path}.1`;
      out.push(`renaming ${path} to ${path}.1`);
      if (o.create) h.file(path, "", { u: n.u, g: n.g, m: n.m });
      if (o.compress) {
        L.unlink(h, `${path}.1`);
        h.file(`${path}.1.gz`, "", { u: n.u, g: n.g, m: n.m, size: Math.round(size / 9) });
        out.push(`compressing log with: /usr/bin/gzip`);
      }
    }
    for (const cmd of o.postrotate || []) L.runLine(h, cmd, [], { h, user: "root", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, cwd: "/", umask: 0o022, args: [], script: "logrotate", line: 1, own: { cwd: "/" } });
    return out;
  }
  CMDS.logrotate = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    const conf = rest[0] || "/etc/logrotate.conf";
    const files = conf === "/etc/logrotate.conf" ? h.kids("/etc/logrotate.d").map((k) => `/etc/logrotate.d/${k}`) : [norm(conf, c.cwd)];
    const out = [], err = [];
    if (c.user !== "root" && !f.d) return fail(`error: error setting owner of /var/lib/logrotate/status.tmp to uid 0 and gid 0: Operation not permitted`);
    for (const file of files) {
      const text = h.read(file);
      if (text == null) { err.push(`error: stat of ${file} failed: No such file or directory`); continue; }
      out.push(`reading config file ${file}`);
      for (const s of stanzas(text)) {
        const paths = s.paths.flatMap((p) => (p.includes("*") ? h.kids(dirname(p)).filter((k) => new RegExp("^" + basename(p).replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(k)).map((k) => norm(k, dirname(p))) : [p]));
        for (const p of paths) {
          const dir = h.fs.get(dirname(p));
          out.push(`considering log ${p}`);
          // logrotate refuses folders others can write to unless told which user to act as.
          if (dir && ((dir.m & 0o002) || ((dir.m & 0o020) && dir.g !== "root")) && !s.opts.su) {
            err.push(`error: skipping "${p}" because parent directory has insecure permissions (It's world writable or writable by group which is not "root") Set "su" directive in config file to tell logrotate which user/group should be used for rotation.`);
            continue;
          }
          const n = h.fs.get(p);
          if (!n) { if (!s.opts.missingok) err.push(`error: stat of ${p} failed: No such file or directory`); continue; }
          const due = f.f || (s.opts.size && h.sizeOf(n) >= L.parseSize(String(s.opts.size).toUpperCase().replace(/([KMG])$/, "$1")));
          if (!due) { out.push("  log does not need rotating (log has been rotated at 2026-10-30 0:0, which is less than a day ago)"); continue; }
          if (f.d) { out.push("  log needs rotating", `  (dry run) would rotate ${p}`); continue; }
          out.push(...rotate(h, p, s.opts));
        }
      }
    }
    return { out: f.v || f.d ? out : [], err, code: err.length ? 1 : 0 };
  };

  // --- the journal on disk ---------------------------------------------------------------------

  const JDIR = "/var/log/journal/ec2a1f3e9c6b4d0f8e21a7c35d90b1f4";
  const journalFiles = (h) => h.kids(JDIR).map((k) => `${JDIR}/${k}`);
  const journalBytes = (h) => journalFiles(h).reduce((s, p) => s + h.sizeOf(h.fs.get(p)), 0);
  // Delete archived journal files, oldest first, until the rest fits.
  function vacuum(h, limit) {
    const out = [];
    let total = journalBytes(h);
    for (const p of journalFiles(h).filter((p) => p.includes("@")).sort()) {
      if (total <= limit) break;
      const size = h.sizeOf(h.fs.get(p));
      L.unlink(h, p);
      total -= size;
      out.push(`Deleted archived journal ${p} (${human(size)}).`);
    }
    return out;
  }
  const maxUse = (h) => { const m = /^\s*SystemMaxUse\s*=\s*(\S+)/m.exec(h.read("/etc/systemd/journald.conf") || ""); return m ? L.parseSize(m[1].replace(/([KMG])$/i, "$1")) : null; };
  L.journal = { files: journalFiles, bytes: journalBytes, vacuum, maxUse, dir: JDIR };

  // --- sshd's effective configuration, and fail2ban ------------------------------------------------

  // Like sshd -T: the first value read wins, and Include comes first in Ubuntu's sshd_config.
  function sshdConfig(h) {
    const seen = {};
    const read = (path) => {
      for (const raw of lines(h.read(path) || "")) {
        const l = raw.replace(/#.*/, "").trim();
        if (!l) continue;
        const [k, ...v] = l.split(/\s+/);
        if (/^include$/i.test(k)) { for (const pat of v) { const dir = dirname(pat); for (const f of h.kids(dir).filter((x) => x.endsWith(".conf")).sort()) read(`${dir}/${f}`); } continue; }
        if (!(k.toLowerCase() in seen)) seen[k.toLowerCase()] = v.join(" ");
      }
    };
    read("/etc/ssh/sshd_config");
    return { passwordauthentication: "yes", permitrootlogin: "without-password", pubkeyauthentication: "yes", kbdinteractiveauthentication: "no", maxauthtries: "6", port: "22", ...seen };
  }
  L.sshdConfig = sshdConfig;
  CMDS.sshd = (c, args) => {
    if (c.user !== "root") return fail("sshd: no hostkeys available -- exiting.");
    const bad = lines(c.h.read("/etc/ssh/sshd_config") || "").findIndex((l) => /^\s*[A-Za-z]+/.test(l) && !/^\s*(Include|Port|PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication|UsePAM|X11Forwarding|PrintMotd|AcceptEnv|Subsystem|MaxAuthTries|AllowUsers|AllowGroups|ClientAliveInterval|LoginGraceTime)\b/i.test(l));
    if (bad >= 0) return fail(`/etc/ssh/sshd_config line ${bad + 1}: Bad configuration option: ${lines(c.h.read("/etc/ssh/sshd_config"))[bad].trim().split(/\s+/)[0]}\n/etc/ssh/sshd_config: terminating, 1 bad configuration options`, 255);
    if (args.includes("-T")) return ok(Object.entries(sshdConfig(c.h)).map(([k, v]) => `${k} ${v}`));
    if (args.includes("-t")) return ok();
    return fail("(sshd runs as a service here: sudo systemctl reload ssh)");
  };
  CMDS["fail2ban-client"] = (c, args) => {
    const h = c.h;
    if (c.user !== "root") return fail("ERROR  Permission denied to socket: /var/run/fail2ban/fail2ban.sock, (you must be root)");
    if (!L.isUp(h, "fail2ban.service")) return fail("ERROR  Failed to access socket path: /var/run/fail2ban/fail2ban.sock. Is fail2ban running?", 255);
    const banned = h.f2bBanned || [];
    if (args[0] === "status" && args[1] === "sshd") {
      return ok(["Status for the jail: sshd", "|- Filter", `|  |- Currently failed:\t${Math.min(9, h.sshFails || 0)}`, `|  |- Total failed:\t${h.sshFails || 0}`, "|  `- Journal matches:\t_SYSTEMD_UNIT=sshd.service + _COMM=sshd",
        "`- Actions", `   |- Currently banned:\t${banned.length}`, `   |- Total banned:\t${banned.length}`, `   \`- Banned IP list:\t${banned.join(" ")}`]);
    }
    if (args[0] === "status") return ok(["Status", "|- Number of jail:\t1", "`- Jail list:\tsshd"]);
    return fail("Usage: fail2ban-client [OPTIONS] <COMMAND>");
  };

  // --- NFS ------------------------------------------------------------------------------------------

  // Mount an NFS export from /etc/fstab; the server must answer.
  L.nfsMount = (h, e) => {
    const [server, exp] = e.spec.split(":");
    const r = L.resolve(h, server);
    const host = r.ip && h.world.hosts[r.ip];
    if (!host || !host.nfs || host.down) return `mount.nfs4: Connection timed out`;
    const prev = h.mounts.find((m) => m.mnt === e.mnt);
    if (prev) h.mounts = h.mounts.filter((m) => m !== prev);
    h.hasNfs = true;
    h.mounts.push({ dev: `${server}:${exp}`, mnt: e.mnt, type: "nfs4", nfs: true, size: 500 * GiB, base: 121 * GiB, inodes: 0, opts: e.opts, server });
    return null;
  };
  // umount on NFS: -f aborts pending requests, -l detaches now. Waiting processes get EIO.
  L.nfsUmount = (h, m, f) => {
    const inside = (p) => p === m.mnt || p.startsWith(m.mnt + "/");
    const busy = h.procs.some((p) => (p.cwd && inside(p.cwd)) || p.fds.some((fd) => inside(fd.path)) || p.nfs === m.mnt);
    if (busy && !f.l && !f.f) return `umount.nfs4: ${m.mnt}: device is busy`;
    if (m.hung && f.f && !f.l) return `umount.nfs4: ${m.mnt}: device is busy`;
    m.gone = true;
    for (const p of h.procs.filter((x) => x.nfs === m.mnt)) L.die(h, p, "exit");
    return null;
  };

  // --- swap files -----------------------------------------------------------------------------------

  CMDS.fallocate = (c, args) => {
    const { f, rest } = opts(args, "l");
    const size = L.parseSize(String(f.l || "").toUpperCase());
    if (!size || !rest[0]) return fail(["fallocate: no length argument specified", "Try 'fallocate --help' for more information."]);
    const path = norm(rest[0], c.cwd);
    const e = c.h.writeFile(path, "", c.user, false, c.umask) || c.h.writable(path, size, false, c.user);
    if (e) return fail(`fallocate: ${rest[0]}: ${e === "ENOSPC" ? "fallocate failed: No space left on device" : L.ERR[e]}`);
    c.h.fs.get(path).size = size;
    return ok();
  };
  CMDS.mkswap = (c, args) => {
    const path = norm(args.filter((a) => !a.startsWith("-"))[0] || "", c.cwd);
    const r = c.h.lookup(path, c.user);
    if (r.err) return fail(`mkswap: cannot open ${path}: ${L.ERR[r.err]}`);
    if (!c.h.can(c.user, r.node, 2)) return fail(`mkswap: cannot open ${path}: Permission denied`);
    r.node.swap = true;
    const size = c.h.sizeOf(r.node);
    const out = [];
    if (r.node.m & 0o077) out.push(`mkswap: ${path}: insecure permissions 0${(r.node.m & 0o777).toString(8)}, fix with: chmod 0600 ${path}`);
    return ok([...out, `Setting up swapspace version 1, size = ${human(size - 4096).replace(/([KMG])$/, " $1iB")} (${size - 4096} bytes)`, "no label, UUID=6b1f0e2a-55d3-4c8e-9f17-0a2c4d9b3e71"]);
  };

  // smem: memory per process; USS is what freeing the process would give back.
  CMDS.smem = (c, args) => {
    const { f } = opts(args, "s");
    const list = c.h.procs.filter((p) => !p.thread && p.stat !== "Z" && (c.user === "root" || p.user === c.user)).sort((a, b) => a.rss - b.rss);
    if (f.r) list.reverse();
    const k = (v) => (f.k ? human(v * 1024) : String(v));
    return ok(["  PID User     Command                         Swap      USS      PSS      RSS ", ...list.map((p) => `${String(p.pid).padStart(5)} ${p.user.slice(0, 8).padEnd(8)} ${p.args.slice(0, 31).padEnd(31)} ${k(0).padStart(8)} ${k(Math.round(p.rss * 0.93)).padStart(8)} ${k(Math.round(p.rss * 0.96)).padStart(8)} ${k(p.rss).padStart(8)} `)]);
  };

  // --- TLS certificates ----------------------------------------------------------------------------

  const certOf = (h, path) => { const n = h.fs.get(path); return n && n.cert; };
  const certDate = (ms) => { const d = new Date(ms); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${L.hms(ms)} ${d.getUTCFullYear()} GMT`; };
  CMDS.openssl = (c, args) => {
    const h = c.h;
    if (args[0] === "x509") {
      const file = args[args.indexOf("-in") + 1];
      const r = h.lookup(norm(file || "", c.cwd), c.user);
      if (r.err) return fail([`Could not open file or uri for loading certificate from ${file}`, `${L.ERR[r.err]}`]);
      if (!h.can(c.user, r.node, 4)) return fail([`Could not open file or uri for loading certificate from ${file}`, "Permission denied"]);
      const cert = r.node.cert;
      if (!cert) return fail(["Could not read certificate from " + file, "Unable to load certificate"]);
      const out = [];
      if (args.includes("-subject")) out.push(`subject=CN = ${cert.cn}`);
      if (args.includes("-dates") || args.includes("-startdate")) out.push(`notBefore=${certDate(cert.notAfter - 90 * 86400000)}`);
      if (args.includes("-dates") || args.includes("-enddate")) out.push(`notAfter=${certDate(cert.notAfter)}`);
      if (args.includes("-checkend")) { const s = Number(args[args.indexOf("-checkend") + 1]) || 0; return cert.notAfter > h.clock + s * 1000 ? ok([...out, "Certificate will not expire"]) : { out: [...out, "Certificate will expire"], err: [], code: 1 }; }
      return ok(out);
    }
    if (args[0] === "s_client") {
      const p = L.listener(h, "127.0.0.1", 443);
      if (!p || !p.cert) return fail("40F7C3B2B57F0000:error:8000006F:system library:BIO_connect:Connection refused:../crypto/bio/bio_sock2.c:114:calling connect()\nconnect:errno=111");
      const expired = p.cert.notAfter < h.clock;
      return ok(["CONNECTED(00000003)", `depth=0 CN = ${p.cert.cn}`, ...(expired ? ["verify error:num=10:certificate has expired", `notAfter=${certDate(p.cert.notAfter)}`] : []), "---", `Verify return code: ${expired ? "10 (certificate has expired)" : "0 (ok)"}`]);
    }
    return fail("Invalid command; type \"help\" for a list.");
  };
  CMDS.certbot = (c, args) => {
    const h = c.h;
    if (c.user !== "root") return fail("The following error was encountered:\n[Errno 13] Permission denied: '/var/log/letsencrypt/.certbot.lock'\nEither run as root, or set --config-dir, --work-dir, and --logs-dir to writeable paths.");
    const certs = h.kids("/etc/letsencrypt/live").map((d) => ({ name: d, path: `/etc/letsencrypt/live/${d}/fullchain.pem` }));
    if (args[0] === "certificates") {
      return ok(["Saving debug log to /var/log/letsencrypt/letsencrypt.log", "", "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -", "Found the following certs:",
        ...certs.flatMap((x) => { const ce = certOf(h, x.path); const days = Math.floor((ce.notAfter - h.clock) / 86400000); return [`  Certificate Name: ${x.name}`, `    Domains: ${ce.cn}`, `    Expiry Date: ${new Date(ce.notAfter).toISOString().replace("T", " ").slice(0, 19)}+00:00 (${days < 0 ? "INVALID: EXPIRED" : `VALID: ${days} days`})`, `    Certificate Path: ${x.path}`]; })]);
    }
    if (args[0] === "renew") {
      const out = ["Saving debug log to /var/log/letsencrypt/letsencrypt.log", "", "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -"];
      for (const x of certs) {
        const ce = certOf(h, x.path);
        out.push(`Processing /etc/letsencrypt/renewal/${x.name}.conf`, "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -");
        if (ce.notAfter - h.clock > 30 * 86400000 && !args.includes("--force-renewal")) { out.push(`Certificate not yet due for renewal`); continue; }
        ce.notAfter = h.clock + 90 * 86400000;
        out.push("Renewing an existing certificate for " + ce.cn, "", "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -", "Congratulations, all renewals succeeded: ", `  ${x.path} (success)`);
      }
      return ok([...out, "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -"]);
    }
    return fail("certbot: error: unrecognized arguments");
  };
  L.certOf = certOf;
})(typeof window !== "undefined" ? window : globalThis);
