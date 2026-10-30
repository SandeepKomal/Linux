// Explains a pasted systemd unit file or crontab line by line, offline.
// Known keys are looked up in a dictionary; unknown ones say so instead of
// guessing. Risky values warn, and missing essentials are listed at the end.
// tests/check_xray.js drives it under Node.
"use strict";

(function (root) {
  const MAX_LINES = 300;

  // Unit file keys: [section|key regex, note, warn(value) returning a warning or null].
  const KEYS = [
    ["Unit|Description", "A human name, shown by systemctl status and in boot messages."],
    ["Unit|Documentation", "Where to read more: man pages or URLs. Shown by systemctl status."],
    ["Unit|After", "Start order only: start this unit after the listed ones have finished starting. It does not pull them in; pair it with Wants= or Requires=."],
    ["Unit|Before", "Start this unit before the listed ones."],
    ["Unit|Wants", "Also start the listed units when this one starts. If they fail, this one still runs. Add After= for ordering."],
    ["Unit|Requires", "Also start the listed units; if they fail to start or stop, this one is stopped too. Add After= for ordering."],
    ["Unit|BindsTo", "Like Requires=, and stop this unit whenever the other one goes away."],
    ["Unit|PartOf", "Restarting or stopping the listed unit does the same to this one."],
    ["Unit|Conflicts", "Starting this unit stops the listed ones, and the other way round."],
    ["Unit|RequiresMountsFor", "Waits for, and requires, the mounts that hold these paths. Good for services that write to a data disk."],
    ["Unit|ConditionPathExists", "Skip starting (without failing) unless the path exists."],
    ["Unit|StartLimitIntervalSec", "The window for the start limit. With StartLimitBurst=, how many starts are allowed before systemd gives up (start-limit-hit)."],
    ["Unit|StartLimitBurst", "How many starts are allowed within StartLimitIntervalSec= before systemd stops trying."],
    ["Unit|OnFailure", "Units to start when this one fails, for example a notification."],
    ["Service|Type", "How systemd knows the service has started: simple (as soon as it forks), exec (after exec succeeds), forking (the parent exits), notify (the service says so), oneshot (runs and exits).", (v) => (v === "forking" ? "forking needs PIDFile= or a program that really daemonizes; modern programs usually run in the foreground with simple or notify." : null)],
    ["Service|ExecStart", "The command that runs the service. It must be an absolute path; there is no shell, so pipes, && and > do not work unless you call /bin/sh -c.", (v) => (!/^[-@:+!]*\//.test(v) ? "Not an absolute path: systemd fails with status=203/EXEC." : /[|&><]/.test(v) && !/sh -c/.test(v) ? "Pipes, && and redirections need a shell: ExecStart=/bin/sh -c '...'" : null)],
    ["Service|ExecStartPre", "Runs before ExecStart=. If it fails, the service does not start (prefix with - to ignore failure)."],
    ["Service|ExecStartPost", "Runs after the service has started."],
    ["Service|ExecReload", "What `systemctl reload` runs, often `/bin/kill -HUP $MAINPID`."],
    ["Service|ExecStop", "What `systemctl stop` runs. Without it systemd sends SIGTERM, then SIGKILL after TimeoutStopSec."],
    ["Service|User", "Run as this user instead of root.", (v) => (v === "root" ? "Running as root: if the service is compromised, so is the machine. Use a dedicated user." : null)],
    ["Service|Group", "The primary group for the service's processes."],
    ["Service|DynamicUser", "systemd creates a throwaway user for each run. A strong default for stateless services."],
    ["Service|WorkingDirectory", "The folder the service starts in. If missing, it fails with 200/CHDIR (prefix with - to ignore)."],
    ["Service|Environment", "Variables for the service, e.g. Environment=PORT=8080. Visible to anyone who runs systemctl show; do not put secrets here.", (v) => (/(PASSWORD|SECRET|TOKEN|KEY)=/i.test(v) ? "A secret in Environment= can be read by any user with systemctl show. Use EnvironmentFile= with mode 640, or LoadCredential=." : null)],
    ["Service|EnvironmentFile", "Read variables from a file. A missing file fails the start unless the path starts with -."],
    ["Service|Restart", "When systemd restarts the service: no, on-failure, on-abnormal, always.", (v) => (v === "always" ? "always also restarts after a clean exit; on-failure is usually what you want." : null)],
    ["Service|RestartSec", "How long to wait before a restart. The default is 100 ms, which burns through the start limit in half a second."],
    ["Service|TimeoutStartSec", "How long a start may take before systemd gives up."],
    ["Service|TimeoutStopSec", "How long to wait after SIGTERM before SIGKILL."],
    ["Service|KillMode", "Which processes get the stop signal: control-group (all), mixed, process (main only)."],
    ["Service|KillSignal", "The signal sent to stop the service. SIGTERM by default."],
    ["Service|PIDFile", "Where a forking service writes its main PID. Keep it under /run, which is cleared at boot."],
    ["Service|LimitNOFILE", "The open-files limit for the service. limits.conf does not apply to services; this does.", (v) => (Number(v) && Number(v) < 4096 ? "A low open-files limit: busy servers fail with Too many open files." : null)],
    ["Service|MemoryMax", "A hard memory limit for the service's cgroup. Above it the kernel reclaims, then OOM-kills inside the service only."],
    ["Service|MemoryHigh", "A soft memory limit: above it the service is throttled and reclaimed first."],
    ["Service|CPUQuota", "A CPU cap, e.g. 50% (half of one CPU)."],
    ["Service|Nice", "CPU priority for the service, -20 (highest) to 19 (lowest)."],
    ["Service|IOSchedulingClass", "Disk priority class: realtime, best-effort or idle. idle suits backups."],
    ["Service|StandardOutput", "Where stdout goes: journal (default), null, file:/path, append:/path."],
    ["Service|StandardError", "Where stderr goes; journal by default."],
    ["Service|SyslogIdentifier", "The name used in the journal instead of the program name."],
    ["Service|NoNewPrivileges", "The service and its children can never gain privileges (no setuid). Cheap hardening."],
    ["Service|ProtectSystem", "Mount /usr and /etc read-only for the service (strict: the whole file system)."],
    ["Service|ProtectHome", "Hide /home, /root and /run/user from the service."],
    ["Service|PrivateTmp", "Give the service its own /tmp."],
    ["Service|ReadWritePaths", "With ProtectSystem=strict, the paths the service may still write."],
    ["Service|CapabilityBoundingSet", "The only capabilities the service may ever hold."],
    ["Service|AmbientCapabilities", "Capabilities granted to a non-root service, e.g. CAP_NET_BIND_SERVICE to listen on port 80."],
    ["Service|RemainAfterExit", "For oneshot units: stay active after the command exits."],
    ["Install|WantedBy", "Which target pulls this unit in when it is enabled. multi-user.target is the normal server boot."],
    ["Install|RequiredBy", "Like WantedBy=, with a hard dependency."],
    ["Install|Alias", "Other names for the unit, created as links on enable."],
    ["Timer|OnCalendar", "When the timer fires, e.g. daily, *-*-* 02:30:00, Mon..Fri 09:00. Check with systemd-analyze calendar."],
    ["Timer|OnBootSec", "Fire this long after boot."],
    ["Timer|OnUnitActiveSec", "Fire this long after the unit last started: a repeating interval."],
    ["Timer|Persistent", "Run a missed event at the next boot."],
    ["Timer|RandomizedDelaySec", "Spread the start over a random delay, so many machines do not fire at once."],
    ["Timer|Unit", "The unit the timer starts; by default the .service with the same name."]
  ];
  const SECTIONS = { Unit: "Generic settings: description, documentation, dependencies and ordering.", Service: "How the program is started, run, restarted and stopped.",
    Install: "What `systemctl enable` does. Without this section the unit cannot be enabled.", Timer: "When a timer starts its unit, a modern replacement for cron.",
    Socket: "A listening socket that starts the service on the first connection.", Mount: "A mount point managed by systemd.", Path: "Watch a path and start a unit when it changes." };

  function explainUnit(lines) {
    const out = [];
    const seen = {};
    let section = null;
    lines.forEach((line) => {
      const t = line.trim();
      if (!t) return out.push({ line, note: null, level: "blank" });
      if (t.startsWith("#") || t.startsWith(";")) return out.push({ line, note: "A comment. systemd ignores it.", level: "info" });
      const s = /^\[(\w+)\]$/.exec(t);
      if (s) {
        section = s[1];
        seen[section] = seen[section] || {};
        return out.push({ line, note: SECTIONS[section] ? `Starts the [${section}] section. ${SECTIONS[section]}` : `Starts a [${section}] section, which this explainer does not know.`, level: SECTIONS[section] ? "info" : "unknown" });
      }
      const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(t);
      if (!kv || !section) return out.push({ line, note: "Not a Key=value line inside a [Section]; systemd logs a warning and ignores it.", level: "unknown", warns: ["systemd cannot parse this line."] });
      const [, key, value] = kv;
      seen[section][key] = value;
      const entry = KEYS.find(([k]) => k === `${section}|${key}`);
      if (!entry) return out.push({ line, note: `${key}= in [${section}]: not in this explainer's dictionary. Check the spelling with \`systemd-analyze verify\`; systemd ignores unknown keys with a warning.`, level: "unknown" });
      const warn = entry[2] && entry[2](value);
      const empty = value === "" ? " An empty value resets the list, as drop-ins do before setting a new ExecStart=." : "";
      out.push({ line, note: entry[1] + empty, level: "known", warns: warn ? [warn] : [] });
    });
    const review = [];
    const S = seen.Service || {}, U = seen.Unit || {};
    // A drop-in only overrides a few keys of an existing unit.
    const dropin = !U.Description && !S.ExecStart && !seen.Install;
    if (dropin) return { kind: "drop-in", lines: out, review: ["A drop-in: these keys are merged over the main unit. Run systemctl daemon-reload after changing it."] };
    if (seen.Service) {
      if (!S.ExecStart) review.push("No ExecStart=: systemd refuses to start a service without it.");
      if (!S.User && !S.DynamicUser) review.push("No User=: the service runs as root. Give it its own user.");
      if (!S.Restart) review.push("No Restart=: if it crashes it stays down. Restart=on-failure with RestartSec=5 is a sensible default.");
      else if (!S.RestartSec) review.push("Restart= without RestartSec=: retries every 100 ms hit the start limit within a second.");
      if (!S.NoNewPrivileges && !S.ProtectSystem) review.push("No hardening: consider NoNewPrivileges=yes, ProtectSystem=strict, PrivateTmp=yes.");
      const talksToDb = /(:5432|:3306|:6379|postgres:\/\/|mysql:\/\/)/i.test(Object.values(S).join(" "));
      if (talksToDb && !/postgres|mysql|mariadb|redis/i.test(U.After || "")) review.push("It talks to a database but has no After= for it; at boot it may start first and fail.");
      if (U.After && /network-online\.target/.test(U.After) && !/network-online\.target/.test(U.Wants || U.Requires || "")) review.push("After=network-online.target without Wants=network-online.target does not wait for the network.");
    }
    if (!seen.Install && !seen.Timer) review.push("No [Install] section: systemctl enable will refuse, so it will not start at boot.");
    return { kind: "unit", lines: out, review };
  }

  // Crontab: schedules in words, plus the traps cron sets.
  const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const SPECIAL = { "@reboot": "once, when cron starts at boot", "@hourly": "every hour, at minute 0", "@daily": "every day at midnight", "@midnight": "every day at midnight", "@weekly": "every Sunday at midnight", "@monthly": "on the 1st of every month at midnight", "@yearly": "on 1 January at midnight", "@annually": "on 1 January at midnight" };
  const SYSTEM_USERS = ["root", "postgres", "www-data", "nobody", "backup", "ubuntu", "app", "deploy"];
  const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  // A field is *, numbers, ranges, steps or lists of them, inside its bounds.
  const validField = (f, i) => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(f) &&
    (f.match(/\d+/g) || []).every((n, k, all) => (/\//.test(f) && k === all.length - 1) || (Number(n) >= BOUNDS[i][0] && Number(n) <= BOUNDS[i][1]));
  function describe([mi, hr, dom, mon, dow]) {
    const pad = (n) => String(n).padStart(2, "0");
    let when;
    if (/^\d+$/.test(mi) && /^\d+$/.test(hr)) when = `at ${pad(hr)}:${pad(mi)}`;
    else if (mi.startsWith("*/") && hr === "*") when = `every ${mi.slice(2)} minutes`;
    else if (mi === "*" && hr === "*") when = "every minute";
    else if (/^\d+$/.test(mi) && hr === "*") when = `every hour at minute ${mi}`;
    else if (/^\d+$/.test(mi) && hr.startsWith("*/")) when = `every ${hr.slice(2)} hours at minute ${mi}`;
    else when = `at minute ${mi} of hour ${hr}`;
    const days = [];
    if (dom !== "*") days.push(`on day ${dom} of the month`);
    if (mon !== "*") days.push(`in ${/^\d+$/.test(mon) ? MONTHS[Number(mon)] : `month ${mon}`}`);
    if (dow !== "*") days.push(/^\d$/.test(dow) ? `on ${DOW[Number(dow)]}` : dow === "1-5" ? "Monday to Friday" : `on weekday ${dow}`);
    if (dom !== "*" && dow !== "*") days.push("(cron runs it when either the day of month or the weekday matches)");
    return `${when}${days.length ? ", " + days.join(" ") : ""}`;
  }
  function explainCron(lines, system) {
    const out = [];
    let path = null, jobs = 0;
    const review = [];
    lines.forEach((line) => {
      const t = line.trim();
      if (!t) return out.push({ line, note: null, level: "blank" });
      if (t.startsWith("#")) return out.push({ line, note: "A comment. cron ignores it.", level: "info" });
      const env = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(t);
      if (env) {
        const notes = { PATH: "Sets PATH for every job below. Without it cron uses only /usr/bin:/bin.", MAILTO: "Where cron mails each job's output. Empty (MAILTO=\"\") turns mail off.", SHELL: "The shell that runs each job; /bin/sh (dash) by default, which lacks bash features.", CRON_TZ: "The time zone for the schedules below." };
        if (env[1] === "PATH") path = env[2];
        return out.push({ line, note: notes[env[1]] || `Sets the variable ${env[1]} for every job below.`, level: notes[env[1]] ? "known" : "info" });
      }
      const f = t.split(/\s+/);
      const special = SPECIAL[f[0]];
      const sched = special ? null : f.slice(0, 5);
      if (!special && (f.length < 6 || !sched.every((x, i) => validField(x, i)))) {
        const bad = sched.findIndex((x, i) => !validField(x, i));
        return out.push({ line, note: "Not a valid cron line.", level: "unknown", warns: [bad >= 0 ? `The ${FIELD_NAMES[bad]} field \`${sched[bad]}\` is not valid: crontab says bad ${FIELD_NAMES[bad].split(" ")[0]} and refuses the file.` : "A job needs five time fields and a command."] });
      }
      const rest = f.slice(special ? 1 : 5);
      const user = system ? rest.shift() : null;
      const cmd = rest.join(" ");
      jobs++;
      const warns = [];
      if (system && !SYSTEM_USERS.includes(user)) warns.push(`System crontabs (/etc/crontab, /etc/cron.d) need a user field after the schedule. cron reads \`${user}\` as the user; if no such account exists it logs bad username and ignores the whole file.`);
      const first = cmd.split(/\s+/)[0] || "";
      if (/\.(sh|py|pl|rb)$/.test(first) && !first.startsWith("/") && !path) warns.push(`\`${first}\` is not an absolute path, and cron's PATH is /usr/bin:/bin. Use the full path or set PATH= above.`);
      if (!/>/.test(cmd)) warns.push("Output is not redirected: cron mails it, and without a mail system it is lost. Add >> /var/log/job.log 2>&1.");
      if (/%/.test(cmd) && !/\\%/.test(cmd)) warns.push("An unescaped % ends the command in crontab (the rest goes to stdin). Write \\% , e.g. date +\\%F.");
      if (/^\*\s/.test(t) && sched && sched[0] === "*") warns.push("Every minute: make sure that is intended, and that runs cannot overlap (flock -n).");
      out.push({ line, note: `Runs ${special || describe(sched)}${user ? `, as ${user}` : ""}: \`${cmd}\`.`, level: "known", warns });
    });
    if (jobs && !path) review.push("No PATH= line: jobs see only /usr/bin:/bin, unlike your shell.");
    if (jobs) review.push("Check runs with `grep CRON /var/log/syslog` and keep each job's output in a log.");
    return { kind: system ? "system crontab" : "crontab", lines: out, review };
  }

  function explain(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length > MAX_LINES) return { error: `That is ${lines.length} lines. Paste one unit file or crontab of up to ${MAX_LINES} lines.` };
    if (!lines.some((l) => l.trim())) return { error: "Paste a unit file or a crontab first." };
    if (lines.some((l) => /^\s*\[(Unit|Service|Install|Timer|Socket|Mount|Path)\]\s*$/.test(l))) return explainUnit(lines);
    const jobs = lines.filter((l) => l.trim() && !l.trim().startsWith("#") && !/^\s*[A-Za-z_]\w*\s*=/.test(l));
    const looksCron = (l) => { const f = l.trim().split(/\s+/); return f[0] in SPECIAL || (f.length > 5 && f.slice(0, 5).every((x) => /^[\d*/,-]+$/.test(x))); };
    if (!jobs.some(looksCron)) return { error: "No [Unit] or [Service] section and no cron lines found. Paste a systemd unit file or crontab lines." };
    // /etc/crontab and /etc/cron.d have a user field: say so in a comment, or name a common user there.
    const userField = (l) => { const f = l.trim().split(/\s+/); return SYSTEM_USERS.includes(f[f[0].startsWith("@") ? 1 : 5]); };
    const system = /\/etc\/cron(tab|\.d)/.test(text) || jobs.every(userField);
    return explainCron(lines, system);
  }

  const EXAMPLES = [
    { name: "orders-api.service", text: "[Unit]\nDescription=Orders API\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=app\nWorkingDirectory=/opt/orders\nEnvironmentFile=/etc/orders/orders.env\nExecStart=/opt/orders/bin/orders-api --port 8080\nRestart=on-failure\nRestartSec=5\nLimitNOFILE=65535\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths=/var/lib/orders\nPrivateTmp=yes\n\n[Install]\nWantedBy=multi-user.target\n" },
    { name: "Risky unit", text: "[Unit]\nDescription=Report worker\n\n[Service]\nExecStart=report-worker --all > /var/log/report.log\nEnvironment=DB_PASSWORD=changeme\nRestart=always\n" },
    { name: "inventory override.conf", text: "# /etc/systemd/system/inventory.service.d/override.conf\n[Unit]\nAfter=postgresql.service\nWants=postgresql.service\n\n[Service]\nLimitNOFILE=65535\nMemoryMax=1G\n" },
    { name: "backup.timer", text: "[Unit]\nDescription=Nightly backup\n\n[Timer]\nOnCalendar=*-*-* 02:30:00\nRandomizedDelaySec=15m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n" },
    { name: "User crontab", text: "# m h  dom mon dow   command\n*/5 * * * * backup-uploads.sh\n0 3 * * 1-5 /usr/local/bin/report.sh >> /var/log/report.log 2>&1\n15 2 1 * * tar -czf /backup/etc-$(date +%F).tar.gz /etc\n" },
    { name: "/etc/cron.d/db-backup", text: "PATH=/usr/local/bin:/usr/bin:/bin\nMAILTO=\"\"\n*/10 * * * * postgres pg_dump -Fc shop -f /var/backups/postgres/shop.dump >> /var/log/db-backup.log 2>&1\n@reboot root /usr/local/bin/warm-cache.sh >> /var/log/warm-cache.log 2>&1\n" }
  ];

  root.LQExplain = { explain, EXAMPLES, KEYS };
})(typeof window !== "undefined" ? window : globalThis);
