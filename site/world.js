// Linux Quest simulator, part 3: the machine every scenario starts from.
// web-01 is an Ubuntu 24.04 server on a private network, with ssh, cron and
// the time service running, a few neighbours, and a DNS resolver.
"use strict";

(function (root) {
  const L = root.LQSim;
  const { GiB, MiB } = L;

  // Where each simulated command lives, as on Ubuntu 24.04.
  const SBIN = ["useradd", "usermod", "userdel", "groupadd", "visudo", "ufw", "iptables", "fsck", "e2fsck", "fsck.ext4", "resize2fs", "swapon", "swapoff",
    "sysctl", "reboot", "shutdown", "ip", "blkid", "iotop", "nginx"];
  const NOT_BINARIES = ["sudo", "dos2unix", "nginx"];

  const PASSWD = ["root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin", "bin:x:2:2:bin:/bin:/usr/sbin/nologin",
    "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin", "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    "systemd-timesync:x:996:996:systemd Time Synchronization:/:/usr/sbin/nologin", "syslog:x:104:111::/nonexistent:/usr/sbin/nologin",
    "sshd:x:105:65534::/run/sshd:/usr/sbin/nologin", "postgres:x:113:120:PostgreSQL administrator,,,:/var/lib/postgresql:/bin/bash",
    "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash", "app:x:1001:1001::/srv/app:/usr/sbin/nologin"];
  const GROUP = ["root:x:0:", "adm:x:4:syslog,ubuntu", "tty:x:5:", "sudo:x:27:ubuntu", "www-data:x:33:", "crontab:x:101:", "systemd-journal:x:999:",
    "syslog:x:111:", "postgres:x:120:", "systemd-timesync:x:996:", "nogroup:x:65534:", "ubuntu:x:1000:", "app:x:1001:"];

  const UNITS = {
    "ssh.service": "[Unit]\nDescription=OpenBSD Secure Shell server\nDocumentation=man:sshd(8) man:sshd_config(5)\nAfter=network.target auditd.service\n\n[Service]\nExecStartPre=/usr/sbin/sshd -t\nExecStart=/usr/sbin/sshd -D $SSHD_OPTS\nRestart=on-failure\nType=notify\n\n[Install]\nWantedBy=multi-user.target\n",
    "cron.service": "[Unit]\nDescription=Regular background program processing daemon\nDocumentation=man:cron(8)\nAfter=remote-fs.target nss-user-lookup.target\n\n[Service]\nExecStart=/usr/sbin/cron -f -P\nKillMode=process\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
    "systemd-timesyncd.service": "[Unit]\nDescription=Network Time Synchronization\nDocumentation=man:systemd-timesyncd.service(8)\n\n[Service]\nType=notify\nExecStart=/usr/lib/systemd/systemd-timesyncd\nUser=systemd-timesync\nRestart=always\n\n[Install]\nWantedBy=sysinit.target multi-user.target\n",
    "nginx.service": "[Unit]\nDescription=A high performance web server and a reverse proxy server\nDocumentation=man:nginx(8)\nAfter=network-online.target remote-fs.target nss-lookup.target\nWants=network-online.target\n\n[Service]\nType=forking\nPIDFile=/run/nginx.pid\nExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'\nExecStart=/usr/sbin/nginx -g 'daemon on; master_process on;'\nExecReload=/usr/sbin/nginx -g 'daemon on; master_process on;' -s reload\nTimeoutStopSec=5\nKillMode=mixed\n\n[Install]\nWantedBy=multi-user.target\n",
    "postgresql.service": "[Unit]\nDescription=PostgreSQL RDBMS\nAfter=network.target\n\n[Service]\nType=notify\nUser=postgres\nExecStart=/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf\nExecReload=/bin/kill -HUP $MAINPID\n\n[Install]\nWantedBy=multi-user.target\n"
  };

  // A service on a TCP port. check(h, x) returns log lines when it cannot start.
  function service(o) {
    return (h, x) => {
      const port = Number(x.env.PORT || o.port);
      const bind = x.env.BIND || o.bind || "0.0.0.0";
      const bad = o.check && o.check(h, x);
      if (bad) return { ident: o.ident, fail: { code: o.code || 1, log: [].concat(bad) } };
      if (port && portBusy(h, port, bind)) return { ident: o.ident, fail: { code: 1, log: [o.busy ? o.busy(bind, port) : `Error: listen EADDRINUSE: address already in use ${bind}:${port}`] } };
      return { ident: o.ident, proc: { rss: o.rss || 96000, vsz: (o.rss || 96000) * 4, cpu: o.cpu || 0.4, listen: port ? [{ addr: bind, port, fd: 18 }] : [], http: o.http, fds: (o.fds || []).map((f) => ({ ...f })), ...(o.proc ? o.proc(h, x) : {}) },
        kids: o.kids, log: o.log ? o.log(h, x, bind, port) : [`listening on ${bind}:${port}`], ready: o.ready ? o.ready(h, x) : 0 };
    };
  }
  function portBusy(h, port, bind) {
    return h.procs.some((p) => p.listen.some((l) => l.port === port && (l.addr === "0.0.0.0" || bind === "0.0.0.0" || l.addr === bind)));
  }

  // nginx serves files as www-data from the root in its site file.
  function nginxConf(h) {
    const conf = h.kids("/etc/nginx/sites-enabled").map((k) => h.read(`/etc/nginx/sites-enabled/${k}`) || "").join("\n");
    return { port: Number((/listen\s+(\d+)/.exec(conf) || [, 80])[1]), root: (/root\s+([^;]+);/.exec(conf) || [, "/var/www/html"])[1] };
  }
  const page = (code, text) => ({ code, body: ["<html>", `<head><title>${code} ${text}</title></head>`, "<body>", `<center><h1>${code} ${text}</h1></center>`, "<hr><center>nginx/1.24.0 (Ubuntu)</center>", "</body>", "</html>"] });
  function nginxHttp(h, path) {
    const conf = nginxConf(h);
    const want = L.norm(path.split("?")[0], "/");
    let r = h.lookup(L.norm("." + want, conf.root), "www-data");
    if (r.node && r.node.t === "d") r = h.lookup(L.norm("index.html", r.path), "www-data");
    if (r.err === "EACCES") return page(403, "Forbidden");
    if (r.err) return page(404, "Not Found");
    if (!h.can("www-data", r.node, 4)) return page(403, "Forbidden");
    return { code: 200, body: r.node.gen ? r.node.gen(h) : L.lines(r.node.data || "") };
  }
  const nginx = (h) => {
    const conf = nginxConf(h);
    if (portBusy(h, conf.port, "0.0.0.0")) {
      return { ident: "nginx", fail: { code: 1, log: [...Array(5).fill(`nginx: [emerg] bind() to 0.0.0.0:${conf.port} failed (98: Address already in use)`), "nginx: [emerg] still could not bind()"] } };
    }
    return { ident: "nginx", proc: { comm: "nginx", args: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", rss: 6200, lead: true, listen: [{ addr: "0.0.0.0", port: conf.port, fd: 6 }], http: nginxHttp, onReload: () => null },
      kids: [{ comm: "nginx", args: "nginx: worker process", user: "www-data", rss: 5100 }, { comm: "nginx", args: "nginx: worker process", user: "www-data", rss: 5100 }] };
  };

  // nginx -t checks the configuration; -s reload asks the master to reread it.
  L.CMDS.nginx = (c, args) => {
    if (c.user !== "root") return L.fail(['nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)', "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", '2026/10/30 09:14:02 [emerg] 4120#4120: open() "/run/nginx.pid" failed (13: Permission denied)', "nginx: configuration file /etc/nginx/nginx.conf test failed"]);
    if (args.includes("-t")) return { out: [], err: ["nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", "nginx: configuration file /etc/nginx/nginx.conf test is successful"], code: 0 };
    if (args.includes("-s")) {
      const p = c.h.procs.find((x) => x.comm === "nginx" && x.lead);
      if (!p) return L.fail(['nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)']);
      if (p.onReload) p.onReload(c.h, p);
      return L.ok();
    }
    if (args.includes("-v")) return { out: [], err: ["nginx version: nginx/1.24.0 (Ubuntu)"], code: 0 };
    return L.fail("(start nginx with: sudo systemctl start nginx)");
  };

  function world(h) {
    h.hostname = "web-01";
    h.kernel = "6.8.0-1015-aws";
    h.cpus = 2;
    h.mem = { total: 4005748, kernel: 330 * 1024, cache: 1300 * 1024, swap: 0, swapBase: 0 };
    h.sysctlDefaults = { "net.ipv4.ip_forward": "0", "vm.swappiness": "60", "fs.file-max": "9223372036854775807", "kernel.dmesg_restrict": "1", "net.core.somaxconn": "4096", "vm.overcommit_memory": "0", "net.ipv4.conf.default.rp_filter": "2", "net.ipv4.conf.all.rp_filter": "2" };
    h.sysctl = { ...h.sysctlDefaults };
    h.net = {
      ifaces: [{ name: "lo", ip: "127.0.0.1/8", mtu: 65536, up: true }, { name: "eth0", ip: "10.0.1.10/24", mtu: 9001, mac: "0a:4f:3c:91:7e:21", up: true }],
      routes: [{ dst: "default", via: "10.0.1.1", dev: "eth0" }, { dst: "10.0.1.0/24", dev: "eth0" }],
      fw: { active: false, enabled: false, rules: [] }
    };
    const web = { 80: { code: 200, body: ["<!doctype html><title>Example Domain</title>"] }, 443: { code: 200, body: ["<!doctype html><title>Example Domain</title>"] } };
    h.world = {
      dns: { "10.0.0.2": { needsDefault: false } },
      records: { "archive.ubuntu.com": "91.189.91.83", "security.ubuntu.com": "185.125.190.36", "api.payments.example": "203.0.113.10", "db.internal": "10.0.2.40",
        "db-01": "10.0.2.40", "db-01.internal": "10.0.2.40", "lb-01": "10.0.1.5", "ci-runner": "10.0.1.30", "git.internal": "10.0.1.20", "example.com": "93.184.215.14",
        "s3.amazonaws.com": "52.216.0.10", "ntp.ubuntu.com": "185.125.190.58" },
      hosts: {
        "91.189.91.83": { name: "archive.ubuntu.com", ports: { 80: { code: 200, body: ["Index of /ubuntu"] } }, rtt: 18.2 },
        "203.0.113.10": { name: "api.payments.example", ports: { 443: { code: 200, type: "application/json", body: ['{"status":"ok"}'] } }, rtt: 24.6 },
        "93.184.215.14": { name: "example.com", ports: web, rtt: 11.4 },
        "8.8.8.8": { name: "dns.google", ports: {}, rtt: 1.9 },
        "1.1.1.1": { name: "one.one.one.one", ports: {}, rtt: 1.4 },
        "10.0.0.2": { name: "resolver", ports: {}, rtt: 0.3 },
        "10.0.1.1": { name: "gateway", ports: {}, rtt: 0.2 },
        "10.0.1.5": { name: "lb-01", ports: { 80: { code: 200 } }, rtt: 0.4 },
        "10.0.2.40": { name: "db-01", ports: { 5432: {} }, rtt: 0.5, ssh: { users: ["deploy"], key: "~/.ssh/id_ed25519" } },
        "52.216.0.10": { name: "s3", ports: { 443: { code: 200 } }, rtt: 8.1 }
      }
    };
    h.disks = [{ name: "nvme0n1", size: 20 * GiB, parts: [
      { name: "nvme0n1p1", size: 20 * GiB - 108 * MiB, fs: "ext4", label: "cloudimg-rootfs", uuid: "5f3a6c1e-9b2d-4f57-8e1a-0c7d2b9e4a61", used: 5.9 * GiB, inodes: 1310720, iused: 182000 },
      { name: "nvme0n1p15", size: 105 * MiB, fs: "vfat", label: "UEFI", uuid: "B1C4-7E2D", used: 6 * MiB, inodes: 0 }] }];
    h.mounts = [
      { dev: "/dev/nvme0n1p1", mnt: "/", type: "ext4", size: 20 * GiB - 108 * MiB, base: 5.9 * GiB, inodes: 1310720, ibase: 182000, opts: "rw,relatime" },
      { dev: "/dev/nvme0n1p15", mnt: "/boot/efi", type: "vfat", size: 105 * MiB, base: 6 * MiB, inodes: 0, opts: "rw,relatime" }];
    h.pkgs = {
      installed: { bash: "5.2.21-2ubuntu4", coreutils: "9.4-3ubuntu6", "openssh-server": "1:9.6p1-3ubuntu13.5", cron: "3.0pl1-184ubuntu2", systemd: "255.4-1ubuntu8.4", "util-linux": "2.39.3-9ubuntu6.1",
        iproute2: "6.1.0-1ubuntu6", curl: "8.5.0-2ubuntu10.4", "bind9-dnsutils": "1:9.18.28-0ubuntu0.24.04.1", lsof: "4.95.0-1build3", ufw: "0.36.2-6", sudo: "1.9.15p5-3ubuntu5", iotop: "0.6-42-ga14256a-0.2", htop: "3.3.0-4build1" },
      repo: {
        "dos2unix": { ver: "7.5.1-1", bins: ["/usr/bin/dos2unix"], desc: "convert text file line endings between CRLF and LF" },
        jq: { ver: "1.7.1-3build1", bins: ["/usr/bin/jq"], desc: "lightweight and flexible command-line JSON processor", kb: 65 },
        "net-tools": { ver: "2.10-0.1ubuntu4", bins: [], desc: "NET-3 networking toolkit" },
        sysstat: { ver: "12.6.1-2", bins: [], desc: "system performance tools for Linux" },
        nginx: { ver: "1.24.0-2ubuntu7.1", bins: ["/usr/sbin/nginx"], desc: "small, powerful, scalable web/proxy server" },
        tree: { ver: "2.1.1-2ubuntu3", bins: [], desc: "displays an indented directory tree, in color" },
        "systemd-timesyncd": { ver: "255.4-1ubuntu8.4", bins: [], desc: "minimalistic service to synchronize local time with NTP servers" }
      }
    };

    for (const [name] of Object.entries(L.CMDS)) {
      if (!L.CMDS[name] || NOT_BINARIES.includes(name)) continue;
      h.bin(`${SBIN.includes(name) ? "/usr/sbin" : "/usr/bin"}/${name}`);
    }
    h.bin("/usr/bin/sudo", { m: 0o4755 });
    for (const b of ["echo", "printf", "pwd", "test", "kill", "bash", "sh", "dash", "gzip", "tail"]) h.bin(`/usr/bin/${b}`);
    h.bin("/usr/sbin/sshd");
    h.bin("/usr/sbin/cron");
    h.bin("/usr/lib/systemd/systemd-timesyncd");
    h.bin("/usr/lib/postgresql/16/bin/postgres");
    h.link("/bin", "usr/bin");
    h.link("/sbin", "usr/sbin");
    h.link("/lib", "usr/lib");
    h.put("/dev/null", { t: "c", m: 0o666 });
    h.dir("/usr/local/bin");
    h.dir("/usr/local/sbin");
    h.dir("/tmp", { m: 0o1777 });
    h.dir("/var/tmp", { m: 0o1777 });
    h.dir("/root", { m: 0o700 });
    h.dir("/proc", { m: 0o555 });
    h.dir("/run", { m: 0o755 });
    h.link("/var/run", "/run");
    h.file("/etc/sysctl.conf", "#\n# /etc/sysctl.conf - Configuration file for setting system variables\n# See /etc/sysctl.d/ for additional system variables.\n\n# Uncomment the next line to enable packet forwarding for IPv4\n#net.ipv4.ip_forward=1\n");
    h.file("/etc/sysctl.d/10-network-security.conf", "# Turn on Source Address Verification in all interfaces to\n# prevent some spoofing attacks.\nnet.ipv4.conf.default.rp_filter=2\nnet.ipv4.conf.all.rp_filter=2\n");
    h.dir("/var/spool/cron/crontabs", { g: "crontab", m: 0o1730 });
    h.file("/etc/hostname", "web-01\n");
    h.file("/etc/os-release", 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\n');
    h.file("/etc/passwd", PASSWD.join("\n") + "\n");
    h.file("/etc/group", GROUP.join("\n") + "\n");
    h.file("/etc/shadow", PASSWD.map((l) => `${l.split(":")[0]}:*:20000:0:99999:7:::`).join("\n") + "\n", { g: "shadow", m: 0o640 });
    h.file("/etc/hosts", "127.0.0.1 localhost\n127.0.1.1 web-01\n\n# The following lines are desirable for IPv6 capable hosts\n::1 ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n");
    h.file("/etc/resolv.conf", "# Written by the provisioning script. This server does not run systemd-resolved.\nnameserver 10.0.0.2\nsearch internal\n");
    h.file("/etc/nsswitch.conf", "passwd:         files systemd\ngroup:          files systemd\nshadow:         files\nhosts:          files dns\n");
    h.file("/etc/fstab", "LABEL=cloudimg-rootfs\t/\t ext4\tdiscard,commit=30,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n");
    h.file("/etc/profile", "# /etc/profile: system-wide .profile file for the Bourne shell (sh(1))\nif [ -d /etc/profile.d ]; then\n  for i in /etc/profile.d/*.sh; do . $i; done\nfi\n");
    h.file("/etc/login.defs", "UMASK\t\t022\nUSERGROUPS_ENAB yes\n");
    h.file("/etc/security/limits.conf", "# /etc/security/limits.conf\n#\n# Applies to login sessions through PAM. systemd services do not read this file.\n#<domain>      <type>  <item>         <value>\n#*               soft    core            0\n");
    h.file("/etc/sudoers", "Defaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin\"\nDefaults\tuse_pty\n\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n", { m: 0o440 });
    h.file("/etc/sudoers.d/90-cloud-init-users", "# Created by cloud-init v. 24.2 on Thu, 01 Oct 2026 08:00:12 +0000\n\n# User rules for ubuntu\nubuntu ALL=(ALL) NOPASSWD:ALL\n", { m: 0o440 });
    h.file("/etc/sudoers.d/README", "# Files in this directory with a '.' or '~' in their name are skipped.\n", { m: 0o440 });
    h.file("/etc/crontab", "# /etc/crontab: system-wide crontab\nSHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n");
    h.dir("/etc/cron.d");
    h.file("/etc/ufw/ufw.conf", "# /etc/ufw/ufw.conf\nENABLED=no\nLOGLEVEL=low\n");
    h.file("/etc/systemd/journald.conf", "[Journal]\n#Storage=auto\n#SystemMaxUse=\n");
    h.file("/etc/netplan/50-cloud-init.yaml", "network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n      match:\n        macaddress: 0a:4f:3c:91:7e:21\n      set-name: eth0\n");
    h.dir("/home/ubuntu", { u: "ubuntu", g: "ubuntu", m: 0o750 });
    h.file("/home/ubuntu/.bashrc", "# ~/.bashrc: executed by bash(1) for non-login shells.\nHISTSIZE=1000\nalias ll='ls -alF'\n", { u: "ubuntu", g: "ubuntu" });
    h.file("/home/ubuntu/.profile", "# ~/.profile: executed by the command interpreter for login shells.\nif [ -n \"$BASH_VERSION\" ]; then\n    . \"$HOME/.bashrc\"\nfi\n", { u: "ubuntu", g: "ubuntu" });
    h.dir("/home/ubuntu/.ssh", { u: "ubuntu", g: "ubuntu", m: 0o700 });
    h.file("/home/ubuntu/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPracticeKeyOnlyNotARealKey ubuntu@laptop\n", { u: "ubuntu", g: "ubuntu", m: 0o600 });
    h.dir("/var/www/html", { m: 0o755 });
    h.file("/var/www/html/index.html", "<!doctype html>\n<title>web-01</title>\n<h1>It works</h1>\n");
    h.dir("/var/log", { m: 0o775, g: "syslog" });
    h.file("/var/log/syslog", "", { u: "syslog", g: "adm", m: 0o640, gen: (hh) => hh.journal.slice().sort((x, y) => x.t - y.t).map((e) => `${L.isoDay(e.t)}T${L.hms(e.t)}.000000+00:00 ${hh.hostname} ${e.ident}${e.pid ? `[${e.pid}]` : ""}: ${e.msg}`) });
    h.file("/var/log/auth.log", "", { u: "syslog", g: "adm", m: 0o640, gen: (hh) => hh.journal.filter((e) => /^(sshd|sudo|su|CRON)$/.test(e.ident)).map((e) => `${L.isoDay(e.t)}T${L.hms(e.t)}.000000+00:00 ${hh.hostname} ${e.ident}[${e.pid || 1}]: ${e.msg}`) });
    h.file("/var/log/kern.log", "", { u: "syslog", g: "adm", m: 0o640, gen: (hh) => hh.kmsg.map((e) => `${L.isoDay(hh.boot + e.t * 1000)}T${L.hms(hh.boot + e.t * 1000)}.000000+00:00 ${hh.hostname} kernel: ${e.msg}`) });
    h.file("/var/log/dpkg.log", "2026-10-28 06:12:44 status installed libssl3t64:amd64 3.0.13-0ubuntu3.4\n", { m: 0o644 });
    for (const n of ["syslog.2.gz", "syslog.3.gz", "auth.log.2.gz"]) h.file(`/var/log/${n}`, "", { u: "syslog", g: "adm", m: 0o640, size: 1.1 * MiB });
    h.dir("/var/lib/postgresql/16/main", { u: "postgres", g: "postgres", m: 0o700 });
    h.dir("/run/postgresql", { u: "postgres", g: "postgres", m: 0o2775 });
    h.dir("/srv/app", { u: "app", g: "app" });
    for (const [n, t] of Object.entries(UNITS)) h.file(`/usr/lib/systemd/system/${n}`, t);
    for (const n of ["ssh.service", "cron.service", "systemd-timesyncd.service"]) h.link(`/etc/systemd/system/multi-user.target.wants/${n}`, `/usr/lib/systemd/system/${n}`);

    h.apps["/usr/sbin/sshd"] = service({ ident: "sshd", port: 22, rss: 7800, cpu: 0.01, proc: () => ({ comm: "sshd", args: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", lead: true }), log: () => ["Server listening on 0.0.0.0 port 22.", "Server listening on :: port 22."] });
    h.apps["/usr/sbin/cron"] = () => ({ ident: "cron", proc: { comm: "cron", args: "/usr/sbin/cron -f -P", rss: 2700, lead: true }, log: ["(CRON) INFO (pidfile fd = 3)", "(CRON) INFO (Running @reboot jobs)"] });
    h.apps["/usr/lib/systemd/systemd-timesyncd"] = (hh) => {
      const log = [];
      if (hh.clockSkew) {
        hh.clock -= hh.clockSkew;
        hh.clockSkew = 0;
        log.push("Contacted time server 169.254.169.123:123 (169.254.169.123).", `Initial clock synchronization to ${L.longDate(hh.clock)}.012442 UTC.`);
      } else log.push("Initial synchronization to time server 169.254.169.123:123 (169.254.169.123).");
      return { ident: "systemd-timesyncd", proc: { comm: "systemd-timesyn", args: "/usr/lib/systemd/systemd-timesyncd", user: "systemd-timesync", rss: 7100 }, log };
    };
    h.apps["/usr/sbin/nginx"] = nginx;
    h.apps["/usr/lib/postgresql/16/bin/postgres"] = service({ ident: "postgres", port: 5432, bind: "127.0.0.1", rss: 182000,
      proc: () => ({ comm: "postgres", args: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf", lead: true }),
      kids: [{ pid: 1187, comm: "postgres", args: "postgres: 16/main: checkpointer ", rss: 9800 }, { comm: "postgres", args: "postgres: 16/main: background writer ", rss: 6200 }, { comm: "postgres", args: "postgres: 16/main: walwriter ", rss: 8800 }],
      log: () => ["LOG:  starting PostgreSQL 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2) on x86_64-pc-linux-gnu", "LOG:  listening on IPv4 address \"127.0.0.1\", port 5432", "LOG:  database system is ready to accept connections"],
      ready: (hh) => (hh.booting ? hh.pgRecovery || 1 : 0.5) });

    // cron notices changed files in /etc/cron.d, and says when it cannot use one.
    h.onWrite = (hh, path) => {
      if (!path.startsWith("/etc/cron.d/") && !path.startsWith("/var/spool/cron/crontabs/")) return;
      const tag = path.startsWith("/etc/") ? `*system*${L.basename(path)}` : L.basename(path);
      const errs = L.crontabs(hh).errors.filter((e) => e.path === path);
      for (const e of errs.length ? errs : [{ msg: `(${tag}) RELOAD (${path.startsWith("/etc/") ? path : "crontabs/" + L.basename(path)})` }]) hh.log("cron", e.msg, { pid: 612, unit: "cron.service", prio: errs.length ? 3 : 6 });
    };
    world.system(h);
  }

  // What runs on every boot before the services: init, the journal, udev, your login.
  world.system = (h) => {
    h.nextPid = 1;
    L.spawn(h, { pid: 1, ppid: 0, comm: "systemd", args: "/sbin/init", rss: 12900, vsz: 167744, lead: true, start: h.boot });
    L.spawn(h, { pid: 412, comm: "systemd-journal", args: "/usr/lib/systemd/systemd-journald", rss: 21400, start: h.boot });
    L.spawn(h, { pid: 455, comm: "systemd-udevd", args: "/usr/lib/systemd/systemd-udevd", rss: 7300, start: h.boot });
    L.spawn(h, { pid: 598, comm: "systemd-network", args: "/usr/lib/systemd/systemd-networkd", user: "systemd-network", rss: 8600, start: h.boot });
    h.nextPid = 700;
    const who = h.scenario.user || "ubuntu";
    L.spawn(h, { pid: 1402, comm: "sshd", args: `sshd: ${who} [priv]`, rss: 11000, start: h.clock - 600000 });
    L.spawn(h, { pid: 1450, ppid: 1402, user: who, comm: "bash", args: "-bash", tty: "pts/0", rss: 5300, start: h.clock - 600000 });
    h.nextPid = 900;
  };
  L.world = world;
  Object.assign(L, { service, portBusy, page, nginxConf });
})(typeof window !== "undefined" ? window : globalThis);
