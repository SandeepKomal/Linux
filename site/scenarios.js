// Linux Quest simulator, part 4: the scenarios. Each one changes the base
// machine (setup runs before boot, after runs once it is up) and says how to
// tell it is fixed (won) and what to show while you work (check).
"use strict";

(function (root) {
  const L = root.LQSim;
  const { GiB, MiB, service } = L;
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // Helpers for building scenarios.
  function unit(h, name, text, enabled = true) {
    h.file(`/etc/systemd/system/${name}`, text);
    if (enabled) h.link(`/etc/systemd/system/multi-user.target.wants/${name}`, `/etc/systemd/system/${name}`);
  }
  const svcText = (o) => `[Unit]\nDescription=${o.desc}\n${o.unit || "After=network-online.target\nWants=network-online.target\n"}\n[Service]\n${o.service}\n\n[Install]\nWantedBy=multi-user.target\n`;
  const enable = (h, name) => h.link(`/etc/systemd/system/multi-user.target.wants/${name}`, `/usr/lib/systemd/system/${name}`);
  const active = (h, n) => L.state(h, n).active === "active";
  const mainProc = (h, n) => L.procOf(h, L.state(h, n).pid);
  const procBy = (h, re) => h.procs.find((p) => re.test(p.args) && p.stat !== "Z");
  const addUser = (h, line, group) => {
    h.fs.get("/etc/passwd").data += line + "\n";
    h.fs.get("/etc/group").data += group + "\n";
  };
  const withNginx = (h, root = "/var/www/html") => {
    h.pkgs.installed.nginx = "1.24.0-2ubuntu7.1";
    h.bin("/usr/sbin/nginx");
    h.file("/etc/nginx/nginx.conf", "user www-data;\nworker_processes auto;\npid /run/nginx.pid;\nevents { worker_connections 768; }\nhttp {\n\tinclude /etc/nginx/conf.d/*.conf;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n");
    h.file("/etc/nginx/sites-available/default", `server {\n\tlisten 80 default_server;\n\troot ${root};\n\tindex index.html;\n\tserver_name _;\n\tlocation / {\n\t\ttry_files $uri $uri/ =404;\n\t}\n}\n`);
    h.link("/etc/nginx/sites-enabled/default", "/etc/nginx/sites-available/default");
    h.dir("/etc/nginx/conf.d");
    h.dir("/var/log/nginx", { u: "www-data", g: "adm" });
    enable(h, "nginx.service");
  };
  const withPostgres = (h) => { h.pkgs.installed["postgresql-16"] = "16.4-0ubuntu0.24.04.2"; enable(h, "postgresql.service"); };
  const ago = (h, ms) => h.clock - ms;
  const logAt = (h, t, ident, msg, unitName, pid, prio) => h.log(ident, msg, { t, unit: unitName, pid, prio });
  const httpCode = (h, url) => { const r = L.http(h, url, 5); return r.code || 0; };
  const persisted = (h, key) => {
    let v = null;
    for (const p of ["/etc/sysctl.conf", ...h.kids("/etc/sysctl.d").filter((k) => k.endsWith(".conf")).map((k) => `/etc/sysctl.d/${k}`)]) {
      for (const l of L.lines(h.read(p) || "")) { const m = new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=\\s*(\\S+)`).exec(l); if (m) v = m[1]; }
    }
    return v;
  };
  // nginx on Rocky: one server block in conf.d, run as the nginx user.
  const rhelNginx = (h, site) => {
    h.pkgs.installed.nginx = "1.20.1-14.el9_2.1";
    h.bin("/usr/sbin/nginx");
    h.file("/etc/nginx/nginx.conf", "user nginx;\nworker_processes auto;\npid /run/nginx.pid;\nevents { worker_connections 1024; }\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n");
    h.file("/etc/nginx/conf.d/app.conf", site);
    enable(h, "nginx.service");
  };
  const rootUse = (h) => { const m = h.mounts.find((x) => x.mnt === "/"); return h.usage(m).bytes / m.size; };

  const RELEASE_SCRIPT = "#!/bin/bash\nset -e\necho \"Deploying release 2026.10.30\"\nmkdir -p /srv/app/releases/2026.10.30\necho \"2026.10.30\" > /srv/app/RELEASE\necho \"Done.\"\n";
  const released = (h) => h.read("/srv/app/RELEASE") === "2026.10.30\n";

  const SCENARIOS = [
    // --- Files and permissions -------------------------------------------------------
    {
      id: "noexec", title: "Permission denied on a script", level: "02",
      story: "A colleague copied the deploy script to the server and left. Running it gives Permission denied, even though you own the file.",
      goal: "Make ~/deploy.sh runnable as ./deploy.sh, safely, and run it.",
      done: "deploy.sh is executable and release 2026.10.30 is deployed.",
      setup(h) {
        h.file("/home/ubuntu/deploy.sh", RELEASE_SCRIPT, { u: "ubuntu", g: "ubuntu", m: 0o644 });
        h.fs.get("/srv/app").u = "ubuntu";
      },
      won: (h) => { const n = h.fs.get("/home/ubuntu/deploy.sh"); return Boolean(n.m & 0o100) && !(n.m & 0o002) && released(h); },
      check(h) {
        const n = h.fs.get("/home/ubuntu/deploy.sh");
        return { label: "./deploy.sh", ok: this.won(h), text: !(n.m & 0o100) ? `not executable (${L.modeStr(n)})` : n.m & 0o002 ? "world-writable: anyone can change what it runs" : released(h) ? "release 2026.10.30 deployed" : "executable; not run yet" };
      },
      hints: ["Run `./deploy.sh`, then `ls -l deploy.sh`. Look at the first ten characters.", "There is no x in `-rw-r--r--`. The kernel only runs files with an execute bit. `bash deploy.sh` would work once, but cron and CI call it as ./deploy.sh.", "Add execute for the owner only: `chmod u+x deploy.sh`, then `./deploy.sh`. Avoid 777: it lets anyone rewrite the script."],
      lesson: "A script needs the execute bit to run as ./script. Grant only what is needed (u+x or 755), never 777.",
      tries: ["./deploy.sh", "ls -l deploy.sh"]
    },
    {
      id: "crlf", title: "bad interpreter: ^M", level: "02",
      story: "The deploy script was edited on Windows and committed. Now it fails on the server with a strange interpreter error, although /bin/bash exists.",
      goal: "Make ~/deploy.sh run cleanly as ./deploy.sh.",
      done: "deploy.sh has Unix line endings and the release is deployed.",
      setup(h) {
        h.file("/home/ubuntu/deploy.sh", RELEASE_SCRIPT.replace(/\n/g, "\r\n"), { u: "ubuntu", g: "ubuntu", m: 0o755 });
        h.fs.get("/srv/app").u = "ubuntu";
      },
      won: (h) => !(h.read("/home/ubuntu/deploy.sh") || "\r").includes("\r") && released(h),
      check(h) {
        const crlf = (h.read("/home/ubuntu/deploy.sh") || "").includes("\r");
        return { label: "deploy.sh", ok: this.won(h), text: crlf ? "Windows line endings (CRLF)" : released(h) ? "release 2026.10.30 deployed" : "Unix line endings; not run yet" };
      },
      hints: ["Read the error closely: `/bin/bash^M`. ^M is a carriage return.", "`file deploy.sh` says \"with CRLF line terminators\". Each line ends in \\r\\n, so the kernel looks for an interpreter called \"/bin/bash\\r\".", "Strip the carriage returns: `sed -i 's/\\r$//' deploy.sh` (or `sudo apt install dos2unix` and `dos2unix deploy.sh`), then `./deploy.sh`."],
      lesson: "\"bad interpreter: ^M\" means Windows line endings. Convert with sed or dos2unix, and add `*.sh text eol=lf` to .gitattributes so it does not come back.",
      tries: ["./deploy.sh", "file deploy.sh"]
    },
    {
      id: "symlink", title: "Symlink broken after deploy", level: "03",
      story: "Last night's deploy script switched releases, and a cleanup job deleted the old release folder. The shop now answers 404 for every page.",
      goal: "Point /srv/www/current at the newest release so the site loads.",
      done: "current points at release 20261030-1 and nginx serves it.",
      setup(h) {
        withNginx(h, "/srv/www/current");
        h.dir("/srv/www", { u: "ubuntu", g: "ubuntu" });
        h.dir("/srv/www/releases", { u: "ubuntu", g: "ubuntu" });
        h.dir("/srv/www/releases/20261030-1", { u: "ubuntu", g: "ubuntu" });
        h.file("/srv/www/releases/20261030-1/index.html", "<!doctype html>\n<title>Shop</title>\n<p>Shop release 20261030-1</p>\n", { u: "ubuntu", g: "ubuntu" });
        h.dir("/srv/www/releases/20261028-3", { u: "ubuntu", g: "ubuntu" });
        h.file("/srv/www/releases/20261028-3/index.html", "<!doctype html>\n<title>Shop</title>\n<p>Shop release 20261028-3</p>\n", { u: "ubuntu", g: "ubuntu" });
        h.link("/srv/www/current", "/srv/www/releases/20261029-2", { u: "ubuntu", g: "ubuntu" });
      },
      won: (h) => { const r = L.http(h, "http://localhost/"); return r.code === 200 && r.body.join(" ").includes("20261030-1"); },
      check(h) {
        const r = L.http(h, "http://localhost/");
        return { label: "http://localhost/", ok: this.won(h), text: r.code ? `${r.code}${r.code === 200 ? " · " + (/release (\S+)</.exec(r.body.join(" ")) || [, ""])[1] : ""}` : "no answer" };
      },
      hints: ["`curl -I localhost` says 404. nginx serves /srv/www/current: `ls -l /srv/www`.", "`current -> /srv/www/releases/20261029-2`, which no longer exists: a dangling link. `ls /srv/www/releases` shows what does.", "Replace the link in one step: `ln -sfn /srv/www/releases/20261030-1 /srv/www/current`. -f replaces it, -n stops ln from following the old link."],
      lesson: "A symlink stores a path, not the file. Deploy by switching a link with ln -sfn (atomic enough for most sites), and never delete the release it points at.",
      tries: ["curl -I localhost", "ls -l /srv/www"]
    },
    {
      id: "rootowned", title: "Files owned by root after sudo", level: "02",
      story: "Someone restored the uploads folder with `sudo tar -xzf`. The shop still runs, but every customer upload fails.",
      goal: "Let the shop service save uploads again, without opening the folder to everyone.",
      done: "uploads belongs to the shop user and uploads work.",
      setup(h) {
        addUser(h, "shop:x:1002:1002::/srv/shop:/usr/sbin/nologin", "shop:x:1002:");
        h.bin("/usr/bin/node");
        h.dir("/srv/shop", { u: "shop", g: "shop" });
        h.file("/srv/shop/server.js", "// shop server\n", { u: "shop", g: "shop" });
        h.dir("/srv/shop/uploads", { u: "root", g: "root", m: 0o755 });
        h.file("/srv/shop/uploads/receipt-8811.pdf", "", { size: 84000, m: 0o644 });
        unit(h, "shop.service", svcText({ desc: "Shop storefront", service: "User=shop\nWorkingDirectory=/srv/shop\nEnvironment=PORT=3000\nExecStart=/usr/bin/node /srv/shop/server.js\nRestart=on-failure" }));
        const upload = (hh) => {
          const n = hh.fs.get("/srv/shop/uploads");
          return n && hh.can("shop", n, 2) && hh.can("shop", n, 1);
        };
        h.apps["/usr/bin/node"] = service({ ident: "node", port: 3000, rss: 118000, http: (hh, path) => {
          if (!path.startsWith("/upload")) return { code: 200, body: ["<!doctype html><title>Shop</title>"] };
          if (upload(hh)) return { code: 201, type: "application/json", body: ['{"saved":"receipt-8813.pdf"}'] };
          hh.log("node", "Error: EACCES: permission denied, open '/srv/shop/uploads/receipt-8813.pdf'", { unit: "shop.service", pid: L.state(hh, "shop.service").pid, prio: 3 });
          return { code: 500, type: "application/json", body: ['{"error":"could not save upload"}'] };
        } });
      },
      after(h) {
        const pid = L.state(h, "shop.service").pid;
        for (const [m, n] of [[14, 8812], [9, 8813], [3, 8813]]) logAt(h, ago(h, m * MIN), "node", `Error: EACCES: permission denied, open '/srv/shop/uploads/receipt-${n}.pdf'`, "shop.service", pid, 3);
        h.log("sudo", "ubuntu : TTY=pts/1 ; PWD=/srv/shop ; USER=root ; COMMAND=/usr/bin/tar -xzf /tmp/uploads-backup.tar.gz -C /srv/shop", { t: ago(h, 40 * MIN), pid: 3010 });
      },
      won: (h) => { const n = h.fs.get("/srv/shop/uploads"); return Boolean(n) && n.u === "shop" && !(n.m & 0o002) && active(h, "shop.service") && httpCode(h, "http://localhost:3000/upload") === 201; },
      check(h) { const c = httpCode(h, "http://localhost:3000/upload"); return { label: "POST /upload", ok: this.won(h), text: c === 201 ? (this.won(h) ? "201 saved" : "201, but the folder is world-writable") : c ? `${c} error` : "no answer" }; },
      hints: ["`journalctl -u shop -n 5` shows EACCES on /srv/shop/uploads. Which user runs the shop? `systemctl cat shop`.", "`ls -ld /srv/shop/uploads`: owned by root, mode 755. The shop runs as user shop, which cannot create files there.", "Give it back to its owner: `sudo chown -R shop:shop /srv/shop/uploads`. chmod 777 would also \"work\" and let every process on the box write there."],
      lesson: "sudo creates files as root. Fix ownership with chown to the service's user instead of loosening permissions, and extract with the right user (sudo -u shop tar ...).",
      tries: ["curl localhost:3000/upload", "ls -ld /srv/shop/uploads"]
    },
    {
      id: "umask", title: "403 Forbidden after every deploy", level: "02",
      story: "The new report page returns 403 Forbidden. Older pages work. It happens again after every deploy.",
      goal: "Serve /report.html, and stop new deploys from repeating the problem.",
      done: "report.html is readable and new files will be too.",
      setup(h) {
        withNginx(h);
        h.fs.get("/var/www/html").u = "ubuntu";
        h.fs.get("/home/ubuntu/.profile").data += "\n# keep my files private\numask 077\n";
        h.file("/var/www/html/report.html", "<!doctype html>\n<title>Q3 report</title>\n<h1>Q3 report</h1>\n", { u: "ubuntu", g: "ubuntu", m: 0o600 });
      },
      won: (h) => httpCode(h, "http://localhost/report.html") === 200 && !(h.fs.get("/var/www/html/report.html").m & 0o002) && !(h.profileUmask("ubuntu") & 0o004),
      check(h) {
        const c = httpCode(h, "http://localhost/report.html");
        return { label: "/report.html", ok: this.won(h), text: c !== 200 ? `${c}` : h.profileUmask("ubuntu") & 0o004 ? "200 now; the next deploy breaks it again" : "200, and new files will be readable" };
      },
      hints: ["`curl -I localhost/report.html` says 403. `ls -l /var/www/html`: compare report.html with index.html.", "report.html is -rw-------: only you can read it, and nginx runs as www-data. Why was it created that way? Type `umask`, then `grep umask ~/.profile`.", "Fix the file: `chmod 644 /var/www/html/report.html`. Fix the cause: `sed -i 's/^umask 077/umask 022/' ~/.profile`."],
      lesson: "The umask decides the permissions of every new file. 077 makes files private, so web servers cannot read them. Fix the file and the umask that created it.",
      tries: ["curl -I localhost/report.html", "ls -l /var/www/html"]
    },
    {
      id: "immutable", title: "Operation not permitted, even as root", level: "02",
      story: "Marketing starts a campaign in ten minutes and the API rate limit must go from 10 to 50 requests a second. Editing the nginx file fails, even with sudo.",
      goal: "Raise the rate limit in /etc/nginx/conf.d/rate-limit.conf to 50r/s and apply it.",
      done: "nginx runs with rate=50r/s.",
      setup(h) {
        withNginx(h);
        h.file("/etc/nginx/conf.d/rate-limit.conf", "# Locked with chattr +i after an accidental change. Unlock before editing.\nlimit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;\n", { imm: true });
        const base = h.apps["/usr/sbin/nginx"];
        const rate = (hh) => (/rate=(\d+r\/s)/.exec(hh.read("/etc/nginx/conf.d/rate-limit.conf") || "") || [, "?"])[1];
        h.apps["/usr/sbin/nginx"] = (hh, x) => { const r = base(hh, x); if (r.proc) { r.proc.rate = rate(hh); r.proc.onReload = (h2, p) => { p.rate = rate(h2); return null; }; } return r; };
      },
      won: (h) => { const p = mainProc(h, "nginx.service"); return Boolean(p) && p.rate === "50r/s"; },
      check(h) { const p = mainProc(h, "nginx.service"); return { label: "nginx rate limit", ok: this.won(h), text: p ? `running with rate=${p.rate}` : "nginx is not running" }; },
      hints: ["Try `sudo sed -i 's/10r\\/s/50r\\/s/' /etc/nginx/conf.d/rate-limit.conf`. Root, yet Operation not permitted.", "Permissions are fine, so look at file attributes: `lsattr /etc/nginx/conf.d/rate-limit.conf`. The i means immutable.", "`sudo chattr -i` the file, edit it with sed, `sudo nginx -t`, then `sudo systemctl reload nginx`. Put the lock back with `chattr +i` if your team wants it."],
      lesson: "The immutable attribute blocks every change, even by root. lsattr shows it, chattr -i removes it. reload applies nginx config without dropping connections.",
      tries: ["sudo sed -i 's/10r\\/s/50r\\/s/' /etc/nginx/conf.d/rate-limit.conf", "lsattr /etc/nginx/conf.d/rate-limit.conf"]
    },

    // --- Processes --------------------------------------------------------------------
    {
      id: "runaway", title: "A process eating the CPU", level: "05",
      story: "The site is slow and the load average is climbing. Nothing was deployed today.",
      goal: "Find the process using all the CPU and stop it, without touching the web server.",
      done: "The runaway export is stopped and the load is falling.",
      setup: withNginx,
      after(h) {
        L.spawn(h, { pid: 3317, user: "ubuntu", comm: "node", args: "node /opt/reports/export.js --all --since 2019-01-01", cpu: 198.4, rss: 412000, vsz: 1210000, tty: "pts/1", stat: "R", start: ago(h, 3 * HOUR) });
      },
      won: (h) => !procBy(h, /export\.js/) && active(h, "nginx.service"),
      check(h) { const c = L.cpuStats(h); return { label: "load average", ok: this.won(h), text: `${c.load[0].toFixed(2)} on ${h.cpus} CPUs${procBy(h, /export\.js/) ? "" : !active(h, "nginx.service") ? ", but nginx is down" : ""}` }; },
      hints: ["`uptime` shows the load; `top` shows who causes it. Sort by CPU.", "PID 3317 is a node export someone started by hand three hours ago, at nearly 200% (both CPUs). `ps -fp 3317` shows its full command.", "Ask it to stop: `kill 3317` sends SIGTERM. Check with `ps -p 3317`. renice only shares the CPU differently; the work still runs."],
      lesson: "top and ps aux --sort=-%cpu find the culprit. kill sends SIGTERM, which lets the program clean up; use -9 only when it ignores TERM.",
      tries: ["uptime", "top"]
    },
    {
      id: "graceful", title: "kill -9 or a clean stop", level: "05",
      story: "A batch export (batchd) must stop before tonight's database upgrade. It is halfway through writing export.csv, and finance needs that file intact.",
      goal: "Stop batchd without losing or corrupting export.csv.",
      done: "batchd finished its file and exited cleanly.",
      setup(h) {
        h.dir("/var/lib/batch", { u: "ubuntu", g: "ubuntu" });
        h.file("/var/lib/batch/export.csv.part", "", { u: "ubuntu", g: "ubuntu", size: 412 * MiB });
        h.file("/var/lib/batch/batchd.lock", "2481\n", { u: "ubuntu", g: "ubuntu" });
      },
      after(h) {
        L.spawn(h, { pid: 2481, user: "ubuntu", comm: "batchd", args: "/opt/batch/batchd --out /var/lib/batch/export.csv", cpu: 34, rss: 220000, tty: "?", start: ago(h, 50 * MIN),
          fds: [{ fd: 4, path: "/var/lib/batch/export.csv.part", mode: "w" }],
          onSignal(hh, sig) {
            if (sig === "HUP") return true; // started with nohup
            if (sig === "TERM" || sig === "INT") {
              hh.fs.delete("/var/lib/batch/export.csv.part");
              hh.fs.delete("/var/lib/batch/batchd.lock");
              hh.file("/var/lib/batch/export.csv", "", { u: "ubuntu", g: "ubuntu", size: 688 * MiB, mt: hh.clock });
              return false;
            }
            hh.batchKilled = true;
            return false;
          } });
      },
      won: (h) => !procBy(h, /batchd/) && h.fs.has("/var/lib/batch/export.csv") && !h.fs.has("/var/lib/batch/batchd.lock") && !h.batchKilled,
      check(h) {
        return { label: "export.csv", ok: this.won(h), text: h.batchKilled ? "truncated .part and a stale lock: reset and stop it with SIGTERM" : procBy(h, /batchd/) ? "batchd still writing (61%)" : "complete, 688 MB" };
      },
      hints: ["`ps aux | grep batchd` finds PID 2481. `ls -l /var/lib/batch` shows it writes export.csv.part and holds a lock file.", "SIGKILL (-9) ends a process instantly: no chance to flush, rename or remove its lock. SIGTERM asks it to finish up. SIGHUP is ignored here: it was started with nohup.", "`kill 2481` (TERM is the default), then `ls -l /var/lib/batch`. If you already used -9, type `reset` and try TERM."],
      lesson: "Always try SIGTERM first and give the process time. kill -9 cannot be caught: files stay half-written and locks stay behind.",
      tries: ["ps aux", "ls -l /var/lib/batch"]
    },
    {
      id: "zombie", title: "Zombies that will not die", level: "05",
      story: "Monitoring alerts on 23 zombie processes. A colleague ran kill -9 on them and nothing changed.",
      goal: "Get rid of the zombie processes and keep the job runner working.",
      done: "No zombies left and jobrunner is running.",
      setup(h) {
        h.bin("/usr/bin/python3");
        h.file("/opt/jobs/runner.py", "# forks a convert process per job and never calls wait()\n");
        unit(h, "jobrunner.service", svcText({ desc: "Background job runner", service: "User=app\nExecStart=/usr/bin/python3 /opt/jobs/runner.py\nRestart=always" }));
        h.apps["/usr/bin/python3"] = service({ ident: "python3", rss: 64000, cpu: 1.2, log: () => ["runner started, polling queue"] });
      },
      after(h) {
        const ppid = L.state(h, "jobrunner.service").pid;
        for (let i = 0; i < 23; i++) L.spawn(h, { ppid, user: "app", comm: "convert", args: "convert", stat: "Z", rss: 0, vsz: 0, unit: "jobrunner.service", start: ago(h, (60 - i * 2) * MIN) });
      },
      won: (h) => !h.procs.some((p) => p.stat === "Z") && active(h, "jobrunner.service"),
      check(h) { const n = h.procs.filter((p) => p.stat === "Z").length; return { label: "zombie processes", ok: this.won(h), text: n ? `${n} zombies` : active(h, "jobrunner.service") ? "none" : "none, but jobrunner is down" }; },
      hints: ["`ps aux | grep defunct` (or `ps -eo pid,ppid,stat,cmd`). A zombie has already exited; only its entry in the process table is left.", "You cannot kill a zombie: it is dead. Its parent must collect its exit status with wait(). Find the parent in the PPID column.", "The parent is the job runner. `sudo systemctl restart jobrunner`: when the parent goes, init adopts and reaps the zombies. Then fix the code to wait() for its children."],
      lesson: "Zombies are exited processes their parent never reaped. Restart (or fix) the parent; kill -9 on a zombie does nothing.",
      tries: ["ps aux | grep defunct", "top"]
    },
    {
      id: "stalepid", title: "Already running, but it is not", level: "05",
      story: "The server rebooted overnight after a kernel panic. reportd refuses to start: it says it is already running.",
      goal: "Start reportd without harming anything else on the server.",
      done: "reportd is running and PostgreSQL was left alone.",
      setup(h) {
        withPostgres(h);
        h.bin("/opt/reportd/bin/reportd");
        h.file("/run/reportd.pid", "1187\n");
        unit(h, "reportd.service", svcText({ desc: "Report generator daemon", unit: "After=postgresql.service\n", service: "Type=forking\nPIDFile=/run/reportd.pid\nExecStart=/opt/reportd/bin/reportd --daemon" }));
        h.apps["/opt/reportd/bin/reportd"] = (hh, x) => {
          const pid = Number((hh.read("/run/reportd.pid") || "").trim());
          if (pid && L.procOf(hh, pid)) return { ident: "reportd", fail: { code: 1, log: [`reportd: another instance is running (pid ${pid}), exiting`] } };
          hh.file("/run/reportd.pid", `${x.pid}\n`);
          return { ident: "reportd", proc: { rss: 52000, cpu: 0.2 }, log: ["reportd: started, next run 10:00"] };
        };
      },
      after(h) {
        const kid = L.procOf(h, 1187);
        if (kid) kid.onSignal = (hh) => { hh.pgHurt = true; hh.log("postgres", "LOG:  checkpointer process (PID 1187) was terminated by signal 15: Terminated", { unit: "postgresql.service", pid: L.state(hh, "postgresql.service").pid }); hh.log("postgres", "LOG:  terminating any other active server processes", { unit: "postgresql.service", pid: L.state(hh, "postgresql.service").pid }); return false; };
      },
      won: (h) => active(h, "reportd.service") && !h.pgHurt,
      check(h) { return { label: "reportd", ok: this.won(h), text: h.pgHurt ? "you killed part of PostgreSQL" : active(h, "reportd.service") ? "running" : "refuses: already running" }; },
      hints: ["`systemctl status reportd` and `journalctl -u reportd -n 5`: another instance with pid 1187?", "`cat /run/reportd.pid` says 1187. `ps -fp 1187`: that is PostgreSQL's checkpointer. After the reboot the old PID was reused.", "The PID file is stale. Do not kill 1187. `sudo rm /run/reportd.pid`, then `sudo systemctl start reportd`."],
      lesson: "A PID file only records a number. After a crash or reboot the number may belong to another process. Check what the PID really is before you kill anything.",
      tries: ["systemctl status reportd", "cat /run/reportd.pid"]
    },

    // --- Services ----------------------------------------------------------------------
    {
      id: "badexec", title: "status=203/EXEC", level: "06",
      story: "The orders API was moved to /opt/orders by a new package. Since then it will not start.",
      goal: "Get orders-api running from the binary the package installed.",
      done: "orders-api runs from /opt/orders/bin.",
      setup(h) {
        h.bin("/opt/orders/bin/orders-api");
        unit(h, "orders-api.service", svcText({ desc: "Orders API", service: "User=app\nExecStart=/usr/local/bin/orders-api --port 8080" }));
        h.apps["/opt/orders/bin/orders-api"] = h.apps["/usr/local/bin/orders-api"] = service({ ident: "orders-api", port: 8080, rss: 88000 });
      },
      won: (h) => active(h, "orders-api.service") && /^\/opt\/orders\/bin\/orders-api\b/.test(L.cfgOf(h, "orders-api.service").exec || ""),
      check(h) {
        const p = mainProc(h, "orders-api.service");
        return { label: "orders-api", ok: this.won(h), text: !p ? L.state(h, "orders-api.service").active : this.won(h) ? "running" : "running a stray copy in /usr/local/bin" };
      },
      hints: ["`systemctl status orders-api`: status=203/EXEC means systemd could not execute the program. `journalctl -u orders-api -n 5` says why.", "Failed to locate executable /usr/local/bin/orders-api. Where is it now? `ls /opt/orders/bin`.", "`sudo sed -i 's#/usr/local/bin/orders-api#/opt/orders/bin/orders-api#' /etc/systemd/system/orders-api.service`, `sudo systemctl daemon-reload`, then `sudo systemctl restart orders-api`."],
      lesson: "203/EXEC is a path or permission problem with ExecStart. After editing a unit, daemon-reload, or systemd keeps using the old one.",
      tries: ["systemctl status orders-api", "journalctl -u orders-api -n 5"]
    },
    {
      id: "notenabled", title: "Gone after every reboot", level: "06",
      story: "Every Monday after patching, the metrics agent is missing and dashboards go blank until someone starts it by hand.",
      goal: "Make metrics-agent start on every boot, and keep it running now.",
      done: "metrics-agent is enabled and running.",
      setup(h) {
        h.bin("/opt/metrics/bin/metrics-agent");
        unit(h, "metrics-agent.service", svcText({ desc: "Metrics agent", service: "User=app\nExecStart=/opt/metrics/bin/metrics-agent --listen :9100\nRestart=on-failure" }), false);
        h.apps["/opt/metrics/bin/metrics-agent"] = service({ ident: "metrics-agent", port: 9100, rss: 31000 });
      },
      after(h) { L.start(h, "metrics-agent.service"); },
      won: (h) => active(h, "metrics-agent.service") && L.enabledState(h, "metrics-agent.service") === "enabled",
      check(h) { return { label: "metrics-agent", ok: this.won(h), text: `${L.state(h, "metrics-agent.service").active}, ${L.enabledState(h, "metrics-agent.service")}` }; },
      hints: ["`systemctl status metrics-agent`: look at the Loaded line, after the unit path.", "\"disabled\" means nothing starts it at boot; someone started it by hand. `systemctl is-enabled metrics-agent`.", "`sudo systemctl enable metrics-agent` (or `enable --now` to also start it). Prove it with `sudo reboot`."],
      lesson: "start runs a service now; enable makes it start at boot. You usually want both: systemctl enable --now.",
      tries: ["systemctl status metrics-agent", "sudo reboot"]
    },
    {
      id: "daemonreload", title: "The unit change did not take", level: "06",
      story: "The load balancer now sends API traffic to port 8081. You changed the port in the unit and restarted, yet the API still listens on 8080.",
      goal: "Make the API listen on 8081.",
      done: "The API listens on 8081.",
      setup(h) {
        h.bin("/opt/api/bin/api");
        unit(h, "api.service", svcText({ desc: "Public API", service: "User=app\nEnvironment=PORT=8080\nExecStart=/opt/api/bin/api" }));
        h.apps["/opt/api/bin/api"] = service({ ident: "api", port: 8080, rss: 70000 });
      },
      after(h) { h.fs.get("/etc/systemd/system/api.service").data = h.read("/etc/systemd/system/api.service").replace("PORT=8080", "PORT=8081"); },
      won: (h) => (mainProc(h, "api.service") || { listen: [] }).listen.some((l) => l.port === 8081),
      check(h) { const p = mainProc(h, "api.service"); return { label: "api port", ok: this.won(h), text: p ? `listening on ${p.listen.map((l) => l.port).join(",")}` : "not running" }; },
      hints: ["`sudo systemctl restart api`, then `sudo ss -tlnp`. Did you notice the warning restart printed?", "\"The unit file ... changed on disk. Run 'systemctl daemon-reload'\". systemd still uses the copy it loaded earlier. `systemctl cat api` shows the file; `systemctl show api -p Environment` shows what systemd uses.", "`sudo systemctl daemon-reload`, then `sudo systemctl restart api`."],
      lesson: "systemd reads unit files only on daemon-reload. Edit, daemon-reload, restart: in that order.",
      tries: ["sudo ss -tlnp", "systemctl cat api"]
    },
    {
      id: "masked", title: "Unit is masked", level: "06",
      story: "During last week's maintenance someone made very sure nginx would not start. Maintenance is over, and nginx still will not start.",
      goal: "Get nginx running now and on every boot.",
      done: "nginx is unmasked, enabled and running.",
      setup(h) {
        withNginx(h);
        h.fs.delete("/etc/systemd/system/multi-user.target.wants/nginx.service");
        h.link("/etc/systemd/system/nginx.service", "/dev/null");
      },
      won: (h) => active(h, "nginx.service") && L.enabledState(h, "nginx.service") === "enabled",
      check(h) { return { label: "nginx", ok: this.won(h), text: `${L.state(h, "nginx.service").active}, ${L.enabledState(h, "nginx.service")}` }; },
      hints: ["`sudo systemctl start nginx` says Unit nginx.service is masked.", "Masking links the unit to /dev/null so nothing can start it, not even by hand: `ls -l /etc/systemd/system/nginx.service`.", "`sudo systemctl unmask nginx`, then `sudo systemctl enable --now nginx`."],
      lesson: "disable stops a unit starting at boot; mask stops it starting at all. unmask undoes it.",
      tries: ["sudo systemctl start nginx", "systemctl status nginx"]
    },
    {
      id: "restartlimit", title: "Start request repeated too quickly", level: "07",
      story: "A config change went out to billing. It crashed, systemd restarted it five times, and now gives up.",
      goal: "Get billing running again.",
      done: "billing is running with a valid config.",
      setup(h) {
        h.bin("/opt/billing/bin/billing");
        h.file("/etc/billing/config.yml", "server:\n  port: 8090\ndatabase:\n  host: db.internal\n  port: 5432\n\tuser: billing\n  pool: 10\n");
        unit(h, "billing.service", svcText({ desc: "Billing service", unit: "After=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=5\n", service: "User=app\nExecStart=/opt/billing/bin/billing --config /etc/billing/config.yml\nRestart=on-failure\nRestartSec=2" }));
        h.apps["/opt/billing/bin/billing"] = service({ ident: "billing", port: 8090, rss: 92000, check: (hh) => ((hh.read("/etc/billing/config.yml") || "").includes("\t") ? ["Error: yaml: line 6: found character that cannot start any token", "billing: could not load /etc/billing/config.yml"] : null) });
      },
      after(h) {
        const st = L.state(h, "billing.service");
        Object.assign(st, { active: "inactive", starts: [], result: "success" });
        h.clock -= 40000;
        L.start(h, "billing.service");
        h.clock += 40000 - 10000;
      },
      won: (h) => active(h, "billing.service"),
      check(h) { const st = L.state(h, "billing.service"); return { label: "billing", ok: this.won(h), text: st.active === "active" ? "running" : `${st.active} (${st.result})` }; },
      hints: ["`systemctl status billing` shows Result: start-limit-hit. The cause is above that: `journalctl -u billing -n 20`.", "yaml: line 6 has a character that cannot start a token: a tab. `cat -A` is not here, but `grep -n \"$(printf '\\t')\" /etc/billing/config.yml` or just `cat` shows line 6 out of line.", "`sudo sed -i 's/\\t/  /' /etc/billing/config.yml`. systemd still refuses: `sudo systemctl reset-failed billing`, then `sudo systemctl start billing`."],
      lesson: "start-limit-hit means systemd stopped retrying. Fix the real error in the journal first, then reset-failed and start.",
      tries: ["systemctl status billing", "journalctl -u billing -n 20"]
    },
    {
      id: "port", title: "Address already in use", level: "07",
      story: "A package update pulled in Apache as a dependency. Since the reboot, nginx will not start and the site shows Apache's default page.",
      goal: "Run nginx on port 80, and keep Apache from coming back on the next boot.",
      done: "nginx owns port 80 and Apache is disabled.",
      setup(h) {
        withNginx(h);
        h.pkgs.installed.apache2 = "2.4.58-1ubuntu8.4";
        h.bin("/usr/sbin/apachectl");
        h.bin("/usr/sbin/apache2");
        h.file("/usr/lib/systemd/system/apache2.service", "[Unit]\nDescription=The Apache HTTP Server\nAfter=network.target remote-fs.target nss-lookup.target\nDocumentation=https://httpd.apache.org/docs/2.4/\n\n[Service]\nType=forking\nEnvironment=APACHE_STARTED_BY_SYSTEMD=true\nExecStart=/usr/sbin/apachectl start\nExecStop=/usr/sbin/apachectl graceful-stop\nRestart=on-abort\n\n[Install]\nWantedBy=multi-user.target\n");
        enable(h, "apache2.service");
        h.pkgs.repo.apache2 = { ver: "2.4.58-1ubuntu8.4", bins: ["/usr/sbin/apachectl", "/usr/sbin/apache2"], remove: (hh) => { L.stop(hh, "apache2.service"); hh.fs.delete("/usr/lib/systemd/system/apache2.service"); hh.fs.delete("/etc/systemd/system/multi-user.target.wants/apache2.service"); } };
        h.apps["/usr/sbin/apachectl"] = service({ ident: "apachectl", port: 80, rss: 9800, proc: () => ({ comm: "apache2", args: "/usr/sbin/apache2 -k start", lead: true }), kids: [{ comm: "apache2", args: "/usr/sbin/apache2 -k start", user: "www-data", rss: 7400 }], log: () => ["AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 127.0.1.1. Set the 'ServerName' directive globally to suppress this message"],
          http: () => ({ code: 200, server: "Apache/2.4.58 (Ubuntu)", body: ["<title>Apache2 Ubuntu Default Page: It works</title>"] }) });
      },
      won: (h) => active(h, "nginx.service") && L.enabledState(h, "apache2.service") !== "enabled" && !procBy(h, /apache2/),
      check(h) {
        const p = L.listener(h, "127.0.0.1", 80);
        return { label: "port 80", ok: this.won(h), text: !p ? "nothing listening" : `${p.comm}${p.comm === "nginx" && L.enabledState(h, "apache2.service") === "enabled" ? "; Apache returns on the next boot" : ""}` };
      },
      hints: ["`systemctl status nginx`, then `journalctl -u nginx -n 10`: bind() to 0.0.0.0:80 failed (98: Address already in use).", "Who has port 80? `sudo ss -tlnp 'sport = :80'` or `sudo lsof -i :80`. It is apache2, enabled at boot.", "`sudo systemctl disable --now apache2` (or `sudo apt remove apache2`), then `sudo systemctl start nginx`. Killing the PID alone brings Apache back at the next boot."],
      lesson: "Address already in use: find the owner with ss -tlnp or lsof -i, then stop and disable it properly instead of killing a PID.",
      tries: ["systemctl status nginx", "sudo ss -tlnp"]
    },
    {
      id: "bootorder", title: "Fails only after a reboot", level: "07",
      story: "After every reboot, inventory is down with connection refused. Restarting it by hand always works, so nobody looked further.",
      goal: "Make inventory come up on its own after a reboot.",
      done: "inventory started by itself at boot.",
      setup(h) {
        withPostgres(h);
        h.pgRecovery = 20;
        h.bin("/opt/inventory/bin/inventory");
        unit(h, "inventory.service", svcText({ desc: "Inventory service", unit: "After=network.target\n", service: "User=app\nExecStart=/opt/inventory/bin/inventory --db postgres://127.0.0.1:5432/inventory" }));
        h.apps["/opt/inventory/bin/inventory"] = service({ ident: "inventory", port: 8070, rss: 76000,
          check: (hh) => ((hh.booting ? hh.clock < hh.boot + 23000 || L.enabledState(hh, "postgresql.service") !== "enabled" : !L.isUp(hh, "postgresql.service")) ? ["Error: connect ECONNREFUSED 127.0.0.1:5432", "inventory: database not reachable, exiting"] : null) });
      },
      won: (h) => active(h, "inventory.service") && L.state(h, "inventory.service").by === "boot",
      check(h) { const st = L.state(h, "inventory.service"); return { label: "inventory after boot", ok: this.won(h), text: st.active !== "active" ? st.active : st.by === "boot" ? "came up by itself" : "running, but only because you started it" }; },
      hints: ["`journalctl -b -u inventory` and `journalctl -b -u postgresql`: compare the times.", "inventory starts 20 seconds before PostgreSQL accepts connections (it replays its WAL after a reboot). Nothing tells systemd to wait: `systemctl cat inventory` has no After=postgresql.service.", "Add ordering with a drop-in: `sudo mkdir -p /etc/systemd/system/inventory.service.d`, then `printf '[Unit]\\nAfter=postgresql.service\\nWants=postgresql.service\\n' | sudo tee /etc/systemd/system/inventory.service.d/override.conf`, `sudo systemctl daemon-reload`, `sudo reboot`."],
      lesson: "Units start in parallel. After= orders them and Wants= or Requires= pulls the dependency in. Retrying blindly (Restart= with the default 100 ms) just hits the start limit.",
      tries: ["systemctl status inventory", "journalctl -b -u postgresql"]
    },
    {
      id: "cronpath", title: "Cron job that never works", level: "08",
      story: "The uploads backup has been in your crontab for a month. The S3 bucket is empty. Run by hand, the script works every time.",
      goal: "Make the cron job upload the backup.",
      done: "The 5-minute cron job uploaded a backup.",
      setup(h) {
        h.dir("/srv/shop/uploads", { m: 0o755 });
        h.file("/srv/shop/uploads/receipt-8811.pdf", "", { size: 84000 });
        h.bin("/usr/local/bin/aws");
        h.tools["/usr/local/bin/aws"] = (c, args) => (args[0] === "s3" && args[1] === "cp" ? L.ok([`upload: ${args[2].replace(/^\/tmp\//, "../../tmp/")} to ${args[3]}`]) : L.ok(["aws-cli/2.17.40 Python/3.11.9 Linux/6.8.0-1015-aws exe/x86_64.ubuntu.24"]));
        h.file("/usr/local/bin/backup-uploads.sh", "#!/bin/bash\nset -e\ntar -czf /tmp/uploads.tar.gz /srv/shop/uploads\naws s3 cp /tmp/uploads.tar.gz s3://acme-backups/uploads/uploads-$(date +%F).tar.gz\necho \"backup finished $(date +%T)\"\n", { m: 0o755 });
        h.file("/var/spool/cron/crontabs/ubuntu", "# m h  dom mon dow   command\n*/5 * * * * backup-uploads.sh >> /home/ubuntu/backup.log 2>&1\n", { u: "ubuntu", g: "crontab", m: 0o600 });
        h.file("/home/ubuntu/backup.log", "/bin/sh: 1: backup-uploads.sh: not found\n/bin/sh: 1: backup-uploads.sh: not found\n/bin/sh: 1: backup-uploads.sh: not found\n", { u: "ubuntu", g: "ubuntu" });
      },
      after(h) { for (const m of [14, 9, 4]) logAt(h, Math.floor(ago(h, m * MIN) / (5 * MIN)) * 5 * MIN, "CRON", "(ubuntu) CMD (backup-uploads.sh >> /home/ubuntu/backup.log 2>&1)", "cron.service", 3100 + m); },
      won: (h) => (h.read("/home/ubuntu/backup.log") || "").includes("upload: "),
      check(h) {
        const last = L.lines(h.read("/home/ubuntu/backup.log") || "").filter(Boolean).slice(-1)[0] || "";
        return { label: "last backup run", ok: this.won(h), text: this.won(h) ? "uploaded to S3" : `${last.slice(0, 60) || "no output yet"} · next run ${L.hms(Math.ceil((h.clock + 1) / (5 * MIN)) * 5 * MIN).slice(0, 5)}` };
      },
      hints: ["`crontab -l`, then `tail backup.log`. Cron did run the job: `grep CRON /var/log/syslog`.", "Cron runs jobs with PATH=/usr/bin:/bin, not your shell's PATH. Reproduce it: `env -i PATH=/usr/bin:/bin /bin/sh -c 'backup-uploads.sh'`. Fixing only the script path is not enough: the script calls aws, also in /usr/local/bin.", "Set PATH for the whole crontab: `(echo 'PATH=/usr/local/bin:/usr/bin:/bin'; crontab -l) | crontab -`. Then wait for the next run with `sleep 300` and `tail backup.log`."],
      lesson: "Cron's environment is tiny: PATH=/usr/bin:/bin and no profile. Set PATH at the top of the crontab or use absolute paths everywhere, and log the job's output.",
      tries: ["crontab -l", "tail backup.log"]
    },
    {
      id: "cronuser", title: "Cron job as the wrong user", level: "08",
      story: "During the migration window the database must be dumped every 10 minutes. The cron file is in place, but no dump has appeared.",
      goal: "Make the cron job in /etc/cron.d produce a dump.",
      done: "Cron ran pg_dump as postgres and the dump exists.",
      setup(h) {
        withPostgres(h);
        h.dir("/var/backups/postgres", { u: "postgres", g: "postgres", m: 0o700 });
        h.bin("/usr/bin/pg_dump");
        h.tools["/usr/bin/pg_dump"] = (c, args) => {
          if (!L.isUp(c.h, "postgresql.service")) return L.fail(['pg_dump: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory', "\tIs the server running locally and accepting connections on that socket?"]);
          if (c.user !== "postgres") return L.fail([`pg_dump: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${c.user}" does not exist`]);
          const out = args[args.indexOf("-f") + 1];
          const e = c.h.writeFile(L.norm(out, c.cwd), "", c.user, false, 0o077);
          if (e) return L.fail([`pg_dump: error: could not open output file "${out}": ${L.ERR[e]}`]);
          c.h.fs.get(L.norm(out, c.cwd)).size = 186 * MiB;
          return L.ok([]);
        };
        h.file("/etc/cron.d/db-backup", "# Migration window: dump the shop database every 10 minutes\n*/10 * * * * pg_dump -Fc shop -f /var/backups/postgres/shop.dump\n");
      },
      after(h) { for (const e of L.crontabs(h).errors) logAt(h, ago(h, 20 * MIN), "cron", e.msg, "cron.service", 612, 3); },
      won: (h) => (h.cronRuns || []).some((r) => r.tag === "*system*db-backup" && r.ok && r.user === "postgres") && h.fs.has("/var/backups/postgres/shop.dump"),
      check(h) {
        const last = (h.cronRuns || []).filter((r) => r.tag === "*system*db-backup").slice(-1)[0];
        const ignored = L.crontabs(h).errors.some((e) => e.path === "/etc/cron.d/db-backup");
        return { label: "db-backup", ok: this.won(h), text: ignored ? "cron ignores the file" : last ? (last.ok ? `dumped as ${last.user}` : `failed as ${last.user}`) : `waiting for ${L.hms(Math.ceil((h.clock + 1) / (10 * MIN)) * 10 * MIN).slice(0, 5)}` };
      },
      hints: ["`grep cron /var/log/syslog | tail`: cron complained about the file. What does it say?", "Files in /etc/cron.d need a user field after the five time fields. Here cron reads `pg_dump` as the user name: bad username, file ignored.", "Run it as postgres (only that role exists in the database): `sudo sed -i 's/\\* \\* \\* \\* pg_dump/* * * * postgres pg_dump/' /etc/cron.d/db-backup`, then `sleep 600` and `ls -l /var/backups/postgres`."],
      lesson: "/etc/crontab and /etc/cron.d have a sixth field: the user. Run each job as the user that owns the work (postgres for pg_dump), not root.",
      tries: ["cat /etc/cron.d/db-backup", "grep cron /var/log/syslog"]
    },

    // --- Disks --------------------------------------------------------------------------
    {
      id: "deletedopen", title: "Disk full, but du finds nothing", level: "09",
      story: "Writes fail with No space left on device. df says / is 100% full, but du adds up to only 3.3 GB.",
      goal: "Free the space on /, without deleting anything you need.",
      done: "The deleted log's space is back and / has room.",
      setup(h) {
        const m = h.mounts[0];
        m.base = 3.1 * GiB;
        h.bin("/usr/bin/java");
        h.file("/srv/app/app.jar", "", { u: "app", g: "app", size: 48 * MiB });
        h.dir("/var/log/app", { u: "app", g: "app" });
        h.file("/var/log/app/app.log.1.gz", "", { u: "app", g: "app", size: 38 * MiB });
        unit(h, "app.service", svcText({ desc: "Ledger application", service: "User=app\nWorkingDirectory=/srv/app\nExecStart=/usr/bin/java -Xmx1g -jar /srv/app/app.jar" }));
        h.apps["/usr/bin/java"] = (hh) => {
          if (!hh.fs.has("/var/log/app/app.log")) hh.file("/var/log/app/app.log", "2026-10-30 09:00:01 INFO started\n", { u: "app", g: "app" });
          return { ident: "java", proc: { pid: hh.booting ? 2231 : undefined, rss: 640000, cpu: 3.1, listen: [{ addr: "0.0.0.0", port: 8080 }], fds: [{ fd: 7, path: "/var/log/app/app.log", mode: "w" }] }, log: ["Started LedgerApplication in 6.912 seconds"] };
        };
      },
      after(h) {
        const p = mainProc(h, "app.service");
        h.fs.delete("/var/log/app/app.log");
        Object.assign(p.fds[0], { deleted: true, size: 16.4 * GiB, mount: "/" });
        h.log("logrotate", "error: skipping \"/var/log/app/app.log\" because parent directory has insecure permissions", { t: ago(h, 20 * DAY), pid: 2900 });
        h.log("sudo", "ubuntu : TTY=pts/0 ; PWD=/var/log/app ; USER=root ; COMMAND=/usr/bin/rm /var/log/app/app.log", { t: ago(h, 2 * HOUR), pid: 3011 });
        for (const mm of [7, 3, 1]) logAt(h, ago(h, mm * MIN), "java", "ERROR c.l.Ledger - could not write /var/lib/app/state.tmp: No space left on device", "app.service", p.pid, 3);
      },
      won: (h) => rootUse(h) < 0.5,
      check(h) { return { label: "/ in use", ok: this.won(h), text: `${Math.ceil(Math.min(1, rootUse(h) / 0.95) * 100)}%` }; },
      hints: ["`df -h /` says full; `sudo du -xsh /* 2>/dev/null | sort -h` finds far less. The space is held by something du cannot see.", "A deleted file stays on disk while a process keeps it open. `sudo lsof +L1` lists open files with no name left: java (PID 2231) still writes app.log (deleted), 16 GB.", "Close the file: `sudo systemctl restart app`. If you cannot restart, empty it through the process: `sudo truncate -s 0 /proc/2231/fd/7`."],
      lesson: "df counts blocks; du counts names. When they disagree, lsof +L1 finds deleted files still held open. Truncate logs or let logrotate use copytruncate instead of deleting them.",
      tries: ["df -h", "sudo lsof +L1"]
    },
    {
      id: "runawaylog", title: "A debug log filling the disk", level: "09",
      story: "/ went from 40% to 96% since yesterday. Someone turned on debug logging to chase a bug and forgot it.",
      goal: "Free space on / and stop it filling again, with ledger still running.",
      done: "Debug logging is off and the space is back.",
      setup(h) {
        const m = h.mounts[0];
        m.base = 3.6 * GiB;
        h.bin("/usr/bin/python3");
        h.file("/etc/ledger/ledger.env", "LOG_LEVEL=debug\nLOG_FILE=/var/log/ledger/debug.log\n");
        h.dir("/var/log/ledger", { u: "app", g: "app" });
        h.file("/var/log/ledger/debug.log", "", { u: "app", g: "app", size: 14.6 * GiB });
        unit(h, "ledger.service", svcText({ desc: "Ledger API", service: "User=app\nEnvironmentFile=/etc/ledger/ledger.env\nExecStart=/usr/bin/python3 /opt/ledger/app.py" }));
        h.apps["/usr/bin/python3"] = service({ ident: "python3", port: 8085, rss: 81000, proc: (hh, x) => ({ level: x.env.LOG_LEVEL, fds: [{ fd: 3, path: "/var/log/ledger/debug.log", mode: "w" }] }), log: (hh, x) => [`logging at ${x.env.LOG_LEVEL} to /var/log/ledger/debug.log`] });
        // Debug logging writes about 2 MB a second.
        h.everyTick = (hh, sec) => {
          const p = mainProc(hh, "ledger.service");
          if (!p || p.level !== "debug") return;
          const fd = p.fds[0];
          if (fd.deleted) { fd.size += 2 * MiB * sec; return; }
          const n = hh.fs.get(fd.path);
          if (!n) { hh.file(fd.path, "", { u: "app", g: "app", size: 0 }); return; }
          n.size = Math.min(hh.mounts[0].size, (n.size != null ? n.size : n.data.length) + 2 * MiB * sec);
        };
      },
      won: (h) => rootUse(h) < 0.8 && active(h, "ledger.service") && mainProc(h, "ledger.service").level !== "debug",
      check(h) {
        const p = mainProc(h, "ledger.service");
        return { label: "/ in use", ok: this.won(h), text: `${Math.ceil(Math.min(1, rootUse(h) / 0.95) * 100)}%${p && p.level === "debug" ? " · debug log growing 2 MB/s" : !p ? " · ledger is down" : ""}` };
      },
      hints: ["`df -h /`, then `sudo du -h --max-depth=1 /var/log | sort -h`.", "/var/log/ledger/debug.log is 14 GB and still growing (`ls -lh` it twice). `cat /etc/ledger/ledger.env` shows why. Deleting it would not free anything while ledger holds it open.", "`sudo sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/ledger/ledger.env`, `sudo systemctl restart ledger`, then empty the file in place: `sudo truncate -s 0 /var/log/ledger/debug.log`."],
      lesson: "Empty a log in place (truncate -s 0 or : >) instead of rm, which leaves the space held. Then remove the cause: the log level, and a logrotate rule with size limits.",
      tries: ["df -h", "ls -lh /var/log/ledger"]
    },
    {
      id: "inodes", title: "No space left, with space left", level: "09",
      story: "Logins to the site fail and new files cannot be created: No space left on device. df -h says / is only 56% full.",
      goal: "Make / writable again without breaking PHP sessions.",
      done: "Old session files are gone and inodes are free.",
      setup(h) {
        withNginx(h);
        h.pkgs.installed["php8.3-fpm"] = "8.3.6-0ubuntu0.24.04.2";
        h.dir("/var/lib/php", {});
        h.put("/var/lib/php/sessions", { t: "d", u: "root", g: "root", m: 0o1733,
          bulk: { n: 1129000, prefix: "sess_", names: ["sess_0a1f9c2e4b7d88a1c3f5e6b7d9", "sess_0a20b4c5d6e7f8091a2b3c4d5e", "sess_0a21c2d3e4f5061728394a5b6c"], each: 120, age: 3, u: "www-data", g: "www-data" } });
        h.file("/etc/php/8.3/fpm/php.ini", "[Session]\nsession.save_path = \"/var/lib/php/sessions\"\nsession.gc_probability = 0\nsession.gc_maxlifetime = 1440\n");
      },
      after(h) { for (const mm of [6, 2]) h.log("php-fpm8.3", 'PHP Warning:  session_start(): open(/var/lib/php/sessions/sess_9fe1c, O_RDWR) failed: No space left on device (28)', { t: ago(h, mm * MIN), pid: 1810, prio: 4 }); },
      won: (h) => { const m = h.mounts[0]; const n = h.fs.get("/var/lib/php/sessions"); return h.usage(m).inodes / m.inodes < 0.8 && Boolean(n) && (n.m & 0o7777) === 0o1733; },
      check(h) {
        const m = h.mounts[0];
        const n = h.fs.get("/var/lib/php/sessions");
        return { label: "inodes on /", ok: this.won(h), text: !n ? "sessions folder deleted: PHP cannot save sessions" : `${Math.ceil(Math.min(1, h.usage(m).inodes / m.inodes) * 100)}% used${(n.m & 0o7777) !== 0o1733 ? ", sessions folder has the wrong mode" : ""}` };
      },
      hints: ["`df -h /` has room, so check the other limit: `df -i /`. IUse% is 100%.", "Every file needs an inode. Find where they went: `sudo du --inodes` is not here, but `sudo ls /var/lib/php/sessions | wc -l` is: over a million session files. `rm /var/lib/php/sessions/*` fails with Argument list too long.", "Let find delete them without building a command line: `sudo find /var/lib/php/sessions -type f -mmin +1440 -delete`. Keep the folder: PHP needs it, mode 1733."],
      lesson: "Disks can run out of inodes before bytes: check df -i. Delete huge file counts with find -delete, and fix the cleanup job that should have done it (Ubuntu's phpsessionclean timer).",
      tries: ["df -h", "df -i"]
    },
    {
      id: "growfs", title: "The disk grew, the filesystem did not", level: "10",
      story: "/ was at 96%, so the volume was resized from 20 GB to 50 GB in the cloud console an hour ago. df still says 20G.",
      goal: "Make / use the whole 50 GB disk, online.",
      done: "/ is 50 GB.",
      setup(h) {
        const dk = h.disks[0];
        dk.size = 50 * GiB;
        dk.parts[0].fsSize = dk.parts[0].size;
        h.mounts[0].base = 18.4 * GiB;
        h.bin("/usr/bin/growpart");
      },
      won: (h) => h.mounts[0].size > 45 * GiB,
      check(h) { return { label: "/ size", ok: this.won(h), text: `${L.human(h.mounts[0].size)} of a ${L.human(h.disks[0].size)} disk, ${Math.ceil(Math.min(1, rootUse(h) / 0.95) * 100)}% used` }; },
      hints: ["`lsblk`: the disk is 50G, the partition still 19.9G. `df -h /` shows the filesystem.", "Three layers: disk, partition, filesystem. The cloud grew only the disk. `resize2fs` alone says Nothing to do: the partition is still small.", "`sudo growpart /dev/nvme0n1 1` grows partition 1, then `sudo resize2fs /dev/nvme0n1p1` grows ext4 to fill it. Both work while mounted."],
      lesson: "Growing a volume is three steps: disk (cloud), partition (growpart), filesystem (resize2fs, or xfs_growfs for XFS).",
      tries: ["lsblk", "df -h /"]
    },
    {
      id: "readonly", title: "Read-only file system", level: "10",
      story: "The ingest service stopped writing at 03:12. Every write to /data fails with Read-only file system, even as root.",
      goal: "Get /data writable again safely, with ingest running.",
      done: "/data was checked, remounted read-write, and ingest runs.",
      setup(h) {
        h.disks.push({ name: "nvme1n1", size: 100 * GiB, parts: [{ name: "nvme1n1p1", size: 100 * GiB - MiB, fs: "ext4", uuid: "c41d2a0e-7e5b-4c13-9a41-5b0f7d2e8c36", used: 38 * GiB, inodes: 6553600, iused: 41208, errors: true }] });
        h.fs.get("/etc/fstab").data += "UUID=c41d2a0e-7e5b-4c13-9a41-5b0f7d2e8c36\t/data\text4\tdefaults,nofail\t0 2\n";
        h.dir("/data/ingest", { u: "app", g: "app" });
        h.bin("/opt/ingest/bin/ingest");
        unit(h, "ingest.service", svcText({ desc: "Event ingest", unit: "After=network-online.target data.mount\nRequiresMountsFor=/data\n", service: "User=app\nWorkingDirectory=/data/ingest\nExecStart=/opt/ingest/bin/ingest --out /data/ingest\nRestart=on-failure\nRestartSec=5" }));
        h.apps["/opt/ingest/bin/ingest"] = service({ ident: "ingest", port: 0, rss: 54000, proc: () => ({ cwd: "/data/ingest", fds: [{ fd: 5, path: "/data/ingest/current.json", mode: "w" }] }),
          check: (hh) => { const m = hh.mountOf("/data/ingest"); return !m || m.mnt !== "/data" ? ["ingest: /data is not mounted, refusing to write to the root disk"] : m.ro ? ["ingest: open /data/ingest/batch-118205.json: read-only file system"] : null; } });
      },
      after(h) {
        const m = h.mounts.find((x) => x.mnt === "/data");
        m.ro = true;
        const t = (h.clock - h.boot) / 1000 - 6 * 3600;
        h.dmesg("EXT4-fs error (device nvme1n1p1): ext4_validate_block_bitmap:421: comm ingest: bg 193: bad block bitmap checksum", t);
        h.dmesg("Aborting journal on device nvme1n1p1-8.", t + 0.01);
        h.dmesg("EXT4-fs (nvme1n1p1): Remounting filesystem read-only", t + 0.02);
        h.dmesg("EXT4-fs error (device nvme1n1p1): ext4_journal_check_start:84: comm ingest: Detected aborted journal", t + 0.03);
        for (const mm of [9, 4, 1]) logAt(h, ago(h, mm * MIN), "ingest", "ERROR write /data/ingest/batch-118204.json: read-only file system", "ingest.service", L.state(h, "ingest.service").pid, 3);
      },
      won: (h) => { const m = h.mounts.find((x) => x.mnt === "/data" && !x.gone); return Boolean(m) && !m.ro && !h.disks[1].parts[0].errors && active(h, "ingest.service"); },
      check(h) {
        const m = h.mounts.find((x) => x.mnt === "/data" && !x.gone);
        return { label: "/data", ok: this.won(h), text: !m ? "not mounted" : m.ro ? "read-only" : h.disks[1].parts[0].errors ? "writable, but the file system still has errors" : active(h, "ingest.service") ? "read-write, clean" : "clean; ingest not running" };
      },
      hints: ["`touch /data/x`, then `sudo dmesg | tail`: ext4 found an error and remounted the disk read-only to protect it.", "`mount -o remount,rw` would let writes onto a damaged file system. Check it first: e2fsck refuses on a mounted disk, and umount says busy while ingest is using it.", "`sudo systemctl stop ingest`, `sudo umount /data`, `sudo fsck -y /dev/nvme1n1p1`, `sudo mount /data`, `sudo systemctl start ingest`."],
      lesson: "errors=remount-ro protects data. Stop the writers, unmount, fsck, then mount again. Check dmesg and the disk's health for why it happened.",
      tries: ["touch /data/x", "sudo dmesg | tail"]
    },

    // --- Networking -------------------------------------------------------------------
    {
      id: "dns", title: "Temporary failure in name resolution", level: "11",
      story: "Payments and package updates both fail. ping 8.8.8.8 works, so the network is up.",
      goal: "Make name resolution work for every name, not just a few.",
      done: "The server resolves names through the VPC resolver.",
      setup(h) { h.file("/etc/resolv.conf", "# Written by the provisioning script. This server does not run systemd-resolved.\nnameserver 10.0.0.254\nsearch internal\n"); },
      won: (h) => Boolean(L.dns(h, "archive.ubuntu.com").ip && L.dns(h, "api.payments.example").ip),
      check(h) { const r = L.dns(h, "api.payments.example"); return { label: "dig api.payments.example", ok: this.won(h), text: r.ip ? r.ip : r.timeout ? "timed out" : "NXDOMAIN" }; },
      hints: ["`curl https://api.payments.example` and `ping example.com` fail on the name; `ping -c 2 8.8.8.8` works. That is DNS.", "`cat /etc/resolv.conf`: nameserver 10.0.0.254. `dig example.com` times out against it. `dig @10.0.0.2 example.com` answers: that is the VPC resolver.", "`sudo sed -i 's/10.0.0.254/10.0.0.2/' /etc/resolv.conf`. Adding names to /etc/hosts only papers over it, one name at a time."],
      lesson: "When IPs work and names do not, check /etc/resolv.conf and test each server with dig @server. Fix the resolver, not /etc/hosts.",
      tries: ["ping -c 2 8.8.8.8", "cat /etc/resolv.conf"]
    },
    {
      id: "hosts", title: "dig is right, the app is wrong", level: "11",
      story: "The database moved to a new server last week. The orders app times out connecting to it, but dig db.internal shows the new address.",
      goal: "Make orders reach the new database at 10.0.2.40.",
      done: "db.internal resolves to the new database for every program.",
      setup(h) {
        h.fs.get("/etc/hosts").data += "\n# old database, added during the 2025 outage\n10.0.2.15\tdb.internal\n";
        h.bin("/opt/orders/bin/orders");
        unit(h, "orders.service", svcText({ desc: "Orders service", service: "User=app\nExecStart=/opt/orders/bin/orders --db db.internal:5432" }));
        h.apps["/opt/orders/bin/orders"] = service({ ident: "orders", port: 8080, rss: 90000, http: (hh) => {
          const ip = L.resolve(hh, "db.internal").ip;
          return ip === "10.0.2.40" ? { code: 200, type: "application/json", body: ['{"db":"ok"}'] } : { code: 500, type: "application/json", body: [`{"db":"connect ETIMEDOUT ${ip}:5432"}`] };
        } });
      },
      after(h) { for (const mm of [8, 5, 2]) logAt(h, ago(h, mm * MIN), "orders", "Error: connect ETIMEDOUT 10.0.2.15:5432", "orders.service", L.state(h, "orders.service").pid, 3); },
      won: (h) => L.resolve(h, "db.internal").ip === "10.0.2.40" && httpCode(h, "http://localhost:8080/health") === 200,
      check(h) { return { label: "getent hosts db.internal", ok: this.won(h), text: L.resolve(h, "db.internal").ip }; },
      hints: ["`curl localhost:8080/health` shows ETIMEDOUT 10.0.2.15. `dig +short db.internal` says 10.0.2.40. Programs and dig disagree.", "dig asks DNS directly. Programs use the C library, which reads /etc/hosts first (`grep hosts /etc/nsswitch.conf`). `getent hosts db.internal` shows what programs see.", "Remove the stale line: `sudo sed -i '/db.internal/d' /etc/hosts`, then `getent hosts db.internal`."],
      lesson: "dig and nslookup skip /etc/hosts; applications do not. Use getent hosts to see what programs really resolve, and keep /etc/hosts free of stale pins.",
      tries: ["curl localhost:8080/health", "dig +short db.internal"]
    },
    {
      id: "route", title: "Network is unreachable", level: "11",
      story: "Nothing outside the subnet answers since someone was \"debugging the network\". You are still connected over the VPN.",
      goal: "Restore the default route through the subnet gateway, 10.0.1.1.",
      done: "Traffic leaves through 10.0.1.1 again.",
      after(h) {
        h.net.routes = h.net.routes.filter((r) => r.dst !== "default");
        h.log("sudo", "ubuntu : TTY=pts/2 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/sbin/ip route del default", { t: ago(h, 25 * MIN), pid: 3120 });
      },
      won: (h) => h.net.routes.some((r) => r.dst === "default" && r.via === "10.0.1.1"),
      check(h) { const d = h.net.routes.find((r) => r.dst === "default"); return { label: "default route", ok: this.won(h), text: d ? `via ${d.via}` : "none" }; },
      hints: ["`ping -c 2 8.8.8.8` says Network is unreachable before sending anything. `ip route` shows why.", "Only the local subnet route is left. `sudo grep 'ip route' /var/log/auth.log` shows who removed the default.", "`sudo ip route add default via 10.0.1.1 dev eth0`. A gateway outside the subnet is refused: Nexthop has invalid gateway."],
      lesson: "\"Network is unreachable\" means no route, before any packet leaves. ip route shows the table. Runtime changes are lost on reboot; DHCP or netplan restores the default.",
      tries: ["ping -c 2 8.8.8.8", "ip route"]
    },
    {
      id: "firewall", title: "Works locally, not from the load balancer", level: "11",
      story: "The new storefront answers on curl localhost:8080, but the load balancer marks it down: connection timed out.",
      goal: "Let lb-01 (10.0.1.5) reach port 8080, with the firewall still on.",
      done: "The firewall allows 8080 and lb-01 gets through.",
      setup(h) {
        h.net.fw = { active: true, enabled: true, rules: [{ action: "ALLOW", port: 22, proto: "tcp" }] };
        h.bin("/opt/storefront/bin/storefront");
        unit(h, "storefront.service", svcText({ desc: "Storefront", service: "User=app\nExecStart=/opt/storefront/bin/storefront --listen 0.0.0.0:8080" }));
        h.apps["/opt/storefront/bin/storefront"] = service({ ident: "storefront", port: 8080, rss: 99000 });
      },
      won: (h) => h.net.fw.active && L.inbound(h, 8080, "10.0.1.5") && active(h, "storefront.service"),
      check(h) { return { label: "lb-01 → web-01:8080", ok: this.won(h), text: !h.net.fw.active ? "open, but the firewall is off" : L.inbound(h, 8080, "10.0.1.5") ? "allowed" : "timed out (dropped)" }; },
      hints: ["`curl localhost:8080` works and `sudo ss -tlnp` shows 0.0.0.0:8080, so the app is fine. Timed out (not refused) from outside means something drops packets.", "`sudo ufw status verbose`: default deny incoming, and only 22/tcp allowed.", "`sudo ufw allow 8080/tcp`, or tighter: `sudo ufw allow from 10.0.1.0/24 to any port 8080`. Disabling the firewall is not the fix."],
      lesson: "Refused means nothing listens; timed out means something drops. Open only the port you need, from where you need it.",
      tries: ["curl localhost:8080", "sudo ufw status verbose"]
    },
    {
      id: "listenlocal", title: "Listening on 127.0.0.1 only", level: "11",
      story: "Same symptom, different server: the storefront works on curl localhost:8080 but the load balancer gets connection refused. There is no firewall here.",
      goal: "Make the storefront reachable from lb-01.",
      done: "The storefront listens on all interfaces.",
      setup(h) {
        h.bin("/opt/storefront/bin/storefront");
        h.file("/etc/storefront/storefront.env", "# Bind address and port\nBIND=127.0.0.1\nPORT=8080\n");
        unit(h, "storefront.service", svcText({ desc: "Storefront", service: "User=app\nEnvironmentFile=/etc/storefront/storefront.env\nExecStart=/opt/storefront/bin/storefront" }));
        h.apps["/opt/storefront/bin/storefront"] = service({ ident: "storefront", port: 8080, rss: 99000 });
      },
      won: (h) => { const p = mainProc(h, "storefront.service"); return Boolean(p) && p.listen.some((l) => l.addr === "0.0.0.0" || l.addr === "10.0.1.10"); },
      check(h) { const p = mainProc(h, "storefront.service"); return { label: "lb-01 → web-01:8080", ok: this.won(h), text: !p ? "storefront is down" : this.won(h) ? "connected" : "connection refused" }; },
      hints: ["`curl localhost:8080` works; `curl 10.0.1.10:8080` (this host's own address) is refused.", "`sudo ss -tlnp`: Local Address 127.0.0.1:8080. A socket bound to loopback never sees traffic from other machines.", "`sudo sed -i 's/BIND=127.0.0.1/BIND=0.0.0.0/' /etc/storefront/storefront.env`, then `sudo systemctl restart storefront`."],
      lesson: "Check the Local Address column in ss -tlnp: 127.0.0.1 means local only, 0.0.0.0 means every interface. Opening a firewall cannot help a loopback-only socket.",
      tries: ["curl 10.0.1.10:8080", "sudo ss -tlnp"]
    },
    {
      id: "hostname", title: "sudo: unable to resolve host", level: "11",
      story: "This server was renamed from web-01 to web-02. Since then every sudo prints a warning and takes a few seconds.",
      goal: "Keep the name web-02 and make sudo stop complaining.",
      done: "web-02 resolves locally and sudo is quiet.",
      setup(h) { h.file("/etc/hostname", "web-02\n"); },
      after(h) { h.hostname = "web-02"; },
      won: (h) => h.hostname === "web-02" && Boolean(L.resolve(h, "web-02").ip),
      check(h) { return { label: `getent hosts ${h.hostname}`, ok: this.won(h), text: h.hostname !== "web-02" ? `renamed back to ${h.hostname}` : L.resolve(h, "web-02").ip || "not found" }; },
      hints: ["Run `sudo true`. Then `hostname` and `getent hosts $(hostname)`.", "sudo looks up the machine's own name. `cat /etc/hosts`: it still says 127.0.1.1 web-01.", "`sudo sed -i 's/web-01/web-02/' /etc/hosts`. Renaming the host back is not the fix."],
      lesson: "After hostnamectl set-hostname, update /etc/hosts too (the 127.0.1.1 line), or sudo and other tools wait on DNS for their own name.",
      tries: ["sudo true", "cat /etc/hosts"]
    },

    // --- Users and security --------------------------------------------------------------
    {
      id: "groups", title: "Added to a group, lost the others", level: "04",
      story: "Alice joined the developers team and needs to write to /srv/shared. She must keep running docker.",
      goal: "Give alice write access to /srv/shared without removing her other groups.",
      done: "alice is in developers and still in docker.",
      setup(h) {
        addUser(h, "alice:x:1002:1002:Alice,,,:/home/alice:/bin/bash", "alice:x:1002:");
        h.fs.get("/etc/group").data += "docker:x:998:alice\ndevelopers:x:1003:bob\n";
        h.fs.get("/etc/passwd").data += "bob:x:1004:1004:Bob,,,:/home/bob:/bin/bash\n";
        h.fs.get("/etc/group").data += "bob:x:1004:\n";
        h.dir("/home/alice", { u: "alice", g: "alice", m: 0o750 });
        h.dir("/srv/shared", { g: "developers", m: 0o2775 });
      },
      won: (h) => { const g = h.groupsOf("alice"); return g.includes("developers") && g.includes("docker"); },
      check(h) { return { label: "id alice", ok: this.won(h), text: h.groupsOf("alice").join(", ") }; },
      hints: ["`ls -ld /srv/shared` (group developers, setgid) and `id alice`.", "Add a supplementary group with usermod. Careful: `usermod -G developers alice` replaces all of her groups, docker included.", "`sudo usermod -aG developers alice` (append). She needs to log in again for it to apply to her sessions. `sudo -u alice touch /srv/shared/x` tests it."],
      lesson: "usermod -G sets the whole list; -aG appends. Group changes apply to new logins, so the user must log in again.",
      tries: ["id alice", "ls -ld /srv/shared"]
    },
    {
      id: "sshkey", title: "UNPROTECTED PRIVATE KEY FILE", level: "12",
      story: "Your key was copied to this server so a job can ssh to db-01. The job fails with Permission denied (publickey), although the key is right.",
      goal: "Let ssh use your key to reach deploy@db-01.",
      done: "ssh uses the key and reaches db-01.",
      setup(h) {
        h.file("/home/ubuntu/.ssh/id_ed25519", "-----BEGIN PRACTICE KEY-----\n(practice key for the playground; it is not a real key)\n-----END PRACTICE KEY-----\n", { u: "ubuntu", g: "ubuntu", m: 0o644 });
        h.file("/home/ubuntu/.ssh/id_ed25519.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPracticeKeyOnlyNotARealKey ubuntu@web-01\n", { u: "ubuntu", g: "ubuntu", m: 0o644 });
      },
      won: (h) => { const n = h.fs.get("/home/ubuntu/.ssh/id_ed25519"); return n.u === "ubuntu" && !(n.m & 0o077) && Boolean(n.m & 0o400); },
      check(h) { const n = h.fs.get("/home/ubuntu/.ssh/id_ed25519"); return { label: "ssh deploy@db-01", ok: this.won(h), text: this.won(h) ? "authenticated" : `refused: key is ${(n.m & 0o777).toString(8)}` }; },
      hints: ["`ssh deploy@db-01 hostname` and read the whole message.", "OpenSSH refuses private keys that anyone else can read. `ls -l ~/.ssh`.", "`chmod 600 ~/.ssh/id_ed25519` (400 works too). The .pub file can stay 644."],
      lesson: "Private keys must be readable by their owner only (600 or 400), and ~/.ssh should be 700. ssh ignores a key that is too open.",
      tries: ["ssh deploy@db-01 hostname", "ls -l ~/.ssh"]
    },
    {
      id: "sshauth", title: "Authentication refused: bad ownership or modes", level: "12",
      story: "The CI runner (10.0.1.30) deploys as deploy@web-01. Since someone \"fixed permissions\" in deploy's home, its key is rejected.",
      goal: "Let the CI key log in as deploy again, without weakening anything.",
      done: "sshd accepts deploy's key.",
      setup(h) {
        addUser(h, "deploy:x:1003:1003:CI deploys,,,:/home/deploy:/bin/bash", "deploy:x:1003:");
        h.dir("/home/deploy", { u: "deploy", g: "deploy", m: 0o755 });
        h.dir("/home/deploy/.ssh", { u: "deploy", g: "deploy", m: 0o777 });
        h.file("/home/deploy/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIrunnerPracticeKeyNotReal ci@runner\n", { u: "deploy", g: "deploy", m: 0o666 });
      },
      after(h) {
        for (const mm of [12, 6, 1]) {
          h.log("sshd", "Authentication refused: bad ownership or modes for directory /home/deploy/.ssh", { t: ago(h, mm * MIN), pid: 3200 + mm, unit: "ssh.service" });
          h.log("sshd", "Connection closed by authenticating user deploy 10.0.1.30 port 51122 [preauth]", { t: ago(h, mm * MIN), pid: 3200 + mm, unit: "ssh.service" });
        }
      },
      won: (h) => L.sshdAccepts(h, "deploy").ok,
      check(h) { const r = L.sshdAccepts(h, "deploy"); return { label: "ci-runner → deploy@web-01", ok: r.ok, text: r.ok ? "accepted" : r.why.replace("Authentication refused: ", "") }; },
      hints: ["On the server side, sshd says why: `sudo journalctl -u ssh -n 6` (or `sudo tail /var/log/auth.log`).", "StrictModes: sshd ignores authorized_keys when the home, ~/.ssh or the file can be written by anyone but the user. `ls -ld /home/deploy /home/deploy/.ssh; ls -l /home/deploy/.ssh`.", "`sudo chmod 700 /home/deploy/.ssh` and `sudo chmod 600 /home/deploy/.ssh/authorized_keys`."],
      lesson: "sshd refuses keys in writable places: ~/.ssh 700, authorized_keys 600, home not group- or world-writable. The server's journal says exactly which path is wrong.",
      tries: ["sudo journalctl -u ssh -n 6", "ls -la /home/deploy/.ssh"]
    },
    {
      id: "sudoers", title: "sudo: parse error in sudoers", level: "12",
      story: "Someone added a rule for the deploy user by editing a file in /etc/sudoers.d directly. Now sudo is broken for everyone. Luckily you still have a root console open.",
      goal: "Repair sudo, keeping deploy's right to restart orders.",
      done: "sudoers parses again and deploy can restart orders.",
      user: "root",
      setup(h) {
        addUser(h, "deploy:x:1003:1003:CI deploys,,,:/home/deploy:/bin/bash", "deploy:x:1003:");
        h.dir("/home/deploy", { u: "deploy", g: "deploy" });
        h.bin("/opt/orders/bin/orders");
        unit(h, "orders.service", svcText({ desc: "Orders service", service: "User=app\nExecStart=/opt/orders/bin/orders" }));
        h.apps["/opt/orders/bin/orders"] = service({ ident: "orders", port: 8080 });
        h.file("/etc/sudoers.d/deploy", "# CI deploys restart orders after each release\ndeploy ALL=(root) NOPASSWD /usr/bin/systemctl restart orders\n", { m: 0o644 });
      },
      won: (h) => {
        const s = L.sudoers(h);
        if (s.error || s.warn.length) return false;
        const a = L.sudoAllowed(h, "deploy", "/usr/bin/systemctl restart orders");
        return Boolean(a.hit) && !a.hit.cmds.includes("ALL") && (h.fs.get("/etc/sudoers.d/deploy").m & 0o777) === 0o440;
      },
      check(h) {
        const s = L.sudoers(h);
        const a = !s.error && L.sudoAllowed(h, "deploy", "/usr/bin/systemctl restart orders");
        return { label: "sudo", ok: this.won(h), text: s.error ? `parse error in ${s.error.path}` : s.warn.length ? s.warn[0].replace("sudo: ", "") : !a.hit ? "works, but deploy lost its rule" : this.won(h) ? "parses; deploy may restart orders" : "deploy's rule is too broad" };
      },
      hints: ["Run `visudo -c`. It checks every sudoers file and names the broken one.", "`cat /etc/sudoers.d/deploy`: NOPASSWD needs a colon (`NOPASSWD:`). Also check `ls -l /etc/sudoers.d`: sudoers files should be 0440.", "`sed -i 's/NOPASSWD \\//NOPASSWD: \\//' /etc/sudoers.d/deploy`, `chmod 440 /etc/sudoers.d/deploy`, `visudo -c`. Next time edit with `visudo -f /etc/sudoers.d/deploy`."],
      lesson: "One syntax error in any sudoers file disables sudo for everyone. Always edit with visudo (it checks before saving) and keep a root session open while you test.",
      tries: ["visudo -c", "cat /etc/sudoers.d/deploy"]
    },
    {
      id: "sudocmd", title: "Sorry, user deploy is not allowed to execute", level: "12",
      story: "The orders-api unit was renamed to orders. Since then the CI deploy fails at its last step, sudo systemctl restart orders.",
      goal: "Let deploy restart orders through sudo, and nothing more.",
      done: "deploy may run exactly systemctl restart orders.",
      setup(h) {
        addUser(h, "deploy:x:1003:1003:CI deploys,,,:/home/deploy:/bin/bash", "deploy:x:1003:");
        h.dir("/home/deploy", { u: "deploy", g: "deploy" });
        h.bin("/opt/orders/bin/orders");
        unit(h, "orders.service", svcText({ desc: "Orders service", service: "User=app\nExecStart=/opt/orders/bin/orders" }));
        h.apps["/opt/orders/bin/orders"] = service({ ident: "orders", port: 8080 });
        h.file("/etc/sudoers.d/ci-deploy", "# CI restarts the API after each release\ndeploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart orders-api\n", { m: 0o440 });
      },
      after(h) { h.log("sudo", "  deploy : command not allowed ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart orders", { t: ago(h, 7 * MIN), pid: 3301, prio: 2 }); },
      won: (h) => {
        const a = L.sudoAllowed(h, "deploy", "/usr/bin/systemctl restart orders");
        return !a.error && Boolean(a.hit) && !a.rules.some((r) => r.cmds.includes("ALL"));
      },
      check(h) {
        const a = L.sudoAllowed(h, "deploy", "/usr/bin/systemctl restart orders");
        return { label: "sudo -u deploy sudo systemctl restart orders", ok: this.won(h), text: a.error ? "sudoers is broken" : !a.hit ? "not allowed" : a.rules.some((r) => r.cmds.includes("ALL")) ? "allowed, but deploy can now run anything as root" : "allowed" };
      },
      hints: ["Reproduce it as deploy: `sudo -u deploy sudo systemctl restart orders`. Then `sudo -l -U deploy`.", "The rule names /usr/bin/systemctl restart orders-api. sudo matches the command and its arguments exactly.", "`sudo sed -i 's/restart orders-api/restart orders/' /etc/sudoers.d/ci-deploy`, then `sudo visudo -c`. Do not give CI `ALL`."],
      lesson: "sudo rules match the full command line. Keep CI rules narrow (one command, exact arguments) and update them when you rename things.",
      tries: ["sudo -u deploy sudo systemctl restart orders", "sudo -l -U deploy"]
    },
    {
      id: "secretperm", title: "A world-readable secrets file", level: "12",
      story: "A security scan flags /etc/payments/payments.env: it holds the database password and any user on the box can read it.",
      goal: "Make the file readable only by root and the payments service, with payments still running.",
      done: "payments.env is 640 root:payments and the service runs.",
      setup(h) {
        addUser(h, "payments:x:1005:1005::/srv/payments:/usr/sbin/nologin", "payments:x:1005:");
        h.file("/etc/payments/payments.env", "DB_HOST=db.internal\nDB_USER=payments\nDB_PASSWORD=practice-only-not-real\n", { m: 0o644 });
        h.bin("/opt/payments/bin/payments");
        unit(h, "payments.service", svcText({ desc: "Payments service", service: "User=payments\nExecStart=/opt/payments/bin/payments --env-file /etc/payments/payments.env" }));
        h.apps["/opt/payments/bin/payments"] = service({ ident: "payments", port: 8088, check: (hh) => { const n = hh.fs.get("/etc/payments/payments.env"); return n && hh.can("payments", n, 4) ? null : ["Error: EACCES: permission denied, open '/etc/payments/payments.env'"]; } });
      },
      won: (h) => { const n = h.fs.get("/etc/payments/payments.env"); return Boolean(n) && !(n.m & 0o007) && h.can("payments", n, 4) && active(h, "payments.service"); },
      check(h) {
        const n = h.fs.get("/etc/payments/payments.env");
        return { label: "payments.env", ok: this.won(h), text: `${L.modeStr(n)} ${n.u}:${n.g}${n.m & 0o004 ? " · readable by everyone" : !h.can("payments", n, 4) ? " · payments cannot read it" : ""}${active(h, "payments.service") ? "" : " · payments is down"}` };
      },
      hints: ["`ls -l /etc/payments/payments.env` and `systemctl cat payments`: which user reads the file?", "payments runs as user payments and opens the file itself. Root-only (600) breaks it at the next restart; 644 leaks it.", "`sudo chown root:payments /etc/payments/payments.env`, `sudo chmod 640 /etc/payments/payments.env`, then prove it: `sudo systemctl restart payments`."],
      lesson: "Secrets files: owner root, group the service's group, mode 640 (or 600 owned by the service user). Restart to prove the service can still read it.",
      tries: ["ls -l /etc/payments/payments.env", "systemctl cat payments"]
    },
    {
      id: "exposedport", title: "Redis open to the network", level: "12",
      story: "An audit found Redis on this host answering anyone on the network, with no password. Only the local app should use it.",
      goal: "Make Redis listen on localhost only.",
      done: "Redis listens on 127.0.0.1 only.",
      setup(h) {
        h.pkgs.installed["redis-server"] = "5:7.0.15-1build2";
        h.bin("/usr/bin/redis-server");
        h.file("/etc/redis/redis.conf", "# Redis configuration\nbind 0.0.0.0\nprotected-mode no\nport 6379\ndaemonize no\nsupervised systemd\n", { u: "redis", g: "redis", m: 0o640 });
        addUser(h, "redis:x:114:121::/var/lib/redis:/usr/sbin/nologin", "redis:x:121:");
        h.file("/usr/lib/systemd/system/redis-server.service", "[Unit]\nDescription=Advanced key-value store\nAfter=network.target\n\n[Service]\nType=notify\nUser=redis\nExecStart=/usr/bin/redis-server /etc/redis/redis.conf\n\n[Install]\nWantedBy=multi-user.target\n");
        enable(h, "redis-server.service");
        h.apps["/usr/bin/redis-server"] = (hh) => {
          const conf = hh.read("/etc/redis/redis.conf") || "";
          const bind = ((/^\s*bind\s+(.+)$/m.exec(conf) || [, "0.0.0.0"])[1]).trim().split(/\s+/).filter((a) => !a.startsWith("-") && !a.includes(":"));
          return { ident: "redis-server", proc: { comm: "redis-server", args: `/usr/bin/redis-server ${bind.join(" ")}:6379`, user: "redis", rss: 11800, listen: bind.map((addr) => ({ addr, port: 6379 })) }, log: ["* Ready to accept connections tcp"] };
        };
      },
      won: (h) => { const p = mainProc(h, "redis-server.service"); return Boolean(p) && p.listen.length > 0 && p.listen.every((l) => l.addr.startsWith("127.")); },
      check(h) { const p = mainProc(h, "redis-server.service"); return { label: "redis listens on", ok: this.won(h), text: p ? p.listen.map((l) => `${l.addr}:${l.port}`).join(", ") : "not running" }; },
      hints: ["`sudo ss -tlnp | grep 6379`: 0.0.0.0 means every interface.", "The address comes from `bind` in /etc/redis/redis.conf. A firewall rule would hide it, but Redis would still accept anyone who gets past it.", "`sudo sed -i 's/^bind 0.0.0.0/bind 127.0.0.1 -::1/' /etc/redis/redis.conf`, then `sudo systemctl restart redis-server`. Set protected-mode yes too."],
      lesson: "Bind internal services to 127.0.0.1 (or a private interface) and require auth. A firewall is a second layer, not the first.",
      tries: ["sudo ss -tlnp", "grep bind /etc/redis/redis.conf"]
    },

    // --- Boot and kernel ----------------------------------------------------------------
    {
      id: "fstab", title: "Emergency mode after an fstab change", level: "13",
      story: "A data disk was added and /etc/fstab edited. After the reboot the server never came back: the console shows \"You are in emergency mode\". You are logged in as root on the console.",
      goal: "Boot normally with /data mounted.",
      done: "The server booted normally with /data mounted.",
      user: "root",
      setup(h) {
        h.disks.push({ name: "nvme1n1", size: 100 * GiB, parts: [{ name: "nvme1n1p1", size: 100 * GiB - MiB, fs: "ext4", uuid: "7c1e0b6a-90d1-4b8e-a3f5-2e64c2a71b9e", used: 2 * GiB, inodes: 6553600, iused: 11 }] });
        h.fs.get("/etc/fstab").data += "UUID=7c1e0b6a-90d1-4b8e-a3f5-2e64c2a71b9f\t/data\text4\tdefaults\t0 2\n";
        h.dir("/data");
      },
      intro: ["You are in emergency mode. After logging in, type \"journalctl -xb\" to view", "system logs, \"systemctl reboot\" to reboot, or \"exit\"", "to continue bootup."],
      won: (h) => !h.emergency && h.mounts.some((m) => m.mnt === "/data" && !m.gone) && L.fstab(h).some((e) => e.mnt === "/data" && e.spec.includes("7c1e0b6a-90d1-4b8e-a3f5-2e64c2a71b9e")),
      check(h) { const m = h.mounts.some((x) => x.mnt === "/data" && !x.gone); return { label: "boot", ok: this.won(h), text: h.emergency ? "emergency mode" : m ? "multi-user, /data mounted" : "booted, but /data is not mounted" }; },
      hints: ["`journalctl -xb | grep -i -e failed -e timed` (or just `journalctl -xb`): a device for /data timed out.", "Compare `blkid` with `cat /etc/fstab`: one character of the UUID is wrong. The root file system is read-only here, so first `mount -o remount,rw /`.", "`sed -i 's/71b9f/71b9e/' /etc/fstab`, `systemctl daemon-reload`, `mount -a` (no output means fine), then `systemctl default` or `reboot`."],
      lesson: "A bad fstab line stops the boot. Test with mount -a before rebooting, use UUIDs from blkid, and add nofail to disks the system can boot without.",
      tries: ["journalctl -xb", "blkid"]
    },
    {
      id: "ipforward", title: "The NAT gateway stopped routing", level: "13",
      story: "This server is the NAT gateway for the private subnet 10.0.2.0/24. After last night's reboot, private servers cannot reach the internet. It worked for months.",
      goal: "Forward traffic again, and keep it working after the next reboot.",
      done: "IP forwarding is on now and on every boot.",
      won: (h) => h.sysctl["net.ipv4.ip_forward"] === "1" && persisted(h, "net.ipv4.ip_forward") === "1",
      check(h) { const now = h.sysctl["net.ipv4.ip_forward"] === "1"; return { label: "10.0.2.15 → internet", ok: this.won(h), text: !now ? "dropped: forwarding is off" : persisted(h, "net.ipv4.ip_forward") !== "1" ? "routed now; off again after a reboot" : "routed" }; },
      hints: ["`sysctl net.ipv4.ip_forward` (or `cat /proc/sys/net/ipv4/ip_forward`).", "0: the kernel drops packets that are not for this host. Someone set it with sysctl -w months ago, which lasts until reboot. `grep -r forward /etc/sysctl.conf /etc/sysctl.d`.", "`sudo sysctl -w net.ipv4.ip_forward=1` for now, and `echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf` for every boot. `sudo sysctl --system` reapplies all files."],
      lesson: "sysctl -w changes the running kernel only. Persist settings in /etc/sysctl.d/*.conf, and test with a reboot.",
      tries: ["sysctl net.ipv4.ip_forward", "grep -r forward /etc/sysctl.conf /etc/sysctl.d"]
    },
    {
      id: "time", title: "Certificate is not yet valid", level: "13",
      story: "HTTPS calls fail with certificate is not yet valid and apt update refuses every repository. The certificates are fine.",
      goal: "Fix the clock and keep it synchronized.",
      done: "The clock is synchronized by NTP.",
      clock: Date.UTC(2026, 9, 27, 6, 33, 0),
      setup(h) { h.clockSkew = -(Date.UTC(2026, 9, 30, 9, 14, 0) - Date.UTC(2026, 9, 27, 6, 33, 0)); h.fs.delete("/etc/systemd/system/multi-user.target.wants/systemd-timesyncd.service"); },
      won: (h) => !h.clockSkew && active(h, "systemd-timesyncd.service") && L.enabledState(h, "systemd-timesyncd.service") === "enabled",
      check(h) { return { label: "clock", ok: this.won(h), text: h.clockSkew ? "3 days behind" : active(h, "systemd-timesyncd.service") ? "synchronized" : "set by hand; NTP is off" }; },
      hints: ["`date`, and `curl -I https://api.payments.example`. A certificate is \"not yet valid\" when your clock is earlier than its start date.", "`timedatectl`: System clock synchronized: no, NTP service: inactive.", "`sudo timedatectl set-ntp true` enables and starts systemd-timesyncd. `date -s` would fix it once and drift again."],
      lesson: "TLS, apt, Kerberos and logs all need the right time. Run an NTP client (timedatectl set-ntp true) instead of setting the clock by hand.",
      tries: ["date", "timedatectl"]
    },
    {
      id: "rebootrequired", title: "Patched, but still vulnerable", level: "13",
      story: "Unattended upgrades installed a kernel security fix two days ago. The vulnerability scanner still flags this server.",
      goal: "Run the patched kernel, with every service back afterwards.",
      done: "The server runs kernel 6.8.0-1016-aws.",
      setup(h) {
        withNginx(h);
        h.pendingKernel = "6.8.0-1016-aws";
        h.file("/run/reboot-required", "*** System restart required ***\n");
        h.file("/run/reboot-required.pkgs", "linux-image-6.8.0-1016-aws\nlinux-base\n");
      },
      won: (h) => h.kernel === "6.8.0-1016-aws" && active(h, "nginx.service"),
      check(h) { return { label: "running kernel", ok: this.won(h), text: h.kernel + (h.pendingKernel ? " (6.8.0-1016-aws installed)" : "") }; },
      hints: ["`uname -r` shows the running kernel; `ls /run/reboot-required*` or `cat /run/reboot-required.pkgs` says what is waiting.", "A new kernel package changes nothing until the machine boots it. Restarting services does not load a kernel.", "Plan the window, then `sudo reboot`. Afterwards check `uname -r` and `systemctl --failed`."],
      lesson: "Kernel (and libc) updates need a reboot. /run/reboot-required says so. Schedule reboots, or use livepatch, and check services after.",
      tries: ["uname -r", "cat /run/reboot-required.pkgs"]
    },
    {
      id: "dpkglock", title: "Could not get lock /var/lib/dpkg/lock-frontend", level: "13",
      story: "You need jq on this fresh server for a deploy script. apt install says another process holds the lock.",
      goal: "Install jq without damaging the package database.",
      done: "jq is installed and dpkg is healthy.",
      after(h) {
        h.file("/var/lib/dpkg/lock-frontend", "", { m: 0o640 });
        h.file("/var/lib/dpkg/lock", "", { m: 0o640 });
        const finish = h.clock + 75000;
        L.spawn(h, { pid: 2810, comm: "unattended-upgr", args: "/usr/bin/python3 /usr/bin/unattended-upgrade --update-only", cpu: 22, rss: 98000, holdsDpkg: true, start: ago(h, 4 * MIN),
          onSignal: (hh) => { hh.dpkgBroken = true; return false; } });
        h.log("unattended-upgrades", "Starting unattended upgrades script", { t: ago(h, 4 * MIN), pid: 2810 });
        h.everyTick = (hh) => {
          const p = L.procOf(hh, 2810);
          if (p && hh.clock >= finish) {
            L.die(hh, p, "exit");
            hh.log("unattended-upgrades", "All upgrades installed", { pid: 2810 });
          }
        };
      },
      won: (h) => Boolean(h.pkgs.installed.jq) && !h.dpkgBroken,
      check(h) { return { label: "dpkg", ok: this.won(h), text: h.dpkgBroken ? "interrupted: run dpkg --configure -a" : L.procOf(h, 2810) ? "locked by unattended-upgr (PID 2810)" : h.pkgs.installed.jq ? "jq installed" : "free" }; },
      hints: ["`sudo apt install jq` names the process holding the lock. `ps -fp 2810`.", "It is unattended-upgrades, installing security updates on a new server. Deleting the lock files or killing it can leave dpkg half-configured.", "Wait for it: `sleep 60`, check with `ps -p 2810`, then `sudo apt install jq`. If dpkg was interrupted, `sudo dpkg --configure -a` repairs it."],
      lesson: "The dpkg lock protects the package database. Wait for the holder (often unattended-upgrades); never delete lock files. dpkg --configure -a finishes interrupted work.",
      tries: ["sudo apt install jq", "ps -fp 2810"]
    },

    // --- Performance ----------------------------------------------------------------------
    {
      id: "iowait", title: "High load, idle CPU", level: "14",
      story: "Load average is 9 on a 2-CPU server and pages take 5 seconds, yet top shows the CPUs mostly idle. Tonight's full backup started early.",
      goal: "Make the site fast again without losing the backup.",
      done: "The backup runs at idle I/O priority and the site is fast.",
      setup: withNginx,
      after(h) {
        for (const pid of [1810, 1811, 1812]) L.spawn(h, { pid, user: "www-data", comm: "php-fpm8.3", args: "php-fpm: pool www", rss: 41000, ioVictim: true, start: ago(h, 2 * DAY) });
        L.spawn(h, { pid: 3410, user: "root", comm: "tar", args: "tar -czf /backup/full-2026-10-30.tar.gz /srv /var/lib", cpu: 11, rss: 9000, io: true, start: ago(h, 25 * MIN), onSignal: (hh, sig) => { if (sig === "STOP" || sig === "CONT") return false; hh.backupLost = true; return false; } });
      },
      won: (h) => !h.procs.some((p) => L.statOf(h, p) === "D") && !h.backupLost && Boolean(L.procOf(h, 3410)),
      check(h) { const d = h.procs.filter((p) => L.statOf(h, p) === "D").length; return { label: "page load", ok: this.won(h), text: h.backupLost ? "fast, but tonight's backup is gone" : d ? `4.8 s · ${d} processes waiting on disk (D)` : "0.18 s" }; },
      hints: ["`top`: high load, high wa (I/O wait), little us. `vmstat 1 5`: the b column counts processes blocked on I/O.", "`ps -eo pid,stat,cmd | grep ' D'` and `sudo iotop -o`: PHP waits on the disk while tar reads 148 MB/s. nice only changes CPU priority.", "Keep the backup but put it last in line for the disk: `sudo ionice -c3 -p 3410` (idle class). Killing it loses the backup."],
      lesson: "Load counts processes waiting on disk (D state) as well as CPU. When wa is high, find the I/O hog (iotop) and lower its I/O priority with ionice.",
      tries: ["top", "sudo iotop -o"]
    },
    {
      id: "swap", title: "Swap thrashing", level: "14",
      story: "Everything is slow: ssh takes ten seconds to show a prompt. The cache warmer was given a bigger cache yesterday.",
      goal: "Stop the thrashing, with cache-warmer still running.",
      done: "cache-warmer is capped and the box no longer swaps.",
      setup(h) {
        h.mem.swap = 4 * 1024 * 1024;
        h.mem.swapBase = 220 * 1024;
        h.swaps = [{ path: "/swap.img", kib: 4 * 1024 * 1024 }];
        h.file("/swap.img", "", { m: 0o600, size: 4 * GiB, swap: true });
        h.fs.get("/etc/fstab").data += "/swap.img\tnone\tswap\tsw\t0\t0\n";
        h.bin("/opt/cache-warmer/bin/warmer");
        unit(h, "cache-warmer.service", svcText({ desc: "Cache warmer", service: "User=app\nExecStart=/opt/cache-warmer/bin/warmer --cache-size 3500m" }));
        const cap = (x) => { const m = L.parseSize(String(x || "").replace(/([KMG])$/i, "$1")); return m ? Math.round(m / 1024 * 0.94) : Infinity; };
        h.apps["/opt/cache-warmer/bin/warmer"] = (hh, x) => ({ ident: "warmer", proc: { rss: Math.min(3.5 * 1024 * 1024, cap(x.cfg.one("Service", "MemoryMax"))), cpu: 6,
          onProperty: (h2, props, p) => { for (const pr of props) if (/^MemoryMax=/.test(pr)) p.rss = Math.min(p.rss, cap(pr.split("=")[1])); } }, log: ["warming 3500 MB cache"] });
      },
      won: (h) => active(h, "cache-warmer.service") && !L.memStats(h).thrash,
      check(h) { const m = L.memStats(h); return { label: "swap activity", ok: this.won(h), text: !active(h, "cache-warmer.service") ? "quiet, but cache-warmer is stopped" : m.thrash ? `thrashing: ${(m.swapUsed / 1048576).toFixed(1)}G in swap, si/so busy` : "quiet" }; },
      hints: ["`free -h` and `vmstat 1 5`: watch si and so (swap in, swap out). Constant traffic means thrashing.", "`top -o %MEM`: warmer uses 3.4 GB on a 3.8 GB server. swappiness and swapoff will not make it fit (try `sudo swapoff -a`).", "Cap it with a cgroup limit: `sudo systemctl set-property cache-warmer MemoryMax=1G` (writes a drop-in and applies now). Then fix its --cache-size."],
      lesson: "Thrashing means the working set does not fit in RAM. Find the hog, cap it (MemoryMax=) or move it; tuning swap only changes how it fails.",
      tries: ["free -h", "vmstat 1 5"]
    },
    {
      id: "oom", title: "Killed by the OOM killer", level: "14",
      story: "The reports service restarts every few minutes. Its log just stops; there is no stack trace.",
      goal: "Keep reports running without endangering PostgreSQL on the same box.",
      done: "reports fits in memory and PostgreSQL is safe.",
      setup(h) {
        withPostgres(h);
        h.bin("/usr/bin/java");
        h.file("/etc/default/reports", "# Options for the reports service\nJAVA_OPTS=-Xmx3g\n");
        unit(h, "reports.service", svcText({ desc: "Reports service", unit: "After=postgresql.service\n", service: "User=app\nEnvironmentFile=/etc/default/reports\nExecStart=/usr/bin/java $JAVA_OPTS -jar /opt/reports/reports.jar\nRestart=always" }));
        const heapOf = (opts) => { const m = /-Xmx(\d+)([mgMG])/.exec(opts || ""); return m ? Number(m[1]) * (/g/i.test(m[2]) ? 1024 : 1) : 4096; };
        h.apps["/usr/bin/java"] = (hh, x) => ({ ident: "java", proc: { heap: heapOf(x.env.JAVA_OPTS), rss: 600 * 1024, cpu: 18 }, log: ["Started ReportsApplication in 9.204 seconds"] });
        // The heap fills toward -Xmx; when RAM runs out the kernel kills the biggest offender.
        h.everyTick = (hh, sec) => {
          const pg = mainProc(hh, "postgresql.service");
          if (pg && pg.rss < 1.1 * 1024 * 1024) pg.rss = 1.1 * 1024 * 1024;
          const j = mainProc(hh, "reports.service");
          if (!j) return;
          j.rss = Math.min(j.heap * 1024 + 260 * 1024, j.rss + 150 * 1024 * sec);
          const used = hh.procs.reduce((s, p) => s + p.rss, 0) + hh.mem.kernel;
          if (used < hh.mem.total * 0.97) return;
          const victim = hh.procs.filter((p) => p.pid > 1).sort((a, b) => (b.rss / hh.mem.total * 1000 + b.oomAdj) - (a.rss / hh.mem.total * 1000 + a.oomAdj))[0];
          const t = (hh.clock - hh.boot) / 1000;
          hh.dmesg(`java invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=${j.oomAdj}`, t);
          hh.dmesg(`Out of memory: Killed process ${victim.pid} (${victim.comm}) total-vm:${victim.vsz + victim.rss}kB, anon-rss:${victim.rss}kB, file-rss:1024kB, shmem-rss:0kB, UID:${(hh.user(victim.user) || { uid: 0 }).uid} pgtables:7124kB oom_score_adj:${victim.oomAdj}`, t + 0.01);
          if (victim.unit) hh.log("systemd", `${victim.unit}: A process of this unit has been killed by the OOM killer.`, { pid: 1, unit: victim.unit, prio: 4 });
          if (victim.unit === "postgresql.service") hh.pgKilled = true;
          victim.oomKilled = true;
          L.die(hh, victim, "killed", "KILL");
        };
      },
      after(h) {
        const t = (h.clock - h.boot) / 1000;
        for (const [ago2, pid] of [[1500, 2650], [900, 2702], [300, 2759]]) {
          h.dmesg(`Out of memory: Killed process ${pid} (java) total-vm:5832104kB, anon-rss:3201552kB, file-rss:1024kB, shmem-rss:0kB, UID:1001 pgtables:7124kB oom_score_adj:0`, t - ago2);
          logAt(h, ago(h, ago2 * 1000), "systemd", "reports.service: A process of this unit has been killed by the OOM killer.", "reports.service", 1, 4);
          logAt(h, ago(h, ago2 * 1000), "systemd", "reports.service: Main process exited, code=killed, status=9/KILL", "reports.service", 1, 4);
          logAt(h, ago(h, ago2 * 1000), "systemd", "reports.service: Failed with result 'oom-kill'.", "reports.service", 1, 4);
        }
        const j = mainProc(h, "reports.service");
        j.rss = 2.3 * 1024 * 1024;
      },
      won: (h) => { const j = mainProc(h, "reports.service"); return Boolean(j) && j.heap <= 1536 && active(h, "postgresql.service") && !h.pgKilled; },
      check(h) {
        const j = mainProc(h, "reports.service");
        return { label: "memory", ok: this.won(h), text: h.pgKilled ? "the OOM killer took PostgreSQL instead" : !j ? "reports is down" : j.heap > 1536 ? `java heap up to ${j.heap / 1024}G on a 3.8G box: OOM soon` : "fits" };
      },
      hints: ["The log just stops: something killed it. `sudo dmesg | grep -i 'out of memory'` and `journalctl -u reports -n 20`.", "Out of memory: Killed process (java). `cat /etc/default/reports`: -Xmx3g, on a 3.8 GB server that also runs PostgreSQL (1.1 GB). Protecting java with oom_score_adj only makes the kernel kill PostgreSQL instead.", "Give the heap a size that fits: `sudo sed -i 's/-Xmx3g/-Xmx1g/' /etc/default/reports`, then `sudo systemctl restart reports`. Watch `free -h` for a while."],
      lesson: "\"Killed\" with no error is often the OOM killer: dmesg says so. Size heaps and limits to the machine, and leave room for everything else on it.",
      tries: ["sudo dmesg | grep -i 'out of memory'", "free -h"]
    },
    {
      id: "ulimit", title: "Too many open files", level: "14",
      story: "Under the morning traffic the gateway starts refusing connections. Its log fills with \"Too many open files\". You raised the limit in limits.conf yesterday; nothing changed.",
      goal: "Give the gateway service enough file descriptors.",
      done: "gateway runs with LimitNOFILE=65535.",
      setup(h) {
        h.bin("/opt/gateway/bin/gateway");
        h.fs.get("/etc/security/limits.conf").data += "*               soft    nofile          65535\n*               hard    nofile          65535\n";
        unit(h, "gateway.service", svcText({ desc: "API gateway", service: "User=app\nExecStart=/opt/gateway/bin/gateway --listen 0.0.0.0:8443" }));
        h.apps["/opt/gateway/bin/gateway"] = service({ ident: "gateway", port: 8443, rss: 140000, cpu: 22 });
        h.everyTick = (hh) => {
          const p = mainProc(hh, "gateway.service");
          if (p && p.nofile < 10000 && hh.clock % 3000 < 1000) hh.log("gateway", "accept4() failed (24: Too many open files)", { pid: p.pid, unit: "gateway.service", prio: 3 });
        };
      },
      after(h) { for (const s of [40, 30, 20, 10]) logAt(h, ago(h, s * 1000), "gateway", "accept4() failed (24: Too many open files)", "gateway.service", L.state(h, "gateway.service").pid, 3); },
      won: (h) => { const p = mainProc(h, "gateway.service"); return Boolean(p) && p.nofile >= 65535; },
      check(h) { const p = mainProc(h, "gateway.service"); return { label: "gateway open files limit", ok: this.won(h), text: p ? `${p.nofile}${p.nofile < 10000 ? ": refusing connections" : ""}` : "not running" }; },
      hints: ["`journalctl -u gateway -n 5`, then the limit the process really has: `cat /proc/$(pgrep gateway)/limits | grep 'open files'`.", "Max open files 1024. limits.conf applies to PAM logins, not to systemd services, and `ulimit -n` changes only your own shell.", "A drop-in: `sudo mkdir -p /etc/systemd/system/gateway.service.d`, `printf '[Service]\\nLimitNOFILE=65535\\n' | sudo tee /etc/systemd/system/gateway.service.d/limits.conf`, `sudo systemctl daemon-reload`, `sudo systemctl restart gateway`."],
      lesson: "Services take limits from their unit (LimitNOFILE=), not from limits.conf. Check what a process really has in /proc/PID/limits.",
      tries: ["journalctl -u gateway -n 5", "cat /etc/security/limits.conf"]
    },
    // --- Added: services, logs, storage, access, memory -----------------------------------
    {
      id: "envmissing", title: "Works in my shell, not as a service", level: "06",
      story: "The reports API starts fine when you run it by hand, but the service fails: DATABASE_URL is not set. It is right there in your ~/.bashrc.",
      goal: "Give the reports-api service its DATABASE_URL so it starts.",
      done: "reports-api gets its environment from its unit.",
      setup(h) {
        h.bin("/opt/reports/bin/reports");
        h.fs.get("/home/ubuntu/.bashrc").data += "export DATABASE_URL=postgres://reports@db.internal:5432/reports\n";
        h.file("/etc/environment", 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n');
        unit(h, "reports-api.service", svcText({ desc: "Reports API", service: "User=app\nExecStart=/opt/reports/bin/reports" }));
        h.apps["/opt/reports/bin/reports"] = service({ ident: "reports", port: 8095, rss: 74000, check: (hh, x) => (x.env.DATABASE_URL ? null : ["Error: DATABASE_URL is not set", "reports: refusing to start without a database"]) });
      },
      won: (h) => active(h, "reports-api.service"),
      check(h) { return { label: "reports-api", ok: this.won(h), text: L.state(h, "reports-api.service").active }; },
      hints: ["`journalctl -u reports-api -n 5`, then `echo $DATABASE_URL` in your shell.", "A service does not run your login shell: ~/.bashrc, export and /etc/environment never reach it. `systemctl show reports-api -p Environment` shows what it gets.", "Put it in the unit with a drop-in: `sudo mkdir -p /etc/systemd/system/reports-api.service.d`, `printf '[Service]\\nEnvironment=DATABASE_URL=postgres://reports@db.internal:5432/reports\\n' | sudo tee /etc/systemd/system/reports-api.service.d/env.conf`, `sudo systemctl daemon-reload`, `sudo systemctl restart reports-api`."],
      lesson: "Services get only what their unit gives them: Environment= or EnvironmentFile= (mode 640 for secrets). Your shell's exports, ~/.bashrc and /etc/environment do not apply.",
      tries: ["journalctl -u reports-api -n 5", "echo $DATABASE_URL"]
    },
    {
      id: "logrotate", title: "logrotate is not rotating", level: "09",
      story: "/var/log/orders/orders.log is 11 GB and / is nearly full. There is a logrotate rule for it, yet it has not rotated in weeks.",
      goal: "Make logrotate rotate the orders log, free the space, and keep it working, with orders still running.",
      done: "The orders log rotates and the space is back.",
      setup(h) {
        h.mounts[0].base = 6.6 * GiB;
        addUser(h, "orders:x:1006:1006::/srv/orders:/usr/sbin/nologin", "orders:x:1006:");
        h.dir("/var/log/orders", { g: "orders", m: 0o775 });
        h.file("/var/log/orders/orders.log", "", { u: "orders", g: "orders", m: 0o640, size: 11.2 * GiB });
        h.file("/etc/logrotate.d/orders", "/var/log/orders/*.log {\n    daily\n    rotate 7\n    compress\n    missingok\n    notifempty\n    create 0640 orders orders\n}\n");
        h.bin("/opt/orders/bin/orders");
        unit(h, "orders.service", svcText({ desc: "Orders service", service: "User=orders\nExecStart=/opt/orders/bin/orders --log /var/log/orders/orders.log" }));
        h.apps["/opt/orders/bin/orders"] = service({ ident: "orders", port: 8080, rss: 92000, proc: () => ({ fds: [{ fd: 3, path: "/var/log/orders/orders.log", mode: "w" }] }) });
      },
      after(h) { for (const d of [3, 2, 1]) h.log("logrotate", 'error: skipping "/var/log/orders/orders.log" because parent directory has insecure permissions (It\'s world writable or writable by group which is not "root") Set "su" directive in config file to tell logrotate which user/group should be used for rotation.', { t: ago(h, d * DAY), pid: 3400 + d, unit: "logrotate.service", prio: 3 }); },
      won: (h) => {
        const conf = h.read("/etc/logrotate.d/orders") || "";
        const p = mainProc(h, "orders.service");
        return rootUse(h) < 0.7 && Boolean(p) && !p.fds.some((f) => f.deleted) && /copytruncate|postrotate/.test(conf) && (/^\s*su\s/m.test(conf) || !(h.fs.get("/var/log/orders").m & 0o022));
      },
      check(h) {
        const p = mainProc(h, "orders.service");
        const held = p && p.fds.some((f) => f.deleted);
        return { label: "/ in use", ok: this.won(h), text: `${Math.ceil(Math.min(1, rootUse(h) / 0.95) * 100)}%${held ? " · orders still writes a deleted file" : !/copytruncate|postrotate/.test(h.read("/etc/logrotate.d/orders") || "") ? " · rule would rotate under a running writer" : ""}` };
      },
      hints: ["Run the rule by hand in debug mode: `sudo logrotate -d /etc/logrotate.d/orders`. Then `journalctl -u logrotate`.", "logrotate skips folders that a non-root group can write (/var/log/orders is 775 orders). Add `su orders orders` to the rule. Also: orders keeps its log open, so a rename-and-compress leaves the space held by a deleted file.", "`sudo sed -i 's/^    create .*/    copytruncate\\n    su orders orders/' /etc/logrotate.d/orders`, then `sudo logrotate -f /etc/logrotate.d/orders` and `df -h /`."],
      lesson: "logrotate refuses insecure folders (fix with su or folder permissions), and a program that keeps its log open needs copytruncate or a postrotate reload, or the space stays held.",
      tries: ["sudo logrotate -d /etc/logrotate.d/orders", "ls -lh /var/log/orders"]
    },
    {
      id: "journalfull", title: "The journal is eating the disk", level: "09",
      story: "/ is at 94% on a box that only runs a small API. The biggest folder is /var/log/journal.",
      goal: "Shrink the journal now and cap it for good.",
      done: "The journal is small and capped by SystemMaxUse.",
      setup(h) {
        h.mounts[0].base = 7.1 * GiB;
        const J = L.journal.dir;
        for (let i = 1; i <= 8; i++) h.file(`${J}/system@b1f0c2d4e6a84f2${i}-000623${i}a1c9e2b11.journal`, "", { g: "systemd-journal", m: 0o640, size: 1.1 * GiB, mt: h.clock - (40 - i * 4) * DAY });
      },
      won: (h) => L.journal.bytes(h) <= GiB && L.journal.maxUse(h) != null && L.journal.maxUse(h) <= 2 * GiB,
      check(h) { return { label: "journal on disk", ok: this.won(h), text: `${L.human(L.journal.bytes(h))}${L.journal.maxUse(h) ? `, capped at ${L.human(L.journal.maxUse(h))}` : ", no cap"}` }; },
      hints: ["`journalctl --disk-usage` and `sudo du -sh /var/log/journal`.", "Archived journal files pile up until journald's default cap (10% of the file system, up to 4 GB per file set). Deleting files by hand leaves the active one open.", "`sudo journalctl --vacuum-size=500M` now; then cap it: `sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf` and `sudo systemctl restart systemd-journald`."],
      lesson: "journalctl --vacuum-size frees space now; SystemMaxUse= in journald.conf keeps it that way. Do not rm journal files.",
      tries: ["journalctl --disk-usage", "df -h /"]
    },
    {
      id: "nfsstale", title: "Stale file handle", level: "10",
      story: "After the storage team restored nfs-01 from a snapshot, everything under /mnt/shared fails with Stale file handle.",
      goal: "Get /mnt/shared working again without rebooting.",
      done: "/mnt/shared is mounted fresh.",
      setup(h) {
        h.world.records["nfs-01"] = "10.0.2.50";
        h.world.hosts["10.0.2.50"] = { name: "nfs-01", nfs: true, ports: { 2049: {} }, rtt: 0.4 };
        h.fs.get("/etc/fstab").data += "nfs-01:/exports/shared\t/mnt/shared\tnfs4\tdefaults,_netdev\t0 0\n";
        h.dir("/mnt/shared/reports");
      },
      after(h) {
        h.mounts.find((m) => m.mnt === "/mnt/shared").stale = true;
        L.spawn(h, { pid: 3620, user: "app", comm: "rsync", args: "rsync -a /mnt/shared/reports/ /srv/reports/", cwd: "/mnt/shared/reports", start: ago(h, 30 * MIN) });
      },
      won: (h) => h.boots === 0 && h.mounts.some((m) => m.mnt === "/mnt/shared" && !m.gone && !m.stale),
      check(h) { const m = h.mounts.find((x) => x.mnt === "/mnt/shared" && !x.gone); return { label: "/mnt/shared", ok: this.won(h), text: h.boots ? "fixed by a reboot: try without one" : !m ? "not mounted" : m.stale ? "Stale file handle" : "mounted" }; },
      hints: ["`ls /mnt/shared` and `df -h`. Which mount complains?", "The client holds file handles from before the restore; the server no longer knows them. Remount it. A plain `umount` says busy: something still has it open (`sudo lsof /mnt/shared` hangs here, `ps aux | grep shared` does not).", "`sudo umount -l /mnt/shared` (lazy: detach now), then `sudo mount /mnt/shared` and `ls /mnt/shared`."],
      lesson: "Stale file handle means the NFS server changed under the client. Unmount (lazily if busy) and mount again; no reboot needed.",
      tries: ["ls /mnt/shared", "df -h"]
    },
    {
      id: "bruteforce", title: "SSH brute force", level: "12",
      story: "auth.log grows by thousands of failed logins an hour from addresses all over the internet. Someone enabled password logins for a contractor last month.",
      goal: "Allow only key logins, and ban addresses that keep trying.",
      done: "Passwords are off and fail2ban bans repeat offenders.",
      setup(h) {
        h.fs.get("/etc/ssh/sshd_config.d/60-cloudimg-settings.conf").data = "# Enabled for the contractor, see ticket OPS-1182\nPasswordAuthentication yes\n";
        h.fs.get("/etc/ssh/sshd_config").data += "\n# Added after the security review\nPasswordAuthentication no\n";
        h.pkgs.repo.fail2ban = { ver: "1.0.2-3ubuntu0.1", bins: ["/usr/bin/fail2ban-client"], desc: "ban hosts that cause multiple authentication errors", install: (hh) => {
          hh.bin("/usr/bin/fail2ban-server");
          hh.file("/etc/fail2ban/jail.d/defaults-debian.conf", "[sshd]\nenabled = true\nbackend = systemd\n");
          hh.file("/usr/lib/systemd/system/fail2ban.service", "[Unit]\nDescription=Fail2Ban Service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/fail2ban-server -xf start\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n");
          hh.link("/etc/systemd/system/multi-user.target.wants/fail2ban.service", "/usr/lib/systemd/system/fail2ban.service");
          L.start(hh, "fail2ban.service");
          return ["Created symlink /etc/systemd/system/multi-user.target.wants/fail2ban.service → /usr/lib/systemd/system/fail2ban.service."];
        } };
        h.apps["/usr/bin/fail2ban-server"] = (hh) => { hh.f2bBanned = ["203.0.113.77", "198.51.100.23", "192.0.2.140"]; return { ident: "fail2ban-server", proc: { comm: "fail2ban-server", args: "/usr/bin/python3 /usr/bin/fail2ban-server -xf start", rss: 31000 }, log: ["Server ready"] }; };
        const ips = ["203.0.113.77", "198.51.100.23", "192.0.2.140"];
        h.everyTick = (hh) => {
          const sshd = mainProc(hh, "ssh.service");
          if (!sshd) return;
          const ip = ips[hh.clock / 1000 % 3];
          if ((hh.f2bBanned || []).includes(ip)) return;
          hh.sshFails = (hh.sshFails || 0) + 1;
          const port = 40000 + (hh.clock / 1000 % 20000);
          hh.log("sshd", sshd.sshd.passwordauthentication === "yes" ? `Failed password for invalid user admin from ${ip} port ${port} ssh2` : `Connection closed by invalid user admin ${ip} port ${port} [preauth]`, { pid: 3700 + hh.sshFails % 90, unit: "ssh.service" });
        };
      },
      after(h) { for (let i = 0; i < 9; i++) h.log("sshd", `Failed password for invalid user ${["admin", "root", "oracle"][i % 3]} from ${["203.0.113.77", "198.51.100.23", "192.0.2.140"][i % 3]} port ${41000 + i * 37} ssh2`, { t: ago(h, (9 - i) * 20000), pid: 3600 + i, unit: "ssh.service" }); },
      won: (h) => { const p = mainProc(h, "ssh.service"); return Boolean(p) && p.sshd.passwordauthentication === "no" && active(h, "fail2ban.service"); },
      check(h) {
        const p = mainProc(h, "ssh.service");
        return { label: "sshd", ok: this.won(h), text: `${p && p.sshd.passwordauthentication === "no" ? "keys only" : "password logins allowed"} · ${active(h, "fail2ban.service") ? "fail2ban banning" : "no fail2ban"}` };
      },
      hints: ["`sudo tail /var/log/auth.log` (or `journalctl -u ssh -n 10`). Then what sshd really uses: `sudo sshd -T | grep -i passwordauthentication`.", "sshd_config says no at the bottom, but the Include at the top is read first, and the first value wins: sshd_config.d/60-cloudimg-settings.conf says yes.", "`sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/60-cloudimg-settings.conf`, `sudo sshd -t`, `sudo systemctl reload ssh`; then `sudo apt install -y fail2ban` and `sudo fail2ban-client status sshd`."],
      lesson: "In sshd_config the first value wins, and drop-ins are read first. Check with sshd -T, test with sshd -t before reloading, use keys only, and let fail2ban ban repeat offenders.",
      tries: ["sudo tail /var/log/auth.log", "sudo sshd -T | grep -i passwordauthentication"]
    },
    {
      id: "certexpired", title: "certificate has expired", level: "12",
      story: "Browsers show a red warning on the shop since Wednesday. Certificates renew automatically… or used to, before last month's migration.",
      goal: "Serve a valid certificate now, and make renewal automatic again.",
      done: "nginx serves a renewed certificate and the renewal timer is on.",
      setup(h) {
        withNginx(h);
        h.fs.get("/etc/nginx/sites-available/default").data += "server {\n\tlisten 443 ssl;\n\tserver_name shop.example;\n\tssl_certificate /etc/letsencrypt/live/shop.example/fullchain.pem;\n\tssl_certificate_key /etc/letsencrypt/live/shop.example/privkey.pem;\n\troot /var/www/html;\n}\n";
        h.fs.get("/etc/hosts").data += "127.0.0.1\tshop.example\n";
        h.file("/etc/letsencrypt/live/shop.example/fullchain.pem", "-----BEGIN CERTIFICATE-----\n(practice certificate; the playground reads only its dates)\n-----END CERTIFICATE-----\n", { cert: { cn: "shop.example", notAfter: h.clock - 2 * DAY } });
        h.file("/etc/letsencrypt/renewal/shop.example.conf", "# renew_before_expiry = 30 days\n[renewalparams]\nauthenticator = nginx\n");
        h.pkgs.installed.certbot = "2.9.0-1";
        h.bin("/usr/bin/certbot");
        h.file("/usr/lib/systemd/system/certbot.service", "[Unit]\nDescription=Certbot\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/certbot -q renew --no-random-sleep-on-renew\n");
        h.file("/usr/lib/systemd/system/certbot.timer", "[Unit]\nDescription=Run certbot twice daily\n\n[Timer]\nOnCalendar=*-*-* 00,12:00:00\nRandomizedDelaySec=43200\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n");
      },
      won: (h) => { const p = mainProc(h, "nginx.service"); return Boolean(p && p.cert && p.cert.notAfter > h.clock + 30 * DAY) && L.enabledState(h, "certbot.timer") === "enabled" && active(h, "certbot.timer"); },
      check(h) {
        const p = mainProc(h, "nginx.service");
        const served = p && p.cert && p.cert.notAfter > h.clock;
        return { label: "https://shop.example", ok: this.won(h), text: !served ? "certificate has expired" : L.enabledState(h, "certbot.timer") !== "enabled" ? "valid, but nothing will renew it" : "valid, renews automatically" };
      },
      hints: ["`curl -I https://shop.example`, then `sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/shop.example/fullchain.pem` and `sudo certbot certificates`.", "Renew it: `sudo certbot renew`. nginx keeps the old certificate in memory until it reloads. Why did it not renew by itself? `systemctl list-timers` and `systemctl is-enabled certbot.timer`.", "`sudo certbot renew`, `sudo systemctl reload nginx`, then `sudo systemctl enable --now certbot.timer`."],
      lesson: "Renewing writes a new file; the server must reload to use it. Keep the renewal timer enabled and monitor certificate expiry, not just the renewal job.",
      tries: ["curl -I https://shop.example", "sudo certbot certificates"]
    },
    {
      id: "nfshang", title: "High load, idle CPU: a hung NFS mount", level: "14",
      story: "Load average is 7 and climbing on a 2-CPU box, yet the CPUs are idle and there is no disk I/O. df hangs. The reports NFS server, nfs-02, was decommissioned this morning.",
      goal: "Free the processes stuck on the dead mount.",
      done: "The hung mount is detached and the load is back to normal.",
      setup(h) {
        h.world.records["nfs-02"] = "10.0.2.51";
        h.world.hosts["10.0.2.51"] = { name: "nfs-02", nfs: true, down: true, ping: false, ports: {} };
        h.fs.get("/etc/fstab").data += "nfs-02:/exports/reports\t/mnt/reports\tnfs4\tdefaults\t0 0\n";
        h.dir("/mnt/reports");
      },
      after(h) {
        h.hasNfs = true;
        h.mounts.push({ dev: "nfs-02:/exports/reports", mnt: "/mnt/reports", type: "nfs4", nfs: true, hung: true, size: 500 * GiB, base: 210 * GiB, inodes: 0, opts: "defaults", server: "nfs-02" });
        const cmds = ["du -sh /mnt/reports", "ls /mnt/reports/2026", "/usr/bin/python3 /opt/reports/export.py", "find /mnt/reports -name *.csv", "tar -czf /tmp/r.tgz /mnt/reports/q3", "stat /mnt/reports"];
        cmds.forEach((args, i) => L.spawn(h, { pid: 3801 + i, user: i === 2 ? "app" : "root", comm: args.split(" ")[0].replace(/^.*\//, ""), args, nfs: "/mnt/reports", start: ago(h, (50 - i * 6) * MIN) }));
        const t = (h.clock - h.boot) / 1000;
        h.dmesg("nfs: server nfs-02 not responding, still trying", t - 3000);
        h.dmesg("INFO: task du:3801 blocked for more than 122 seconds.", t - 2800);
      },
      won: (h) => !h.procs.some((p) => L.statOf(h, p) === "D"),
      check(h) { const d = h.procs.filter((p) => L.statOf(h, p) === "D").length; const c = L.cpuStats(h); return { label: "load average", ok: this.won(h), text: `${c.load[0].toFixed(2)}${d ? ` · ${d} processes stuck in D on /mnt/reports` : ""}` }; },
      hints: ["`top`: high load, near 0% us and wa. `ps -eo pid,stat,cmd | grep ' D'` shows who is waiting, and on what. `df -h` hangs (`df -hl` skips network file systems).", "A hard NFS mount waits forever for its server. Those processes are in D state, so even kill -9 does nothing. `sudo dmesg | tail` says the server is not responding.", "Detach the mount so their I/O fails: `sudo umount -f -l /mnt/reports`. Then remove or fix its /etc/fstab line (`_netdev,nofail`, or `x-systemd.automount`)."],
      lesson: "Load counts processes in D state. When the CPU is idle and wa is low, look for a hung network mount: umount -f -l releases them; nothing kills them while the server is gone.",
      tries: ["top", "ps -eo pid,stat,cmd"]
    },
    {
      id: "memleak", title: "A slow memory leak", level: "14",
      story: "The queue worker's memory climbs every hour until the box swaps or the OOM killer acts at night. Restarting it each morning has become a ritual.",
      goal: "Find the leaking process and make the system protect itself until the bug is fixed.",
      done: "The worker is capped by MemoryMax= and restarts itself when it leaks.",
      setup(h) {
        h.bin("/opt/worker/bin/worker");
        unit(h, "queue-worker.service", svcText({ desc: "Queue worker", service: "User=app\nExecStart=/opt/worker/bin/worker --queue orders\nRestart=always\nRestartSec=5" }));
        const cap = (x) => { const m = L.parseSize(String(x.cfg.one("Service", "MemoryMax") || "").replace(/([KMG])$/i, "$1")); return m ? Math.round(m / 1024) : null; };
        h.apps["/opt/worker/bin/worker"] = (hh, x) => ({ ident: "worker", proc: { rss: 310 * 1024, cpu: 4, leak: true, cap: cap(x),
          onProperty: (h2, props, p) => { for (const pr of props) if (/^MemoryMax=/.test(pr)) p.cap = cap({ cfg: { one: () => pr.split("=")[1] } }); } }, log: ["worker ready, queue=orders"] });
        // The worker leaks about 2 MB a second; a cgroup limit kills and restarts it.
        h.everyTick = (hh, sec) => {
          const p = mainProc(hh, "queue-worker.service");
          if (!p) return;
          p.rss += 2048 * sec;
          if (p.cap && p.rss >= p.cap) {
            hh.log("systemd", "queue-worker.service: A process of this unit has been killed by the OOM killer.", { pid: 1, unit: "queue-worker.service", prio: 4 });
            p.oomKilled = true;
            L.die(hh, p, "killed", "KILL");
          }
        };
      },
      after(h) { mainProc(h, "queue-worker.service").rss = 2.4 * 1024 * 1024; },
      won: (h) => { const p = mainProc(h, "queue-worker.service"); return Boolean(p && p.cap && p.cap <= 2 * 1024 * 1024 && p.rss < p.cap); },
      check(h) { const p = mainProc(h, "queue-worker.service"); return { label: "queue-worker", ok: this.won(h), text: !p ? "not running" : `${(p.rss / 1048576).toFixed(2)}G, +120 MB/min${p.cap ? `, capped at ${(p.cap / 1048576).toFixed(1)}G` : ", no limit"}` }; },
      hints: ["Who is big? `ps aux --sort=-rss | head -3`. Is it growing? `ps -o pid,rss,etime,cmd -p $(pgrep worker)`, `sleep 60`, run it again.", "A restart only resets the clock; it will leak again. Until the bug is fixed, let the kernel and systemd contain it: a memory limit, and Restart=always to bring it back.", "`sudo systemctl set-property queue-worker MemoryMax=1G`, then `sudo systemctl restart queue-worker`. Report the leak with the numbers you collected."],
      lesson: "Confirm a leak with RSS over time (ps, smem), then contain it with MemoryMax= and Restart= while the code is fixed. Dropping caches or adding swap only hides it.",
      tries: ["ps aux --sort=-rss | head -3", "free -h"]
    },
    {
      id: "swapfile", title: "No swap, and memory is tight", level: "14",
      story: "This 4 GB server has no swap. A nightly analytics job pushes memory to the edge and the OOM killer has started picking off services.",
      goal: "Add a 2 GB swap file that is active now and after every reboot.",
      done: "/swapfile is active, private and in /etc/fstab.",
      after(h) { L.spawn(h, { pid: 3901, user: "app", comm: "analytics", args: "/opt/analytics/bin/analytics --nightly", rss: 2.9 * 1024 * 1024, cpu: 35, start: ago(h, 40 * MIN) }); },
      won: (h) => { const n = h.fs.get("/swapfile"); return Boolean(n) && (n.m & 0o777) === 0o600 && (h.swaps || []).some((s) => s.path === "/swapfile") && L.fstab(h).some((e) => e.spec === "/swapfile" && e.type === "swap"); },
      check(h) {
        const n = h.fs.get("/swapfile");
        const on = (h.swaps || []).some((s) => s.path === "/swapfile");
        const inTab = L.fstab(h).some((e) => e.spec === "/swapfile" && e.type === "swap");
        return { label: "swap", ok: this.won(h), text: !n ? "none" : !on ? "file exists, not active" : (n.m & 0o777) !== 0o600 ? "active, but the file is readable by others" : !inTab ? "active until the next reboot" : "2.0G, persistent" };
      },
      hints: ["`free -h` and `swapon --show`: no swap at all.", "A swap file needs four steps: allocate, chmod 600 (it holds memory contents), mkswap, swapon. And a line in /etc/fstab, or it is gone after a reboot.", "`sudo fallocate -l 2G /swapfile`, `sudo chmod 600 /swapfile`, `sudo mkswap /swapfile`, `sudo swapon /swapfile`, `echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`."],
      lesson: "Swap gives the kernel room before the OOM killer acts. Make the file 600, mkswap it, swapon, and add it to fstab. Swap is a buffer, not a fix for a workload that does not fit.",
      tries: ["free -h", "cat /proc/swaps"]
    },

    // --- Rocky Linux / RHEL ---------------------------------------------------------------
    {
      id: "dnfepel", title: "dnf: Unable to find a match", level: "16", distro: "rhel", user: "rocky",
      story: "A runbook says to run htop on this Rocky Linux 9 server. dnf says the package does not exist.",
      goal: "Install htop the supported way.",
      done: "htop is installed from EPEL.",
      won: (h) => Boolean(h.pkgs.installed.htop),
      check(h) { return { label: "rpm -q htop", ok: this.won(h), text: h.pkgs.installed.htop ? `htop-${h.pkgs.installed.htop}` : "package htop is not installed" }; },
      hints: ["`sudo dnf install htop`, then `dnf repolist`.", "RHEL-family repositories (BaseOS, AppStream) are deliberately small. Many tools live in EPEL, Extra Packages for Enterprise Linux, which you enable by installing a package from Extras.", "`sudo dnf install -y epel-release`, then `sudo dnf install -y htop`."],
      lesson: "\"Unable to find a match\" on RHEL often means the package is in EPEL. dnf install epel-release enables it; dnf repolist shows what is enabled.",
      tries: ["sudo dnf install htop", "dnf repolist"]
    },
    {
      id: "selinux", title: "403 with correct permissions: SELinux", level: "16", distro: "rhel", user: "rocky",
      story: "The shop's files were built in your home folder and moved to /srv/shop. Permissions look perfect, yet nginx returns 403 Forbidden.",
      goal: "Serve /srv/shop with SELinux enforcing, in a way that survives a relabel.",
      done: "/srv/shop is labelled httpd_sys_content_t by policy.",
      setup(h) {
        rhelNginx(h, "server {\n    listen 80;\n    server_name _;\n    root /srv/shop;\n}\n");
        h.dir("/srv/shop", { ctx: "user_home_t" });
        h.file("/srv/shop/index.html", "<!doctype html>\n<title>Shop</title>\n<p>Rocky shop</p>\n", { ctx: "user_home_t" });
      },
      after(h) { L.http(h, "http://localhost/"); L.http(h, "http://localhost/"); },
      won: (h) => h.selinux === "enforcing" && httpCode(h, "http://localhost/") === 200 && h.fcontext.some(([re, t]) => t === "httpd_sys_content_t" && new RegExp(`^${re}$`).test("/srv/shop/index.html")),
      check(h) {
        const c = httpCode(h, "http://localhost/");
        return { label: "http://localhost/", ok: this.won(h), text: h.selinux !== "enforcing" ? `${c}, with SELinux turned off` : c !== 200 ? `${c} Forbidden` : !h.fcontext.length ? "200 until the next relabel" : "200" };
      },
      hints: ["`curl -I localhost`, `ls -l /srv/shop` (fine), then `ls -Z /srv/shop`.", "The files kept user_home_t from your home folder. `sudo ausearch -m avc -ts recent` shows nginx (httpd_t) denied. setenforce 0 and chcon only hide it; a relabel puts the wrong label back.", "Tell the policy what /srv/shop is, then apply it: `sudo semanage fcontext -a -t httpd_sys_content_t '/srv/shop(/.*)?'` and `sudo restorecon -Rv /srv/shop`."],
      lesson: "On SELinux systems, mv keeps a file's label and cp takes the new folder's. semanage fcontext plus restorecon fixes it for good; setenforce 0 just switches the protection off.",
      tries: ["curl -I localhost", "ls -Z /srv/shop"]
    },
    {
      id: "selinuxport", title: "bind() failed (13: Permission denied)", level: "16", distro: "rhel", user: "rocky",
      story: "The load balancer expects the app's nginx on port 8090. nginx refuses to start: permission denied, although it runs as root.",
      goal: "Run nginx on port 8090 with SELinux enforcing.",
      done: "nginx listens on 8090 and SELinux allows it.",
      setup(h) { rhelNginx(h, "server {\n    listen 8090;\n    server_name _;\n    root /usr/share/nginx/html;\n}\n"); },
      won: (h) => h.selinux === "enforcing" && active(h, "nginx.service") && (mainProc(h, "nginx.service") || { listen: [] }).listen.some((l) => l.port === 8090),
      check(h) { return { label: "nginx on :8090", ok: this.won(h), text: !active(h, "nginx.service") ? "not running" : h.selinux !== "enforcing" ? "running with SELinux off" : "running" }; },
      hints: ["`journalctl -u nginx -n 5`: bind() ... failed (13: Permission denied). Root, yet denied: look at SELinux, `sudo ausearch -m avc -ts recent`.", "nginx (httpd_t) may only bind ports labelled http_port_t. `sudo semanage port -l | grep http_port_t` lists them; 8090 is not there.", "`sudo semanage port -a -t http_port_t -p tcp 8090`, then `sudo systemctl start nginx`."],
      lesson: "SELinux labels ports too. Add a port to the service's type with semanage port -a instead of disabling SELinux.",
      tries: ["sudo systemctl status nginx", "sudo semanage port -l"]
    },
    {
      id: "firewalld", title: "firewalld blocks the new port", level: "16", distro: "rhel", user: "rocky",
      story: "The storefront answers curl localhost:8080 on app-01, but the load balancer times out. It worked in the Ubuntu staging environment.",
      goal: "Let traffic reach port 8080 now and after reloads and reboots, with firewalld running.",
      done: "8080/tcp is open in the runtime and permanent firewalld config.",
      setup(h) {
        h.bin("/opt/storefront/bin/storefront");
        unit(h, "storefront.service", svcText({ desc: "Storefront", service: "User=app\nExecStart=/opt/storefront/bin/storefront --listen 0.0.0.0:8080" }));
        h.apps["/opt/storefront/bin/storefront"] = service({ ident: "storefront", port: 8080, rss: 99000 });
      },
      won: (h) => active(h, "firewalld.service") && h.fwd.runtime.ports.includes(8080) && h.fwd.permanent.ports.includes(8080),
      check(h) {
        const up = active(h, "firewalld.service");
        return { label: "lb-01 → app-01:8080", ok: this.won(h), text: !up ? "open, but firewalld is stopped" : !h.fwd.runtime.ports.includes(8080) ? "timed out (dropped)" : !h.fwd.permanent.ports.includes(8080) ? "open until the next reload" : "allowed" };
      },
      hints: ["`sudo firewall-cmd --list-all`: services ssh, cockpit and dhcpv6-client; no 8080.", "firewalld has two configurations: runtime (now) and permanent (after --reload or a reboot). A rule in only one of them is half a fix.", "`sudo firewall-cmd --permanent --add-port=8080/tcp`, then `sudo firewall-cmd --reload`, and `sudo firewall-cmd --list-ports`."],
      lesson: "On RHEL the firewall is firewalld, not ufw. Add rules with --permanent and --reload (or both runtime and permanent); stopping firewalld is not a fix.",
      tries: ["curl -s localhost:8080", "sudo firewall-cmd --list-all"]
    },
    {
      id: "lvm", title: "Grow / on LVM and XFS", level: "16", distro: "rhel", user: "rocky",
      story: "/ is at 97% on app-01. The volume group still has 29 GB free from when the disk was provisioned.",
      goal: "Give / 20 GB more, online.",
      done: "The logical volume and its XFS file system are 40 GB.",
      setup(h) { h.mounts[0].base = 18.6 * GiB; },
      won: (h) => h.mounts[0].size >= 35 * GiB,
      check(h) { const lv = h.lvm.lvs[0]; return { label: "/ size", ok: this.won(h), text: `${L.human(h.mounts[0].size)} file system on a ${L.human(lv.size)} volume, ${Math.ceil(Math.min(1, rootUse(h)) * 100)}% used` }; },
      hints: ["`df -hT /` (xfs on /dev/mapper/rl-root), `sudo lvs` and `sudo vgs` (VFree).", "Two layers here: the logical volume, then the file system. XFS grows with xfs_growfs, not resize2fs.", "`sudo lvextend -r -L +20G /dev/rl/root` grows both in one step (-r resizes the file system). Without -r, follow with `sudo xfs_growfs /`."],
      lesson: "On LVM, lvextend grows the volume and -r grows the file system with it. XFS can grow online but never shrink; ext4 uses resize2fs.",
      tries: ["df -hT /", "sudo vgs"]
    }
  ];

  // Easiest first within each group.
  const GROUPS = [
    ["Files and permissions", ["noexec", "rootowned", "umask", "immutable", "crlf", "symlink"]],
    ["Processes", ["runaway", "graceful", "zombie", "stalepid"]],
    ["Services", ["notenabled", "masked", "badexec", "daemonreload", "envmissing", "port", "restartlimit", "bootorder", "cronpath", "cronuser"]],
    ["Disks", ["deletedopen", "runawaylog", "logrotate", "journalfull", "inodes", "growfs", "readonly", "nfsstale"]],
    ["Networking", ["dns", "hosts", "route", "firewall", "listenlocal", "hostname"]],
    ["Users and security", ["groups", "sshkey", "sshauth", "sudoers", "sudocmd", "secretperm", "exposedport", "bruteforce", "certexpired"]],
    ["Boot and kernel", ["fstab", "ipforward", "time", "rebootrequired", "dpkglock"]],
    ["Performance", ["iowait", "nfshang", "swap", "swapfile", "memleak", "oom", "ulimit"]],
    ["Rocky Linux and RHEL", ["dnfepel", "firewalld", "selinux", "selinuxport", "lvm"]]
  ];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  for (const [group, ids] of GROUPS) for (const id of ids) SCENARIOS.find((x) => x.id === id).group = group;

  L.SCENARIOS = SCENARIOS;
  L.GROUPS = GROUPS;
})(typeof window !== "undefined" ? window : globalThis);
