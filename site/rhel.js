// DevOps Nimbus Linux simulator, part 3b: the Rocky Linux 9 profile. Same engine,
// different distribution: dnf and rpm, SELinux, firewalld, LVM with XFS,
// /var/log/messages and secure, wheel instead of sudo. Output follows
// Rocky 9.4 (dnf 4, firewalld 1.3, lvm2 2.03, xfsprogs 6.3).
"use strict";

(function (root) {
  const L = root.LQSim;
  const { CMDS, ok, fail, opts, norm, lines, GiB, MiB } = L;

  // --- SELinux --------------------------------------------------------------------------------

  // File context rules, most specific last; semanage fcontext -a adds local ones that win.
  const FCONTEXT = [
    [/^\/.*/, "default_t"], [/^\/etc(\/.*)?$/, "etc_t"], [/^\/usr(\/.*)?$/, "usr_t"], [/^\/srv(\/.*)?$/, "var_t"], [/^\/var(\/.*)?$/, "var_t"],
    [/^\/var\/log(\/.*)?$/, "var_log_t"], [/^\/tmp(\/.*)?$/, "tmp_t"], [/^\/home(\/.*)?$/, "user_home_t"], [/^\/var\/www(\/.*)?$/, "httpd_sys_content_t"],
    [/^\/usr\/share\/nginx\/html(\/.*)?$/, "httpd_sys_content_t"], [/^\/etc\/nginx(\/.*)?$/, "httpd_config_t"]
  ];
  const ruleType = (h, path) => {
    for (const [re, t] of [...h.fcontext].reverse()) if (new RegExp(`^${re}$`).test(path)) return t;
    let t = "default_t";
    for (const [re, tt] of FCONTEXT) if (re.test(path)) t = tt;
    return t;
  };
  // A file keeps the label it was created or moved with until restorecon resets it.
  const ctxOf = (h, path) => { const n = h.fs.get(path); return (n && n.ctx) || ruleType(h, path); };
  const label = (t) => `unconfined_u:object_r:${t}:s0`;
  const HTTPD_READ = ["httpd_sys_content_t", "httpd_sys_rw_content_t", "httpd_config_t", "usr_t", "etc_t"];

  // Does SELinux stop nginx (httpd_t) here? Logs the AVC denial like the kernel does.
  L.selinuxDenies = (h, what, perm) => {
    if (h.distro !== "rhel" || !h.selinux || h.selinux === "disabled") return false;
    const port = perm === "name_bind";
    const type = port ? (Object.entries(h.seports).find(([, ps]) => ps.includes(what)) || ["unreserved_port_t"])[0] : ctxOf(h, what);
    const allowed = port ? type === "http_port_t" : HTTPD_READ.includes(type);
    if (allowed) return false;
    const pid = (h.procs.find((p) => p.comm === "nginx") || { pid: 1312 }).pid;
    const t = (h.clock / 1000).toFixed(3);
    h.avc.push(`type=AVC msg=audit(${t}:${400 + h.avc.length}): avc:  denied  { ${perm === "read" ? "read" : "name_bind"} } for  pid=${pid} comm="nginx" ${port ? `src=${what}` : `name="${L.basename(what)}" dev="dm-0" ino=${33554000 + h.avc.length}`} scontext=system_u:system_r:httpd_t:s0 tcontext=${port ? `system_u:object_r:${type}:s0` : label(type)} tclass=${port ? "tcp_socket" : "file"} permissive=${h.selinux === "permissive" ? 1 : 0}`);
    return h.selinux === "enforcing";
  };

  CMDS.getenforce = (c) => ok([c.h.selinux[0].toUpperCase() + c.h.selinux.slice(1)]);
  CMDS.setenforce = (c, args) => {
    if (c.user !== "root") return fail("setenforce:  security_setenforce() failed:  Permission denied");
    if (!/^(0|1|permissive|enforcing)$/i.test(args[0] || "")) return fail("usage:  setenforce [ Enforcing | Permissive | 1 | 0 ]");
    c.h.selinux = /^(1|enforcing)$/i.test(args[0]) ? "enforcing" : "permissive";
    return ok();
  };
  CMDS.sestatus = (c) => ok(["SELinux status:                 enabled", "SELinuxfs mount:                /sys/fs/selinux", "SELinux root directory:         /etc/selinux",
    "Loaded policy name:             targeted", `Current mode:                   ${c.h.selinux}`, "Mode from config file:          enforcing", "Policy MLS status:              enabled",
    "Policy deny_unknown status:     allowed", "Memory protection checking:     actual (secure)", "Max kernel policy version:      33"]);
  CMDS.restorecon = (c, args) => {
    const { f, rest } = opts(args);
    const out = [], h = c.h;
    if (c.user !== "root") return fail(`restorecon: Could not set context for ${rest[0]}:  Permission denied`);
    for (const t of rest) {
      const r = h.lookup(norm(t, c.cwd), c.user);
      if (r.err) return fail(`restorecon: lstat(${t}) failed: ${L.ERR[r.err]}`);
      for (const p of [r.path, ...(f.R || f.r ? h.walk(r.path) : [])]) {
        const before = ctxOf(h, p), after = ruleType(h, p);
        h.fs.get(p).ctx = undefined;
        if (before !== after && f.v) out.push(`Relabeled ${p} from ${label(before)} to ${label(after)}`);
      }
    }
    return ok(out);
  };
  CMDS.chcon = (c, args) => {
    const { f, rest } = opts(args, "t");
    if (c.user !== "root") return fail(`chcon: failed to change context of '${rest[0]}' to '${label(f.t)}': Operation not permitted`);
    for (const t of rest) {
      const r = c.h.lookup(norm(t, c.cwd), c.user);
      if (r.err) return fail(`chcon: cannot access '${t}': ${L.ERR[r.err]}`);
      for (const p of [r.path, ...(f.R ? c.h.walk(r.path) : [])]) c.h.fs.get(p).ctx = f.t;
    }
    return ok();
  };
  CMDS.semanage = (c, args) => {
    const h = c.h;
    const [obj, ...rest] = args;
    const { f, rest: pos } = opts(rest, "tp");
    if (c.user !== "root") return fail("ValueError: SELinux policy is not managed or store cannot be accessed.");
    if (obj === "fcontext") {
      if (f.l) return ok(["SELinux fcontext                                   type               Context", ...h.fcontext.map(([re, t]) => `${re.padEnd(50)} all files          ${label(t)}`)]);
      if (!f.a || !f.t || !pos[0]) return fail("usage: semanage fcontext [-h] [-n] [-N] [-S STORE] [ --add ( -t TYPE -f FTYPE -r RANGE -s SEUSER | -e EQUAL ) FILE_SPEC ...");
      h.fcontext.push([pos[0], f.t]);
      return ok();
    }
    if (obj === "port") {
      if (f.l) return ok(Object.entries(h.seports).map(([t, ps]) => `${t.padEnd(28)} tcp      ${ps.join(", ")}`));
      const port = Number(pos[0]);
      if (!f.a || !f.t || !port) return fail("usage: semanage port [-h] [-n] [-N] [-S STORE] [ --add -t TYPE -p PROTOCOL -r RANGE port_name | port_range ...");
      const owner = Object.entries(h.seports).find(([, ps]) => ps.includes(port));
      if (owner) return fail(`ValueError: Port tcp/${port} already defined`);
      (h.seports[f.t] = h.seports[f.t] || []).push(port);
      return ok();
    }
    return fail("usage: semanage [-h] {import,export,login,user,port,ibpkey,ibendport,interface,module,node,fcontext,boolean,permissive,dontaudit} ...");
  };
  CMDS.ausearch = (c) => {
    if (c.user !== "root") return fail("Error opening /var/log/audit/audit.log (Permission denied)");
    const avc = c.h.avc;
    if (!avc.length) return fail("<no matches>");
    const d = new Date(c.h.clock);
    const when = `${L.longDate(c.h.clock).slice(0, 3)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${L.hms(c.h.clock)} ${d.getUTCFullYear()}`;
    return ok(avc.flatMap((l) => ["----", `time->${when}`, l]));
  };

  // --- firewalld -------------------------------------------------------------------------------

  const SERVICES = { ssh: 22, http: 80, https: 443, "dhcpv6-client": 546, cockpit: 9090 };
  L.firewalldAllows = (h, port) => {
    if (!L.isUp(h, "firewalld.service")) return true;
    const z = h.fwd.runtime;
    return z.ports.includes(port) || z.services.some((s) => SERVICES[s] === port);
  };
  CMDS["firewall-cmd"] = (c, args) => {
    const h = c.h;
    if (!L.isUp(h, "firewalld.service")) return fail("FirewallD is not running", 252);
    if (c.user !== "root" && !args.includes("--state") && !args.some((a) => /^--(list|get|query)/.test(a))) return fail("Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.", 252);
    const perm = args.includes("--permanent");
    const zone = perm ? h.fwd.permanent : h.fwd.runtime;
    const out = [];
    for (const a of args) {
      const [k, v] = a.split("=");
      if (k === "--state") out.push("running");
      else if (k === "--reload") { h.fwd.runtime = JSON.parse(JSON.stringify(h.fwd.permanent)); out.push("success"); }
      else if (k === "--runtime-to-permanent") { h.fwd.permanent = JSON.parse(JSON.stringify(h.fwd.runtime)); out.push("success"); }
      else if (k === "--add-port" || k === "--remove-port") {
        const m = /^(\d+)\/(tcp|udp)$/.exec(v || "");
        if (!m) return fail(`Error: INVALID_PORT: ${v}`, 102);
        const p = Number(m[1]);
        if (k === "--add-port") { if (zone.ports.includes(p)) out.push(`Warning: ALREADY_ENABLED: ${v}`); else zone.ports.push(p); } else zone.ports = zone.ports.filter((x) => x !== p);
        out.push("success");
      } else if (k === "--add-service" || k === "--remove-service") {
        if (!SERVICES[v]) return fail(`Error: INVALID_SERVICE: ${v}`, 101);
        if (k === "--add-service") { if (!zone.services.includes(v)) zone.services.push(v); } else zone.services = zone.services.filter((x) => x !== v);
        out.push("success");
      } else if (k === "--list-ports") out.push(zone.ports.map((p) => `${p}/tcp`).join(" "));
      else if (k === "--list-services") out.push(zone.services.join(" "));
      else if (k === "--get-active-zones") out.push("public", "  interfaces: eth0");
      else if (k === "--list-all") {
        out.push("public (active)", "  target: default", "  icmp-block-inversion: no", "  interfaces: eth0", "  sources: ", `  services: ${zone.services.join(" ")}`, `  ports: ${zone.ports.map((p) => `${p}/tcp`).join(" ")}`,
          "  protocols: ", "  forward: yes", "  masquerade: no", "  forward-ports: ", "  source-ports: ", "  icmp-blocks: ", "  rich rules: ");
      }
    }
    return ok([...new Set(out)].length === 1 && out[0] === "success" ? ["success"] : out.filter((x, i) => x !== "success" || i === out.lastIndexOf("success")));
  };

  // --- LVM and XFS -------------------------------------------------------------------------------

  const gib = (b) => `${(b / GiB).toFixed(2)}g`;
  const lvPath = (a) => (a || "").replace(/^\/dev\/mapper\/rl-/, "/dev/rl/");
  CMDS.pvs = (c) => (c.user !== "root" ? fail("  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/P_global:aux: open failed: Permission denied", 5)
    : ok(["  PV             VG Fmt  Attr PSize   PFree  ", `  /dev/nvme0n1p2 rl lvm2 a--  ${gib(c.h.lvm.size).padStart(7)} ${gib(c.h.lvm.size - c.h.lvm.lvs.reduce((s, l) => s + l.size, 0)).padStart(6)}`]));
  CMDS.vgs = (c) => (c.user !== "root" ? fail("  /run/lock/lvm/P_global:aux: open failed: Permission denied", 5)
    : ok(["  VG #PV #LV #SN Attr   VSize   VFree  ", `  rl   1   ${c.h.lvm.lvs.length}   0 wz--n- ${gib(c.h.lvm.size).padStart(7)} ${gib(c.h.lvm.size - c.h.lvm.lvs.reduce((s, l) => s + l.size, 0)).padStart(6)}`]));
  CMDS.lvs = (c) => (c.user !== "root" ? fail("  /run/lock/lvm/P_global:aux: open failed: Permission denied", 5)
    : ok(["  LV   VG Attr       LSize  ", ...c.h.lvm.lvs.map((l) => `  ${l.name.padEnd(4)} rl -wi-ao---- ${gib(l.size).padStart(7)}`)]));
  CMDS.lvextend = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args, "Ll");
    if (c.user !== "root") return fail("  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/V_rl:aux: open failed: Permission denied", 5);
    const lv = h.lvm.lvs.find((l) => lvPath(rest[0]) === `/dev/rl/${l.name}`);
    if (!lv) return fail(`  Volume group "${(rest[0] || "").split("/")[2] || ""}" not found\n  Cannot process volume group ${(rest[0] || "").split("/")[2] || ""}`, 5);
    const free = h.lvm.size - h.lvm.lvs.reduce((s, l) => s + l.size, 0);
    const ext = (b) => Math.round(b / (4 * MiB));
    let add;
    if (f.l) add = /100%FREE/.test(f.l) ? free : Number(String(f.l).replace("+", "")) * 4 * MiB;
    else if (f.L) { const m = /^(\+?)(\d+(?:\.\d+)?)([GgMm])$/.exec(f.L); if (!m) return fail(`  Invalid argument for --size: ${f.L}`, 3); const b = Number(m[2]) * (/g/i.test(m[3]) ? GiB : MiB); add = m[1] ? b : b - lv.size; }
    else return fail("  Please specify either size or extents but not both.", 3);
    if (add <= 0) return fail(`  New size given (${ext(lv.size + add)} extents) not larger than existing size (${ext(lv.size)} extents)`, 5);
    if (add > free + 1) return fail(`  Insufficient free space: ${ext(add)} extents needed, but only ${ext(free)} available`, 5);
    const old = lv.size;
    lv.size += add;
    const out = [`  Size of logical volume rl/${lv.name} changed from ${(old / GiB).toFixed(2)} GiB (${ext(old)} extents) to ${(lv.size / GiB).toFixed(2)} GiB (${ext(lv.size)} extents).`, `  Logical volume rl/${lv.name} successfully resized.`];
    if (f.r || f.resizefs) out.push(...growXfs(h, lv));
    return ok(out);
  };
  function growXfs(h, lv) {
    const m = h.mounts.find((x) => x.dev === `/dev/mapper/rl-${lv.name}` && !x.gone);
    const blocks = (b) => Math.floor(b / 4096);
    const old = m.size;
    m.size = lv.size;
    return [`meta-data=/dev/mapper/rl-${lv.name}    isize=512    agcount=4, agsize=${blocks(old) / 4} blks`, "         =                       sectsz=512   attr=2, projid32bit=1",
      `data     =                       bsize=4096   blocks=${blocks(old)}, imaxpct=25`, `data blocks changed from ${blocks(old)} to ${blocks(lv.size)}`];
  }
  CMDS.xfs_growfs = (c, args) => {
    const h = c.h;
    const target = args.filter((a) => !a.startsWith("-"))[0] || "";
    const m = h.mounts.find((x) => !x.gone && (x.mnt === norm(target, c.cwd) || x.dev === target || lvPath(x.dev) === lvPath(target)));
    if (!m) return fail(`xfs_growfs: ${target} is not a mounted XFS filesystem`);
    if (m.type !== "xfs") return fail(`xfs_growfs: ${target} is not a mounted XFS filesystem`);
    if (c.user !== "root") return fail(`xfs_growfs: cannot open ${m.dev}: Permission denied`);
    const lv = h.lvm.lvs.find((l) => m.dev === `/dev/mapper/rl-${l.name}`);
    if (!lv || lv.size <= m.size) {
      const blocks = Math.floor(m.size / 4096);
      return ok([`meta-data=${m.dev}    isize=512    agcount=4, agsize=${blocks / 4} blks`, `data     =                       bsize=4096   blocks=${blocks}, imaxpct=25`]);
    }
    return ok(growXfs(h, lv));
  };

  // --- dnf and rpm ------------------------------------------------------------------------------

  const repoOf = (h, name) => { const p = h.pkgs.repo[name]; return p && (!p.repo || p.repo !== "epel" || h.pkgs.installed["epel-release"]) ? p : null; };
  const expiry = (h) => {
    const d = new Date(h.clock - 761000), hr = d.getUTCHours();
    const t = `${String(hr % 12 || 12).padStart(2, "0")}:${L.hms(d.getTime()).slice(3)} ${hr < 12 ? "AM" : "PM"}`;
    return `Last metadata expiration check: 0:12:41 ago on ${L.longDate(d.getTime()).slice(0, 3)} ${String(d.getUTCDate()).padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()} ${t} UTC.`;
  };
  CMDS.dnf = CMDS.yum = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    const [verb, ...names] = rest;
    if (["install", "remove", "erase", "update", "upgrade", "makecache"].includes(verb) && c.user !== "root") return fail("Error: This command has to be run with superuser privileges (under the root user on most systems).", 1);
    const r = L.resolve(h, "mirrors.rockylinux.org");
    if (!r.ip && verb !== "list" && verb !== "history") return fail(["Errors during downloading metadata for repository 'baseos':", "  - Curl error (6): Couldn't resolve host name for https://mirrors.rockylinux.org/mirrorlist?arch=x86_64&repo=BaseOS-9 [Could not resolve host: mirrors.rockylinux.org]", "Error: Failed to download metadata for repo 'baseos': Cannot prepare internal mirrorlist: Curl error (6): Couldn't resolve host name"], 1);
    const bar = "=".repeat(80);
    switch (verb) {
      case "repolist": return ok(["repo id                         repo name", "appstream                       Rocky Linux 9 - AppStream", "baseos                          Rocky Linux 9 - BaseOS",
        ...(h.pkgs.installed["epel-release"] ? ["epel                            Extra Packages for Enterprise Linux 9 - x86_64"] : []), "extras                          Rocky Linux 9 - Extras"]);
      case "makecache": return ok(["Rocky Linux 9 - BaseOS                          2.1 MB/s | 2.3 MB     00:01", "Rocky Linux 9 - AppStream                       9.4 MB/s | 8.1 MB     00:00", "Metadata cache created."]);
      case "search": return ok([expiry(h), `============================ Name Matched: ${names[0]} ============================`, ...Object.keys(h.pkgs.repo).filter((n) => n.includes(names[0] || "") && repoOf(h, n)).map((n) => `${n}.x86_64 : ${h.pkgs.repo[n].desc || n}`)]);
      case "info": { const p = repoOf(h, names[0]); return p ? ok([expiry(h), "Available Packages", `Name         : ${names[0]}`, `Version      : ${p.ver.split("-")[0]}`, `Repository   : ${p.repo || "appstream"}`, `Summary      : ${p.desc || names[0]}`]) : fail([expiry(h), "Error: No matching Packages to list"]); }
      case "list": return ok(["Installed Packages", ...Object.entries(h.pkgs.installed).filter(([n]) => !names.length || names.includes(n)).map(([n, v]) => `${(n + ".x86_64").padEnd(40)} ${v.padEnd(26)} @anaconda`)]);
      case "history": return ok(["ID     | Command line              | Date and time    | Action(s)      | Altered", "-------------------------------------------------------------------------------", "     2 | update -y                 | 2026-10-28 06:12 | Upgrade        |   14", "     1 |                           | 2026-10-01 08:00 | Install        |  412 EE"]);
      case "update": case "upgrade": case "check-update": return ok([expiry(h), "Dependencies resolved.", "Nothing to do.", "Complete!"]);
      case "install": {
        const missing = names.filter((n) => !h.pkgs.installed[n] && !repoOf(h, n));
        if (missing.length) return fail([expiry(h), ...missing.map((n) => `No match for argument: ${n}`), `Error: Unable to find a match: ${missing.join(" ")}`], 1);
        const add = names.filter((n) => !h.pkgs.installed[n]);
        if (!add.length) return ok([expiry(h), ...names.map((n) => `Package ${n}-${h.pkgs.installed[n]}.x86_64 is already installed.`), "Dependencies resolved.", "Nothing to do.", "Complete!"]);
        const out = [expiry(h), "Dependencies resolved.", bar, " Package              Architecture   Version                  Repository      Size", bar, "Installing:",
          ...add.map((n) => ` ${n.padEnd(20)} ${"x86_64".padEnd(14)} ${h.pkgs.repo[n].ver.padEnd(24)} ${(h.pkgs.repo[n].repo || "appstream").padEnd(15)} ${h.pkgs.repo[n].kb || 186} k`),
          "", "Transaction Summary", bar, `Install  ${add.length} Package${add.length > 1 ? "s" : ""}`, ""];
        if (!f.y && !f.assumeyes) out.push("Is this ok [y/N]: y");
        out.push("Downloading Packages:", "Running transaction check", "Transaction check succeeded.", "Running transaction test", "Transaction test succeeded.", "Running transaction");
        for (const n of add) {
          const p = h.pkgs.repo[n];
          out.push(`  Installing       : ${n}-${p.ver}.x86_64`.padEnd(70) + "1/1");
          h.pkgs.installed[n] = p.ver;
          for (const b of p.bins || []) h.bin(b);
          if (p.install) out.push(...(p.install(h) || []));
        }
        return ok([...out, "", "Installed:", ...add.map((n) => `  ${n}-${h.pkgs.repo[n].ver}.x86_64`), "", "Complete!"]);
      }
      case "remove": case "erase": {
        const out = [];
        for (const n of names) {
          if (!h.pkgs.installed[n]) { out.push(`No match for argument: ${n}`); continue; }
          delete h.pkgs.installed[n];
          const p = h.pkgs.repo[n] || {};
          if (p.remove) p.remove(h);
          for (const b of p.bins || []) h.fs.delete(b);
          out.push(`  Erasing          : ${n}`);
        }
        return ok([...out, "Complete!"]);
      }
      default: return fail(`No such command: ${verb}. Please use /usr/bin/dnf --help`, 1);
    }
  };
  CMDS.rpm = (c, args) => {
    const h = c.h;
    const { f, rest } = opts(args);
    if (f.q && f.a) return ok(Object.entries(h.pkgs.installed).map(([n, v]) => `${n}-${v}.x86_64`));
    if (f.q && f.f) { const p = Object.entries(h.pkgs.repo).find(([, v]) => (v.bins || []).includes(norm(rest[0] || "", c.cwd))); return p ? ok([`${p[0]}-${p[1].ver}.x86_64`]) : fail(`file ${rest[0]} is not owned by any package`); }
    if (f.q) return ok(rest.map((n) => (h.pkgs.installed[n] ? (f.i ? `Name        : ${n}\nVersion     : ${h.pkgs.installed[n].split("-")[0]}\nRelease     : ${h.pkgs.installed[n].split("-")[1] || "1.el9"}` : `${n}-${h.pkgs.installed[n]}.x86_64`) : `package ${n} is not installed`)).join("\n").split("\n"));
    return fail("rpm: no operation specified", 1);
  };

  // --- the profile --------------------------------------------------------------------------------

  const UNITS = {
    "sshd.service": "[Unit]\nDescription=OpenSSH server daemon\nDocumentation=man:sshd(8) man:sshd_config(5)\nAfter=network.target sshd-keygen.target\n\n[Service]\nType=notify\nExecStart=/usr/sbin/sshd -D $OPTIONS\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
    "crond.service": "[Unit]\nDescription=Command Scheduler\nAfter=auditd.service nss-user-lookup.target systemd-user-sessions.service time-sync.target ypbind.service autofs.service\n\n[Service]\nExecStart=/usr/sbin/crond -n $CRONDARGS\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
    "chronyd.service": "[Unit]\nDescription=NTP client/server\nDocumentation=man:chronyd(8) man:chrony.conf(5)\n\n[Service]\nType=forking\nExecStart=/usr/sbin/chronyd $OPTIONS\n\n[Install]\nWantedBy=multi-user.target\n",
    "firewalld.service": "[Unit]\nDescription=firewalld - dynamic firewall daemon\nBefore=network-pre.target\nDocumentation=man:firewalld(1)\n\n[Service]\nType=dbus\nBusName=org.fedoraproject.FirewallD1\nExecStart=/usr/sbin/firewalld --nofork --nopid\n\n[Install]\nWantedBy=multi-user.target\n"
  };
  L.rhel = (h) => {
    Object.assign(h, { distro: "rhel", defaultUser: "rocky", webUser: "nginx", cronUnit: "crond.service", hostname: "app-01", kernel: "5.14.0-427.13.1.el9_4.x86_64", selinux: "enforcing",
      fcontext: [], avc: [], seports: { http_port_t: [80, 81, 443, 488, 8008, 8009, 8443, 9000], ssh_port_t: [22] } });
    h.fwd = { runtime: { services: ["cockpit", "dhcpv6-client", "ssh"], ports: [] } };
    h.fwd.permanent = JSON.parse(JSON.stringify(h.fwd.runtime));
    h.net.ifaces[1].ip = "10.0.1.20/24";
    const swap = (path, from, to) => { const n = h.fs.get(path); n.data = n.data.split("\n").map((l) => l.replace(from, to)).join("\n"); };
    swap("/etc/passwd", /^ubuntu:x:1000:1000:Ubuntu:\/home\/ubuntu:/, "rocky:x:1000:1000:Cloud User:/home/rocky:");
    swap("/etc/passwd", /^www-data:x:33:33:www-data:\/var\/www:/, "nginx:x:991:991:Nginx web server:/var/lib/nginx:");
    h.fs.get("/etc/group").data = "root:x:0:\nwheel:x:10:rocky\nadm:x:4:\nsystemd-journal:x:190:\npostgres:x:120:\nnginx:x:991:\nrocky:x:1000:\napp:x:1001:\nchrony:x:992:\n";
    h.fs.get("/etc/shadow").data = h.read("/etc/passwd").split("\n").filter(Boolean).map((l) => `${l.split(":")[0]}:!!:20000:0:99999:7:::`).join("\n") + "\n";
    h.file("/etc/hostname", "app-01\n");
    h.file("/etc/hosts", "127.0.0.1   localhost localhost.localdomain localhost4 localhost4.localdomain4\n::1         localhost localhost.localdomain localhost6 localhost6.localdomain6\n10.0.1.20   app-01\n");
    h.file("/etc/os-release", 'NAME="Rocky Linux"\nVERSION="9.4 (Blue Onyx)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n');
    h.file("/etc/redhat-release", "Rocky Linux release 9.4 (Blue Onyx)\n");
    h.file("/etc/sudoers", "Defaults   !visiblepw\nDefaults    always_set_home\nDefaults    secure_path = /sbin:/bin:/usr/sbin:/usr/bin\nroot\tALL=(ALL) \tALL\n%wheel\tALL=(ALL)\tALL\n@includedir /etc/sudoers.d\n", { m: 0o440 });
    h.file("/etc/sudoers.d/90-cloud-init-users", "# Created by cloud-init v. 23.4 on Thu, 01 Oct 2026 08:00:12 +0000\n\n# User rules for rocky\nrocky ALL=(ALL) NOPASSWD:ALL\n", { m: 0o440 });
    h.fs.delete("/etc/sudoers.d/README");
    h.file("/etc/selinux/config", "# This file controls the state of SELinux on the system.\nSELINUX=enforcing\nSELINUXTYPE=targeted\n");
    h.file("/etc/fstab", "/dev/mapper/rl-root     /                       xfs     defaults        0 0\nUUID=3e2a91c4-7b0f-4c1d-9a5e-61f2d8b0c7a3 /boot  xfs     defaults        0 0\n");
    for (const p of [...h.walk("/home/ubuntu"), "/home/ubuntu"]) h.fs.delete(p);
    h.dir("/home/rocky", { u: "rocky", g: "rocky", m: 0o700 });
    h.file("/home/rocky/.bashrc", "# .bashrc\nif [ -f /etc/bashrc ]; then\n\t. /etc/bashrc\nfi\n", { u: "rocky", g: "rocky" });
    h.file("/home/rocky/.bash_profile", "# .bash_profile\nif [ -f ~/.bashrc ]; then\n\t. ~/.bashrc\nfi\n", { u: "rocky", g: "rocky" });
    h.dir("/home/rocky/.ssh", { u: "rocky", g: "rocky", m: 0o700 });
    for (const p of ["/var/log/syslog", "/var/log/auth.log", "/var/log/kern.log", "/var/log/dpkg.log", "/var/log/syslog.2.gz", "/var/log/syslog.3.gz", "/var/log/auth.log.2.gz", "/etc/ufw/ufw.conf", "/etc/netplan/50-cloud-init.yaml"]) h.fs.delete(p);
    const fmt = (hh, e) => `${L.stamp(e.t)} ${hh.hostname} ${e.ident}${e.pid ? `[${e.pid}]` : ""}: ${e.msg}`;
    h.fs.get("/var/log").g = "root";
    h.file("/var/log/messages", "", { m: 0o600, gen: (hh) => hh.journal.filter((e) => !/^(sshd|sudo|CROND)$/.test(e.ident)).sort((a, b) => a.t - b.t).map((e) => fmt(hh, e)) });
    h.file("/var/log/secure", "", { m: 0o600, gen: (hh) => hh.journal.filter((e) => /^(sshd|sudo|su)$/.test(e.ident)).sort((a, b) => a.t - b.t).map((e) => fmt(hh, e)) });
    h.file("/var/log/cron", "", { m: 0o600, gen: (hh) => hh.journal.filter((e) => e.ident === "CROND").sort((a, b) => a.t - b.t).map((e) => fmt(hh, e)) });
    h.dir("/var/log/audit", { m: 0o700 });
    h.file("/var/log/audit/audit.log", "", { m: 0o600, gen: (hh) => hh.avc });
    h.dir("/usr/share/nginx/html");
    h.file("/usr/share/nginx/html/index.html", "<!doctype html>\n<title>app-01</title>\n<h1>Rocky Linux</h1>\n");
    h.fs.delete("/var/www/html/index.html");
    // systemd units: sshd, crond, chronyd and firewalld instead of ssh, cron and timesyncd.
    for (const n of ["ssh.service", "cron.service", "systemd-timesyncd.service"]) { h.fs.delete(`/usr/lib/systemd/system/${n}`); h.fs.delete(`/etc/systemd/system/multi-user.target.wants/${n}`); }
    for (const [n, t] of Object.entries(UNITS)) { h.file(`/usr/lib/systemd/system/${n}`, t); h.link(`/etc/systemd/system/multi-user.target.wants/${n}`, `/usr/lib/systemd/system/${n}`); }
    for (const b of ["/usr/sbin/crond", "/usr/sbin/chronyd", "/usr/sbin/firewalld"]) h.bin(b);
    h.apps["/usr/sbin/crond"] = () => ({ ident: "crond", proc: { comm: "crond", args: "/usr/sbin/crond -n", rss: 3400, lead: true }, log: ["(CRON) STARTUP (1.5.7)", "(CRON) INFO (running with inotify support)"] });
    h.apps["/usr/sbin/chronyd"] = () => ({ ident: "chronyd", proc: { comm: "chronyd", args: "/usr/sbin/chronyd -F 2", user: "chrony", rss: 3900 }, log: ["chronyd version 4.5 starting (+CMDMON +NTP +REFCLOCK +RTC +PRIVDROP +SCFILTER +SIGND +ASYNCDNS +NTS +SECHASH +IPV6 +DEBUG)", "Selected source 169.254.169.123"] });
    h.apps["/usr/sbin/firewalld"] = () => ({ ident: "firewalld", proc: { comm: "firewalld", args: "/usr/bin/python3 -s /usr/sbin/firewalld --nofork --nopid", rss: 44000 } });
    // Disks: /boot, then LVM volume group rl with an XFS root.
    h.disks = [{ name: "nvme0n1", size: 50 * GiB, parts: [
      { name: "nvme0n1p1", size: GiB, fs: "xfs", uuid: "3e2a91c4-7b0f-4c1d-9a5e-61f2d8b0c7a3", used: 280 * MiB },
      { name: "nvme0n1p2", size: 49 * GiB, fs: "LVM2_member", uuid: "Xq2kTc-4F8n-Gm1w-9pRz-hY3d-Lk7v-Bc0eQa" }] }];
    h.lvm = { size: 49 * GiB, lvs: [{ name: "root", size: 20 * GiB }] };
    h.mounts = [
      { dev: "/dev/mapper/rl-root", mnt: "/", type: "xfs", size: 20 * GiB, base: 4.2 * GiB, inodes: 10485760, ibase: 151000, opts: "rw,relatime,seclabel" },
      { dev: "/dev/nvme0n1p1", mnt: "/boot", type: "xfs", size: GiB, base: 280 * MiB, inodes: 524288, ibase: 360, opts: "rw,relatime,seclabel" }];
    h.pkgs = {
      installed: { bash: "5.1.8-9.el9", coreutils: "8.32-35.el9", dnf: "4.14.0-9.el9", "openssh-server": "8.7p1-38.el9", cronie: "1.5.7-11.el9", systemd: "252-32.el9_4", firewalld: "1.3.4-1.el9",
        "policycoreutils-python-utils": "3.6-2.1.el9", lvm2: "2.03.23-2.el9", xfsprogs: "6.3.0-1.el9", curl: "7.76.1-29.el9_4", "bind-utils": "9.16.23-18.el9_4.1", lsof: "4.94.0-3.el9", chrony: "4.5-1.el9", sudo: "1.9.5p2-10.el9_3" },
      repo: {
        "epel-release": { ver: "9-8.el9", repo: "extras", kb: 19, desc: "Extra Packages for Enterprise Linux repository configuration", install: (hh) => { hh.file("/etc/yum.repos.d/epel.repo", "[epel]\nname=Extra Packages for Enterprise Linux 9 - $basearch\nmetalink=https://mirrors.fedoraproject.org/metalink?repo=epel-9&arch=$basearch\nenabled=1\ngpgcheck=1\n"); } },
        htop: { ver: "3.3.0-1.el9", repo: "epel", bins: ["/usr/bin/htop"], desc: "Interactive process viewer" },
        jq: { ver: "1.6-16.el9", repo: "appstream", bins: ["/usr/bin/jq"], kb: 186, desc: "Command-line JSON processor" },
        nginx: { ver: "1.20.1-14.el9_2.1", repo: "appstream", bins: ["/usr/sbin/nginx"], desc: "A high performance web server and reverse proxy server" },
        tree: { ver: "1.8.0-10.el9", repo: "baseos", bins: [], desc: "File system tree viewer" },
        "fail2ban": { ver: "1.0.2-12.el9", repo: "epel", bins: [], desc: "Daemon to ban hosts that cause multiple authentication errors" }
      }
    };
    h.world.records["mirrors.rockylinux.org"] = "151.101.2.132";
    h.world.records["dl.rockylinux.org"] = "151.101.2.132";
    h.world.hosts["151.101.2.132"] = { name: "mirrors.rockylinux.org", ports: { 443: { code: 200 } }, rtt: 9.8 };
    h.procs = [];
    L.world.system(h);
  };
  L.rhelLabel = ctxOf;
})(typeof window !== "undefined" ? window : globalThis);
