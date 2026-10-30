// Drives the playground's Linux simulator without a browser: every scenario
// starts broken, the tempting wrong moves keep it broken, and the intended
// fix solves it. Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

for (const f of ["sim.js", "sim-ops.js", "world.js", "scenarios.js"]) require(path.resolve(__dirname, "../site", f));
const L = globalThis.LQSim;
const { SCENARIOS, Host, shell, lex, human, parseMode } = L;

const fresh = (id) => new Host(SCENARIOS.find((s) => s.id === id));
const run = (h, cmd) => shell(h, cmd).map(([t]) => t).join("\n");
const won = (h) => h.scenario.won(h);
const broken = (h, why) => assert.ok(!won(h), why);
const fixed = (h, why) => assert.ok(won(h), why);

// The shell itself.
assert.deepStrictEqual(lex(`echo "a b" 'c' d|wc -l`).toks.map((t) => t.op || t.w.map((s) => s.text).join("")), ["echo", "a b", "c", "d", "|", "wc", "-l"]);
assert.ok(lex(`echo "open`).error);
assert.strictEqual(human(3.3 * 1024 ** 3), "3.3G");
assert.strictEqual(human(20 * 1024 ** 3), "20G");
assert.strictEqual(parseMode("u+x", 0o644, false, 0o022), 0o744);
assert.strictEqual(parseMode("go-w", 0o777, false, 0o022), 0o755);
assert.strictEqual(parseMode("640", 0o777, false, 0o022), 0o640);

for (const s of SCENARIOS) {
  const h = new Host(s);
  broken(h, `${s.id}: must start broken`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  assert.ok(s.title && s.story && s.goal && s.done && s.lesson && s.level && s.group, `${s.id}: title, story, goal, done, lesson, level, group`);
  const c = s.check(h);
  assert.ok(c.label && c.text && c.ok === false, `${s.id}: live check starts red`);
  for (const cmd of [...s.tries, "ps aux", "df -h", "systemctl status ssh"]) assert.ok(run(h, cmd).length > 0, `${s.id}: "${cmd}" prints something`);
}
assert.ok(SCENARIOS.length >= 40, "at least 40 scenarios");
assert.strictEqual(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, "scenario ids are unique");

// Shell basics on any scenario.
let h = fresh("noexec");
assert.strictEqual(run(h, "pwd"), "/home/ubuntu");
assert.match(run(h, "echo hi > /etc/x"), /-bash: \/etc\/x: Permission denied/);
assert.match(run(h, "sudo echo hi > /etc/x"), /Permission denied/, "the redirect is opened by your shell, not by sudo");
assert.strictEqual(run(h, "echo hi | sudo tee /etc/x"), "hi");
assert.match(run(h, "cat /etc/shadow"), /cat: \/etc\/shadow: Permission denied/);
assert.match(run(h, "ls /root"), /ls: cannot open directory '\/root': Permission denied/);
assert.match(run(h, "nosuchcmd"), /nosuchcmd: command not found/);
assert.match(run(h, "cd /nope"), /-bash: cd: \/nope: No such file or directory/);
assert.strictEqual(run(h, "cd /etc && pwd"), "/etc");
assert.strictEqual(run(h, "false || echo fallback"), "fallback");
assert.strictEqual(run(h, "grep -c ubuntu /etc/passwd"), "1");
assert.match(run(h, "ls -l /etc/hostname"), /^-rw-r--r-- 1 root root 7 \w{3} \d\d \d\d:\d\d \/etc\/hostname$/);
assert.strictEqual(run(h, "echo $HOME"), "/home/ubuntu");
assert.strictEqual(run(h, "export GREETING=hi; echo $GREETING"), "hi");
assert.strictEqual(run(h, "umask"), "0002");
assert.match(run(h, "which systemctl"), /\/usr\/bin\/systemctl/);
assert.match(run(h, "type cd"), /cd is a shell builtin/);
assert.match(run(h, "df -h /"), /^Filesystem\s+Size\s+Used\s+Avail\s+Use%\s+Mounted on\n\/dev\/nvme0n1p1\s+20G\s+\S+\s+\S+\s+\d+% \/$/);
assert.match(run(h, "free -h"), /^\s+total\s+used\s+free\s+shared\s+buff\/cache\s+available\nMem:/);
assert.match(run(h, "ip route"), /^default via 10\.0\.1\.1 dev eth0 proto dhcp src 10\.0\.1\.10 metric 100/);
assert.match(run(h, "sudo ss -tlnp"), /0\.0\.0\.0:22\s+0\.0\.0\.0:\*\s+users:\(\("sshd",pid=\d+,fd=\d+\)\)/);
assert.match(run(h, "ss -tlnp"), /0\.0\.0\.0:22\s+0\.0\.0\.0:\*$/m, "without root, ss shows no process names");
assert.match(run(h, "systemctl status ssh"), /● ssh\.service - OpenBSD Secure Shell server\n\s+Loaded: loaded \(\/usr\/lib\/systemd\/system\/ssh\.service; enabled; preset: enabled\)\n\s+Active: active \(running\)/);
assert.match(run(h, "systemctl restart ssh"), /Failed to restart ssh\.service: Access denied/);
assert.match(run(h, "ping -c 1 example.com"), /1 packets transmitted, 1 received, 0% packet loss/);
assert.match(run(h, "dig +short example.com"), /^93\.184\.215\.14$/);
assert.match(run(h, "curl -s http://localhost:9999"), /^$/);
assert.match(run(h, "curl http://localhost:9999"), /curl: \(7\) Failed to connect to localhost port 9999 after 0 ms: Couldn't connect to server/);
assert.match(run(h, "apt install jq"), /are you root\?/);
assert.match(run(h, "dnf install jq"), /Command 'dnf' not found, but can be installed with:/);
assert.match(run(h, "kill 1"), /-bash: kill: \(1\) - Operation not permitted/);
assert.match(run(h, "kill 99999"), /No such process/);
assert.match(run(h, "ps aux"), /^USER\s+PID %CPU %MEM\s+VSZ\s+RSS TTY\s+STAT START\s+TIME COMMAND\nroot\s+1 /);
assert.match(run(h, "uptime"), /up 12 days, +3:41, +1 user, +load average: \d+\.\d\d, \d+\.\d\d, \d+\.\d\d/);
assert.match(run(h, "tar -czf /tmp/etc.tar.gz /etc/hostname && tar -tzf /tmp/etc.tar.gz"), /\/etc\/hostname/);
assert.match(run(h, "ln -s /etc/hostname /tmp/hn && readlink /tmp/hn && cat /tmp/hn"), /\/etc\/hostname\nweb-01/);
assert.match(run(h, "rm -rf /"), /it is dangerous to operate recursively on '\/'/);
assert.match(run(h, "sudo -i"), /^$/);
assert.strictEqual(run(h, "whoami"), "root");
assert.match(run(h, "exit"), /logout/);
assert.strictEqual(run(h, "whoami"), "ubuntu");
assert.match(run(h, "ulimit -n"), /^1024$/);
assert.match(run(h, "useradd bob"), /Permission denied/);
run(h, "sudo useradd -m -s /bin/bash bob");
assert.match(run(h, "id bob"), /uid=1002\(bob\) gid=1002\(bob\) groups=1002\(bob\)/);
assert.match(run(h, "ls -ld /home/bob"), /^drwxr-x--- \d bob bob/);
assert.match(run(h, "crontab -l"), /no crontab for ubuntu/);
assert.match(run(h, "printf '* * * * * date' | crontab -"), /new crontab file is missing newline before EOF, can't install\./);
run(h, "echo '*/5 * * * * date' | crontab -");
assert.strictEqual(run(h, "crontab -l"), "*/5 * * * * date");
assert.match(run(h, "journalctl -u cron -n 1"), /cron/);
assert.match(run(h, "dmesg"), /dmesg: read kernel buffer failed: Operation not permitted/);
assert.match(run(h, "sudo dmesg"), /Linux version 6\.8\.0-1015-aws/);
assert.match(run(h, "lsblk"), /nvme0n1\s+259:0\s+0\s+20G\s+0 disk/);
assert.match(run(h, "sudo blkid"), /\/dev\/nvme0n1p1: LABEL="cloudimg-rootfs" UUID="/);
assert.match(run(h, "mount | grep ' / '"), /\/dev\/nvme0n1p1 on \/ type ext4 \(rw,relatime,discard,errors=remount-ro\)/);
assert.match(run(h, "find /etc -name hostname"), /^\/etc\/hostname$/);
assert.match(run(h, "du -sh /etc"), /^\S+\t\/etc$/);
assert.match(run(h, "env | grep ^PATH="), /^PATH=\/usr\/local\/sbin:/);
assert.match(run(h, "timedatectl"), /System clock synchronized: yes\n\s+NTP service: active/);
assert.match(run(h, "sudo reboot"), /Connection to web-01 closed by remote host\.[\s\S]*Welcome to Ubuntu 24\.04\.1 LTS/);
assert.match(run(h, "systemctl is-active ssh cron"), /^active\nactive$/);

// --- Files and permissions

h = fresh("noexec");
assert.match(run(h, "./deploy.sh"), /^-bash: \.\/deploy\.sh: Permission denied$/);
assert.match(run(h, "sudo ./deploy.sh"), /sudo: \.\/deploy\.sh: command not found/);
assert.match(run(h, "bash deploy.sh"), /Deploying release/);
broken(h, "bash runs it once, but it is still not executable");
run(h, "chmod 777 deploy.sh");
broken(h, "777 lets anyone rewrite the script");
run(h, "chmod 755 deploy.sh && ./deploy.sh");
fixed(h, "noexec: executable and deployed");

h = fresh("crlf");
assert.match(run(h, "./deploy.sh"), /^-bash: \.\/deploy\.sh: \/bin\/bash\^M: bad interpreter: No such file or directory$/);
assert.match(run(h, "file deploy.sh"), /with CRLF line terminators/);
run(h, "bash deploy.sh");
broken(h, "bash deploy.sh runs every line with a stray \\r, so RELEASE\\r is written instead");
assert.match(run(h, "dos2unix deploy.sh"), /Command 'dos2unix' not found/);
run(h, "sed -i 's/\\r$//' deploy.sh");
assert.doesNotMatch(run(h, "file deploy.sh"), /CRLF/);
run(h, "./deploy.sh");
fixed(h, "crlf: line endings fixed and run");

h = fresh("symlink");
assert.match(run(h, "curl -I localhost"), /HTTP\/1\.1 404 Not Found/);
assert.match(run(h, "ls -l /srv/www"), /current -> \/srv\/www\/releases\/20261029-2/);
assert.match(run(h, "find /srv/www -xtype l"), /^\/srv\/www\/current$/);
assert.match(run(h, "ln -s /srv/www/releases/20261030-1 /srv/www/current"), /ln: failed to create symbolic link '\/srv\/www\/current': File exists/);
run(h, "ln -sfn /srv/www/releases/20261029-2 /srv/www/current");
broken(h, "relinking the deleted release");
run(h, "ln -sfn /srv/www/releases/20261030-1 /srv/www/current");
assert.match(run(h, "curl localhost"), /Shop release 20261030-1/);
fixed(h, "symlink: points at the new release");

h = fresh("rootowned");
assert.match(run(h, "curl localhost:3000/upload"), /could not save upload/);
assert.match(run(h, "journalctl -u shop -n 3"), /EACCES: permission denied, open '\/srv\/shop\/uploads\/receipt-8813\.pdf'/);
assert.match(run(h, "ls -ld /srv/shop/uploads"), /^drwxr-xr-x 2 root root/);
assert.match(run(h, "chown shop /srv/shop/uploads"), /chown: changing ownership of '\/srv\/shop\/uploads': Operation not permitted/);
run(h, "sudo chmod 777 /srv/shop/uploads");
assert.match(run(h, "curl localhost:3000/upload"), /saved/);
broken(h, "777 makes uploads work and lets anyone write there");
run(h, "sudo chmod 755 /srv/shop/uploads && sudo chown -R shop:shop /srv/shop/uploads");
fixed(h, "rootowned: owned by shop");

h = fresh("umask");
assert.match(run(h, "curl -I localhost/report.html"), /403 Forbidden/);
assert.strictEqual(run(h, "umask"), "0077");
assert.match(run(h, "ls -l /var/www/html/report.html"), /^-rw------- 1 ubuntu ubuntu/);
run(h, "chmod 644 /var/www/html/report.html");
assert.match(run(h, "curl -I localhost/report.html"), /200 OK/);
broken(h, "the next deploy creates private files again");
run(h, "umask 022");
broken(h, "umask in this shell only lasts until logout");
run(h, "sed -i 's/^umask 077/umask 022/' ~/.profile");
fixed(h, "umask: file readable and profile fixed");
run(h, "touch /var/www/html/x.html");

h = fresh("immutable");
assert.match(run(h, "sudo sed -i 's/10r\\/s/50r\\/s/' /etc/nginx/conf.d/rate-limit.conf"), /sed: cannot rename \/etc\/nginx\/conf\.d\/sed\w+: Operation not permitted/);
assert.match(run(h, "sudo chmod 666 /etc/nginx/conf.d/rate-limit.conf"), /Operation not permitted/);
assert.match(run(h, "lsattr /etc/nginx/conf.d/rate-limit.conf"), /^----i---------e------- /);
run(h, "sudo chattr -i /etc/nginx/conf.d/rate-limit.conf");
run(h, "sudo sed -i 's/10r\\/s/50r\\/s/' /etc/nginx/conf.d/rate-limit.conf");
broken(h, "the file changed, but nginx has not reloaded");
assert.match(run(h, "sudo nginx -t"), /syntax is ok/);
run(h, "sudo systemctl reload nginx");
fixed(h, "immutable: reloaded with 50r/s");

// --- Processes

h = fresh("runaway");
assert.match(run(h, "top"), /\n\s+3317 ubuntu\s+20\s+0\s+\d+\s+\d+\s+\d+ R 198\.4/);
assert.match(run(h, "ps aux --sort=-%cpu | head -2"), /node \/opt\/reports\/export\.js/);
run(h, "renice -n 19 -p 3317");
broken(h, "renice still lets it use the CPU");
run(h, "kill 3317");
fixed(h, "runaway: stopped");

h = fresh("graceful");
assert.match(run(h, "kill -HUP 2481; ps -p 2481"), /2481/, "nohup ignores SIGHUP");
run(h, "kill -9 2481");
broken(h, "SIGKILL leaves a half-written file and the lock");
assert.match(run(h, "ls /var/lib/batch"), /batchd\.lock  export\.csv\.part/);
h = fresh("graceful");
run(h, "kill 2481");
assert.match(run(h, "ls /var/lib/batch"), /^export\.csv$/);
fixed(h, "graceful: SIGTERM let it finish");

h = fresh("zombie");
assert.match(run(h, "ps aux | grep defunct | head -1"), /\[convert\] <defunct>/);
assert.match(run(h, "ps -eo pid,ppid,stat,cmd | grep -c defunct"), /^23$/);
const z = run(h, "ps -eo pid,stat,cmd | grep defunct | head -1").trim().split(/\s+/)[0];
run(h, `sudo kill -9 ${z}`);
assert.match(run(h, "ps aux | grep -c defunct"), /^23$/, "a zombie ignores even SIGKILL");
broken(h, "kill -9 on zombies does nothing");
run(h, "sudo systemctl restart jobrunner");
fixed(h, "zombie: parent restarted, zombies reaped");

h = fresh("stalepid");
assert.match(run(h, "journalctl -u reportd -n 5"), /reportd: another instance is running \(pid 1187\), exiting/);
assert.match(run(h, "ps -fp 1187"), /postgres: 16\/main: checkpointer/);
run(h, "sudo kill 1187");
run(h, "sudo systemctl start reportd");
broken(h, "killing whatever owns the PID hurts PostgreSQL");
h = fresh("stalepid");
run(h, "sudo systemctl restart reportd");
broken(h, "restarting reads the same stale PID file");
run(h, "sudo rm /run/reportd.pid && sudo systemctl start reportd");
fixed(h, "stalepid: stale PID file removed");

// --- Services

h = fresh("notenabled");
assert.match(run(h, "systemctl status metrics-agent"), /Loaded: loaded \(\/etc\/systemd\/system\/metrics-agent\.service; disabled; preset: enabled\)/);
run(h, "sudo systemctl restart metrics-agent");
broken(h, "a restart does not enable it");
run(h, "sudo reboot");
assert.strictEqual(run(h, "systemctl is-active metrics-agent"), "inactive");
run(h, "sudo systemctl enable --now metrics-agent");
fixed(h, "notenabled: enabled and running");
run(h, "sudo reboot");
fixed(h, "notenabled: survives a reboot");

h = fresh("masked");
assert.match(run(h, "sudo systemctl start nginx"), /^Failed to start nginx\.service: Unit nginx\.service is masked\.$/);
assert.match(run(h, "sudo systemctl enable nginx"), /Failed to enable unit: Unit file \/etc\/systemd\/system\/nginx\.service is masked\./);
run(h, "sudo systemctl unmask nginx && sudo systemctl start nginx");
broken(h, "started but not enabled");
run(h, "sudo systemctl enable nginx");
fixed(h, "masked: unmasked, enabled, running");

h = fresh("badexec");
assert.match(run(h, "systemctl status orders-api"), /× orders-api\.service - Orders API[\s\S]*Active: failed \(Result: exit-code\)[\s\S]*status=203\/EXEC/);
assert.match(run(h, "journalctl -u orders-api -n 4"), /orders-api\.service: Failed to locate executable \/usr\/local\/bin\/orders-api: No such file or directory/);
run(h, "sudo sed -i 's#/usr/local/bin/orders-api#/opt/orders/bin/orders-api#' /etc/systemd/system/orders-api.service");
assert.match(run(h, "sudo systemctl restart orders-api"), /changed on disk\. Run 'systemctl daemon-reload'/);
broken(h, "without daemon-reload systemd runs the old ExecStart");
run(h, "sudo systemctl daemon-reload && sudo systemctl restart orders-api");
fixed(h, "badexec: new path loaded");
h = fresh("badexec");
run(h, "sudo cp /opt/orders/bin/orders-api /usr/local/bin/ && sudo systemctl restart orders-api");
assert.strictEqual(run(h, "systemctl is-active orders-api"), "active");
broken(h, "a stray copy runs, and the next package upgrade will not touch it");

h = fresh("daemonreload");
assert.match(run(h, "sudo systemctl restart api"), /Warning: The unit file, source configuration file or drop-ins of api\.service changed on disk\. Run 'systemctl daemon-reload' to reload units\./);
assert.match(run(h, "sudo ss -tlnp"), /0\.0\.0\.0:8080/);
broken(h, "restart alone keeps 8080");
run(h, "sudo systemctl daemon-reload && sudo systemctl restart api");
assert.match(run(h, "sudo ss -tlnp"), /0\.0\.0\.0:8081/);
fixed(h, "daemonreload: 8081");

h = fresh("port");
assert.match(run(h, "journalctl -u nginx -n 10"), /nginx: \[emerg\] bind\(\) to 0\.0\.0\.0:80 failed \(98: Address already in use\)/);
assert.match(run(h, "sudo systemctl start nginx"), /Job for nginx\.service failed because the control process exited with error code\./);
assert.match(run(h, "sudo lsof -i :80"), /apache2 /);
const apid = run(h, "pgrep -f 'apache2 -k start' | head -1");
run(h, `sudo kill ${apid}`);
run(h, "sudo systemctl start nginx");
broken(h, "killing apache works until the next boot");
run(h, "sudo systemctl disable --now apache2 && sudo systemctl restart nginx");
fixed(h, "port: nginx on 80, apache disabled");

h = fresh("restartlimit");
assert.match(run(h, "systemctl status billing"), /Active: failed \(Result: start-limit-hit\)/);
assert.match(run(h, "journalctl -u billing -n 20"), /Error: yaml: line 6: found character that cannot start any token[\s\S]*Start request repeated too quickly\./);
assert.match(run(h, "sudo systemctl start billing"), /^Job for billing\.service failed because start of the service was attempted too often\./);
run(h, "sudo systemctl reset-failed billing && sudo systemctl start billing");
broken(h, "reset-failed without fixing the config fails again");
run(h, "sudo sed -i 's/\\t/  /' /etc/billing/config.yml");
assert.match(run(h, "sudo systemctl start billing"), /attempted too often/);
run(h, "sudo systemctl reset-failed billing && sudo systemctl start billing");
fixed(h, "restartlimit: config fixed and reset");

h = fresh("bootorder");
assert.match(run(h, "journalctl -b -u inventory"), /Error: connect ECONNREFUSED 127\.0\.0\.1:5432/);
run(h, "sudo systemctl restart inventory");
assert.strictEqual(run(h, "systemctl is-active inventory"), "active");
broken(h, "a manual restart hides the problem until the next boot");
run(h, "sudo mkdir -p /etc/systemd/system/inventory.service.d");
run(h, "printf '[Service]\\nRestart=on-failure\\n' | sudo tee /etc/systemd/system/inventory.service.d/retry.conf");
run(h, "sudo systemctl daemon-reload && sudo reboot");
broken(h, "retrying every 100 ms hits the start limit before PostgreSQL is ready");
assert.match(run(h, "journalctl -b -u inventory"), /Start request repeated too quickly/);
run(h, "sudo rm /etc/systemd/system/inventory.service.d/retry.conf");
run(h, "printf '[Unit]\\nAfter=postgresql.service\\nWants=postgresql.service\\n' | sudo tee /etc/systemd/system/inventory.service.d/override.conf");
run(h, "sudo systemctl daemon-reload && sudo reboot");
fixed(h, "bootorder: ordered after PostgreSQL");

h = fresh("cronpath");
assert.match(run(h, "crontab -l"), /\*\/5 \* \* \* \* backup-uploads\.sh/);
assert.match(run(h, "env -i PATH=/usr/bin:/bin /bin/sh -c 'backup-uploads.sh'"), /backup-uploads\.sh: (command )?not found/);
assert.match(run(h, "backup-uploads.sh"), /upload: /, "it works from your own shell");
broken(h, "a manual run is not the cron job");
run(h, "crontab -l | sed 's# backup-uploads.sh# /usr/local/bin/backup-uploads.sh#' | crontab -");
run(h, "sleep 300");
assert.match(run(h, "tail -1 backup.log"), /\/usr\/local\/bin\/backup-uploads\.sh: line 4: aws: command not found/);
broken(h, "the script's own commands still miss /usr/local/bin");
run(h, "(echo 'PATH=/usr/local/bin:/usr/bin:/bin'; crontab -l) | crontab -");
assert.match(run(h, "crontab -l | head -1"), /PATH=/);
run(h, "sleep 300");
assert.match(run(h, "grep CRON /var/log/syslog | tail -1"), /CRON\[\d+\]: \(ubuntu\) CMD/);
fixed(h, "cronpath: PATH set, upload done");
h = fresh("cronpath");
run(h, `EDITOR="sed -i '1i PATH=/usr/local/bin:/usr/bin:/bin'" crontab -e`);
run(h, "sleep 300");
fixed(h, "cronpath: crontab -e with a scripted editor");

h = fresh("cronuser");
assert.match(run(h, "grep cron /var/log/syslog"), /Error: bad username; while reading \/etc\/cron\.d\/db-backup[\s\S]*\(\*system\*db-backup\) ERROR \(Syntax error, this crontab file will be ignored\)/);
run(h, "sudo sed -i 's/\\* \\* \\* \\* pg_dump/* * * * root pg_dump/' /etc/cron.d/db-backup");
run(h, "sleep 600");
assert.match(run(h, "sudo -u postgres ls /var/backups/postgres"), /^$/);
broken(h, "as root, pg_dump has no database role");
run(h, "sudo sed -i 's/ root pg_dump/ postgres pg_dump/' /etc/cron.d/db-backup");
run(h, "sleep 600");
assert.match(run(h, "sudo ls -l /var/backups/postgres"), /postgres postgres .* shop\.dump/);
fixed(h, "cronuser: runs as postgres");
h = fresh("cronuser");
assert.match(run(h, "pg_dump -Fc shop -f /tmp/x"), /role "ubuntu" does not exist/);
run(h, "sudo -u postgres pg_dump -Fc shop -f /var/backups/postgres/shop.dump");
broken(h, "a dump by hand is not the cron job");

// --- Disks

h = fresh("deletedopen");
assert.match(run(h, "df -h /"), /\s100% \/$/);
assert.match(run(h, "touch /tmp/x"), /touch: cannot touch '\/tmp\/x': No space left on device/);
assert.match(run(h, "sudo du -xsh / 2>/dev/null"), /^3\.\dG\t\/$/);
assert.match(run(h, "sudo lsof +L1"), /java\s+2231 app\s+7w\s+REG .* \/var\/log\/app\/app\.log \(deleted\)/);
run(h, "sudo rm /var/log/*.gz /var/log/app/app.log.1.gz");
broken(h, "deleting small logs frees almost nothing");
run(h, "sudo truncate -s 0 /proc/2231/fd/7");
fixed(h, "deletedopen: truncated through /proc");
h = fresh("deletedopen");
run(h, "sudo systemctl restart app");
fixed(h, "deletedopen: restart closes the deleted file");

h = fresh("runawaylog");
assert.match(run(h, "df -h /"), /9\d% \/$/);
run(h, "sudo rm /var/log/ledger/debug.log");
broken(h, "rm leaves the space held by the open file");
assert.match(run(h, "sudo lsof +L1"), /debug\.log \(deleted\)/);
run(h, "sudo systemctl restart ledger");
broken(h, "after a restart debug logging starts filling again");
h = fresh("runawaylog");
run(h, "sudo truncate -s 0 /var/log/ledger/debug.log");
broken(h, "emptying the log without turning debug off");
run(h, "sudo sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/ledger/ledger.env && sudo systemctl restart ledger");
fixed(h, "runawaylog: info level and space back");

h = fresh("inodes");
assert.match(run(h, "df -i /"), /100% \/$/);
assert.match(run(h, "touch /tmp/x"), /No space left on device/);
assert.match(run(h, "sudo ls /var/lib/php/sessions | wc -l"), /^1129000$/);
assert.match(run(h, "sudo rm /var/lib/php/sessions/*"), /rm: cannot remove '\/var\/lib\/php\/sessions\/\*': No such file or directory/, "your shell cannot read the folder, so the glob stays literal");
run(h, "sudo -i");
assert.match(run(h, "rm /var/lib/php/sessions/*"), /-bash: \/usr\/bin\/rm: Argument list too long/);
run(h, "exit");
run(h, "sudo rm -rf /var/lib/php/sessions");
broken(h, "deleting the folder breaks PHP sessions");
h = fresh("inodes");
run(h, "sudo find /var/lib/php/sessions -type f -mmin +1440 -delete");
assert.match(run(h, "df -i /"), /\s1\d% \/$/);
fixed(h, "inodes: old sessions deleted");

h = fresh("growfs");
assert.match(run(h, "lsblk"), /nvme0n1\s+259:0\s+0\s+50G\s+0 disk\s*\n├─nvme0n1p1\s+259:1\s+0 19\.9G/);
assert.match(run(h, "sudo resize2fs /dev/nvme0n1p1"), /The filesystem is already \d+ \(4k\) blocks long\.  Nothing to do!/);
broken(h, "resize2fs alone: the partition is still small");
assert.match(run(h, "sudo growpart /dev/nvme0n1 1"), /^CHANGED: partition=1 start=227328 old: size=\d+ end=\d+ new: size=\d+ end=\d+$/);
broken(h, "the partition grew, the filesystem not yet");
assert.match(run(h, "sudo resize2fs /dev/nvme0n1p1"), /on-line resizing required[\s\S]*is now \d+ \(4k\) blocks long\./);
assert.match(run(h, "df -h /"), /\s50G\s/);
fixed(h, "growfs: 50G");

h = fresh("readonly");
assert.match(run(h, "touch /data/x"), /touch: cannot touch '\/data\/x': Read-only file system/);
assert.match(run(h, "sudo dmesg | tail -2"), /Remounting filesystem read-only/);
run(h, "sudo mount -o remount,rw /data");
broken(h, "remounting rw keeps a damaged file system in use");
h = fresh("readonly");
assert.match(run(h, "sudo fsck -y /dev/nvme1n1p1"), /\/dev\/nvme1n1p1 is mounted\.\ne2fsck: Cannot continue, aborting\./);
assert.match(run(h, "sudo umount /data"), /umount: \/data: target is busy\./);
run(h, "sudo systemctl stop ingest && sudo umount /data");
assert.match(run(h, "sudo fsck -y /dev/nvme1n1p1"), /FILE SYSTEM WAS MODIFIED/);
run(h, "sudo mount /data && sudo systemctl start ingest");
fixed(h, "readonly: checked and remounted");

// --- Networking

h = fresh("dns");
assert.match(run(h, "curl https://api.payments.example"), /curl: \(6\) Could not resolve host: api\.payments\.example/);
assert.match(run(h, "ping -c 1 example.com"), /ping: example\.com: Temporary failure in name resolution/);
assert.match(run(h, "dig example.com"), /;; communications error to 10\.0\.0\.254#53: timed out[\s\S]*;; no servers could be reached/);
assert.match(run(h, "dig @10.0.0.2 +short example.com"), /93\.184\.215\.14/);
assert.match(run(h, "sudo apt update"), /Temporary failure resolving 'archive\.ubuntu\.com'/);
run(h, "echo '203.0.113.10 api.payments.example' | sudo tee -a /etc/hosts");
assert.match(run(h, "curl https://api.payments.example"), /status/);
broken(h, "/etc/hosts covers one name, not the resolver");
run(h, "sudo sed -i 's/10.0.0.254/10.0.0.2/' /etc/resolv.conf");
assert.match(run(h, "sudo apt update"), /All packages are up to date\./);
fixed(h, "dns: resolver fixed");

h = fresh("hosts");
assert.match(run(h, "curl localhost:8080/health"), /ETIMEDOUT 10\.0\.2\.15:5432/);
assert.match(run(h, "dig +short db.internal"), /^10\.0\.2\.40$/);
assert.match(run(h, "getent hosts db.internal"), /^10\.0\.2\.15\s+db\.internal$/);
run(h, "echo '10.0.2.40 db.internal' | sudo tee -a /etc/hosts");
broken(h, "the first matching line in /etc/hosts wins");
run(h, "sudo sed -i '/10.0.2.15/d' /etc/hosts");
assert.match(run(h, "curl localhost:8080/health"), /"db":"ok"/);
fixed(h, "hosts: stale pin removed");

h = fresh("route");
assert.match(run(h, "ping -c 2 8.8.8.8"), /^ping: connect: Network is unreachable$/);
assert.match(run(h, "sudo grep 'ip route' /var/log/auth.log"), /COMMAND=\/usr\/sbin\/ip route del default/);
assert.match(run(h, "sudo ip route add default via 10.0.0.1"), /Error: Nexthop has invalid gateway\./);
assert.match(run(h, "ip route add default via 10.0.1.1"), /RTNETLINK answers: Operation not permitted/);
run(h, "sudo ip route add default via 10.0.1.1 dev eth0");
assert.match(run(h, "ping -c 1 8.8.8.8"), /1 received/);
fixed(h, "route: default route back");

h = fresh("firewall");
assert.match(run(h, "curl -s localhost:8080"), /ok/);
assert.match(run(h, "sudo ufw status verbose"), /Status: active\nLogging: on \(low\)\nDefault: deny \(incoming\), allow \(outgoing\), deny \(routed\)[\s\S]*22\/tcp\s+ALLOW IN\s+Anywhere/);
run(h, "sudo ufw disable");
broken(h, "turning the firewall off is not the fix");
run(h, "sudo ufw enable");
assert.match(run(h, "sudo ufw allow from 10.0.1.0/24 to any port 8080"), /Rule added/);
fixed(h, "firewall: 8080 open to the subnet");

h = fresh("listenlocal");
assert.match(run(h, "curl 10.0.1.10:8080"), /curl: \(7\) Failed to connect to 10\.0\.1\.10 port 8080/);
assert.match(run(h, "sudo ss -tlnp"), /127\.0\.0\.1:8080/);
run(h, "sudo ufw allow 8080/tcp");
broken(h, "no firewall rule helps a loopback-only socket");
run(h, "sudo sed -i 's/BIND=127.0.0.1/BIND=0.0.0.0/' /etc/storefront/storefront.env");
broken(h, "the running process keeps its old address");
run(h, "sudo systemctl restart storefront");
fixed(h, "listenlocal: listens on 0.0.0.0");

h = fresh("hostname");
assert.match(run(h, "sudo true"), /^sudo: unable to resolve host web-02: Name or service not known$/);
run(h, "sudo hostnamectl set-hostname web-01");
broken(h, "renaming back is not the goal");
h = fresh("hostname");
run(h, "sudo sed -i 's/web-01/web-02/' /etc/hosts");
assert.strictEqual(run(h, "sudo true"), "");
fixed(h, "hostname: /etc/hosts updated");

// --- Users and security

h = fresh("groups");
assert.match(run(h, "sudo -u alice touch /srv/shared/x"), /touch: cannot touch '\/srv\/shared\/x': Permission denied/);
run(h, "sudo usermod -G developers alice");
assert.match(run(h, "id alice"), /groups=1002\(alice\),1003\(developers\)$/);
broken(h, "-G without -a removed docker");
run(h, "sudo usermod -aG docker alice");
fixed(h, "groups: both groups");
h = fresh("groups");
run(h, "sudo usermod -aG developers alice");
assert.strictEqual(run(h, "sudo -u alice touch /srv/shared/x && ls -l /srv/shared"), "total 0\n-rw-r--r-- 1 alice developers 0 Oct 30 09:14 x".replace(/total 0/, "total 0"));
fixed(h, "groups: -aG appends");

h = fresh("sshkey");
assert.match(run(h, "ssh deploy@db-01 hostname"), /WARNING: UNPROTECTED PRIVATE KEY FILE![\s\S]*Permissions 0644 for '\/home\/ubuntu\/\.ssh\/id_ed25519' are too open\.[\s\S]*deploy@db-01: Permission denied \(publickey\)\./);
run(h, "chmod 640 ~/.ssh/id_ed25519");
broken(h, "group-readable is still too open");
run(h, "chmod 600 ~/.ssh/id_ed25519");
assert.strictEqual(run(h, "ssh deploy@db-01 hostname"), "db-01");
fixed(h, "sshkey: 600");

h = fresh("sshauth");
assert.match(run(h, "sudo journalctl -u ssh -n 2"), /Authentication refused: bad ownership or modes for directory \/home\/deploy\/\.ssh/);
run(h, "sudo chmod 777 /home/deploy/.ssh/authorized_keys");
broken(h, "opening it further makes it worse");
run(h, "sudo chmod 700 /home/deploy/.ssh");
broken(h, "authorized_keys is still writable by others");
run(h, "sudo chmod 600 /home/deploy/.ssh/authorized_keys");
fixed(h, "sshauth: strict modes satisfied");

h = fresh("sudoers");
assert.match(run(h, "sudo -l -U deploy"), />>> \/etc\/sudoers\.d\/deploy: syntax error near line 2 <<<\nsudo: parse error in \/etc\/sudoers\.d\/deploy near line 2\nsudo: no valid sudoers sources found, quitting/);
assert.match(run(h, "visudo -c"), /parse error in \/etc\/sudoers\.d\/deploy near line 2/);
run(h, "chmod 777 /etc/sudoers.d/deploy");
broken(h, "loosening the mode does not fix the syntax");
run(h, "rm /etc/sudoers.d/deploy");
broken(h, "deleting the file loses deploy's rule");
h = fresh("sudoers");
run(h, "sed -i 's/NOPASSWD \\//NOPASSWD: \\//' /etc/sudoers.d/deploy");
assert.match(run(h, "visudo -c"), /\/etc\/sudoers\.d\/deploy: bad permissions, should be mode 0440/);
broken(h, "a 0644 sudoers file");
run(h, "chmod 440 /etc/sudoers.d/deploy");
assert.match(run(h, "visudo -c"), /\/etc\/sudoers\.d\/deploy: parsed OK/);
fixed(h, "sudoers: parses and 0440");

h = fresh("sudocmd");
assert.match(run(h, "sudo -u deploy sudo systemctl restart orders"), /^Sorry, user deploy is not allowed to execute '\/usr\/bin\/systemctl restart orders' as root on web-01\.$/);
run(h, "echo 'deploy ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/ci-deploy");
broken(h, "ALL gives CI root");
h = fresh("sudocmd");
run(h, "sudo sed -i 's/restart orders-api/restart orders/' /etc/sudoers.d/ci-deploy");
assert.strictEqual(run(h, "sudo -u deploy sudo systemctl restart orders"), "");
fixed(h, "sudocmd: exact command");

h = fresh("secretperm");
run(h, "sudo chmod 600 /etc/payments/payments.env");
broken(h, "600 root:root: payments cannot read it");
assert.match(run(h, "sudo systemctl restart payments; journalctl -u payments -n 6"), /EACCES: permission denied, open '\/etc\/payments\/payments\.env'/);
run(h, "sudo chown root:payments /etc/payments/payments.env && sudo chmod 640 /etc/payments/payments.env");
broken(h, "payments has not restarted since it failed");
run(h, "sudo systemctl restart payments");
fixed(h, "secretperm: 640 root:payments");

h = fresh("exposedport");
run(h, "sudo ufw deny 6379");
broken(h, "a firewall rule leaves Redis listening everywhere");
run(h, "sudo sed -i 's/^bind 0.0.0.0/bind 127.0.0.1 -::1/' /etc/redis/redis.conf");
broken(h, "Redis reads its config at start");
run(h, "sudo systemctl restart redis-server");
assert.match(run(h, "sudo ss -tlnp"), /127\.0\.0\.1:6379/);
fixed(h, "exposedport: localhost only");

// --- Boot and kernel

h = fresh("fstab");
assert.strictEqual(run(h, "whoami"), "root");
assert.match(run(h, "journalctl -xb"), /Dependency failed for local-fs\.target - Local File Systems\./);
assert.match(run(h, "sed -i 's/71b9f/71b9e/' /etc/fstab"), /sed: couldn't open temporary file \/etc\/sed\w+: Read-only file system/);
run(h, "mount -o remount,rw /");
run(h, "sed -i 's/^UUID=7c1e/#UUID=7c1e/' /etc/fstab");
run(h, "systemctl default");
broken(h, "commenting out the line boots without /data");
h = fresh("fstab");
run(h, "mount -o remount,rw /");
assert.match(run(h, "blkid"), /UUID="7c1e0b6a-90d1-4b8e-a3f5-2e64c2a71b9e"/);
run(h, "sed -i 's/71b9f/71b9e/' /etc/fstab");
assert.match(run(h, "mount -a"), /your fstab has been modified, but systemd still uses/);
run(h, "systemctl daemon-reload");
run(h, "reboot");
fixed(h, "fstab: UUID fixed, booted with /data");

h = fresh("ipforward");
assert.match(run(h, "sysctl net.ipv4.ip_forward"), /^net\.ipv4\.ip_forward = 0$/);
assert.match(run(h, "sysctl -w net.ipv4.ip_forward=1"), /sysctl: permission denied on key "net\.ipv4\.ip_forward"/);
run(h, "sudo sysctl -w net.ipv4.ip_forward=1");
broken(h, "runtime only");
run(h, "echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf");
fixed(h, "ipforward: on and persisted");
run(h, "sudo reboot");
assert.match(run(h, "cat /proc/sys/net/ipv4/ip_forward"), /^1$/);
fixed(h, "ipforward: still on after reboot");

h = fresh("time");
assert.match(run(h, "curl https://api.payments.example"), /curl: \(60\) SSL certificate problem: certificate is not yet valid/);
assert.match(run(h, "sudo apt update"), /is not valid yet \(invalid for another/);
run(h, "sudo date -s '2026-10-30 09:15:00'");
broken(h, "a clock set by hand drifts again");
h = fresh("time");
run(h, "sudo timedatectl set-ntp true");
assert.match(run(h, "timedatectl"), /System clock synchronized: yes/);
assert.match(run(h, "date"), /Oct 30/);
fixed(h, "time: NTP on");

h = fresh("rebootrequired");
assert.strictEqual(run(h, "uname -r"), "6.8.0-1015-aws");
run(h, "sudo systemctl restart nginx ssh");
broken(h, "restarting services does not load a kernel");
run(h, "sudo reboot");
assert.strictEqual(run(h, "uname -r"), "6.8.0-1016-aws");
fixed(h, "rebootrequired: new kernel");

h = fresh("dpkglock");
assert.match(run(h, "sudo apt install jq"), /E: Could not get lock \/var\/lib\/dpkg\/lock-frontend\. It is held by process 2810 \(unattended-upgr\)/);
run(h, "sudo rm /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock");
assert.match(run(h, "sudo apt install jq"), /removing the lock file is always wrong/);
assert.match(run(h, "sudo apt install jq"), /dpkg was interrupted, you must manually run 'sudo dpkg --configure -a'/);
broken(h, "removing the lock broke dpkg");
run(h, "sleep 90");
run(h, "sudo dpkg --configure -a && sudo apt install -y jq");
fixed(h, "dpkglock: repaired, then installed");
h = fresh("dpkglock");
run(h, "sudo kill -9 2810");
assert.match(run(h, "sudo apt install jq"), /dpkg was interrupted/);
broken(h, "killing unattended-upgrades interrupts dpkg");
h = fresh("dpkglock");
run(h, "sleep 90");
assert.match(run(h, "sudo apt install -y jq"), /Setting up jq/);
fixed(h, "dpkglock: waited");

// --- Performance

h = fresh("iowait");
assert.match(run(h, "top"), /\d+\.\d wa/);
assert.match(run(h, "ps -eo pid,stat,cmd | grep -c ' D '"), /^3$/);
assert.match(run(h, "iotop -o"), /Netlink error: Operation not permitted/);
assert.match(run(h, "sudo iotop -o"), /3410 be\/4 root\s+148\.22 M\/s/);
run(h, "sudo renice -n 19 -p 3410");
broken(h, "nice is CPU priority; the disk is still saturated");
run(h, "sudo kill 3410");
broken(h, "killing the backup loses it");
h = fresh("iowait");
run(h, "sudo ionice -c3 -p 3410");
fixed(h, "iowait: backup at idle I/O priority");

h = fresh("swap");
assert.match(run(h, "vmstat 1 2"), /si\s+so[\s\S]*\s1840\s+2210\s/);
assert.match(run(h, "sudo swapoff -a"), /swapoff: \/swap\.img: swapoff failed: Cannot allocate memory/);
run(h, "sudo sysctl -w vm.swappiness=10");
broken(h, "swappiness does not make it fit");
run(h, "sudo systemctl stop cache-warmer");
broken(h, "stopping it is not the goal");
run(h, "sudo systemctl start cache-warmer && sudo systemctl set-property cache-warmer MemoryMax=1G");
fixed(h, "swap: capped at 1G");

h = fresh("oom");
assert.match(run(h, "sudo dmesg | grep -i 'out of memory' | tail -1"), /Out of memory: Killed process \d+ \(java\) total-vm:\d+kB, anon-rss:\d+kB/);
const jpid = run(h, "pgrep java");
run(h, `echo -1000 | sudo tee /proc/${jpid}/oom_score_adj`);
for (let i = 0; i < 12; i++) run(h, "uptime");
assert.match(run(h, "sudo dmesg | tail -1"), /Killed process \d+ \(postgres\)/);
broken(h, "protecting java makes the kernel kill PostgreSQL");
h = fresh("oom");
run(h, "sudo systemctl restart reports");
broken(h, "a restart keeps -Xmx3g");
run(h, "sudo sed -i 's/-Xmx3g/-Xmx1g/' /etc/default/reports && sudo systemctl restart reports");
for (let i = 0; i < 15; i++) run(h, "free -h");
fixed(h, "oom: 1g heap fits");

h = fresh("ulimit");
const gpid = run(h, "pgrep gateway");
assert.match(run(h, `cat /proc/${gpid}/limits | grep 'open files'`), /Max open files\s+1024\s+524288\s+files/);
run(h, "ulimit -n 65535");
assert.strictEqual(run(h, "ulimit -n"), "65535");
broken(h, "ulimit changes only your shell");
run(h, "sudo systemctl restart gateway");
broken(h, "limits.conf does not apply to services");
run(h, "sudo mkdir -p /etc/systemd/system/gateway.service.d");
run(h, "printf '[Service]\\nLimitNOFILE=65535\\n' | sudo tee /etc/systemd/system/gateway.service.d/limits.conf");
run(h, "sudo systemctl daemon-reload && sudo systemctl restart gateway");
assert.match(run(h, "cat /proc/$(pgrep gateway)/limits | grep 'open files'"), /65535/);
fixed(h, "ulimit: LimitNOFILE in a drop-in");

// The cheat sheet: each command marked Try runs as written in its scenario, and each
// one left to Lab really cannot run here, so neither list goes stale.
global.window = {};
require(path.resolve(__dirname, "../site/data.js"));
const Q = window.QUEST;
const runsIn = (id, cmd) => {
  const hh = fresh(id);
  const res = shell(hh, cmd);
  return !res.some(([t, k]) => k === "na" || /command not found|not found, but can be installed|^-bash: |Unknown command verb|this playground|Usage:|invalid|unknown predicate|No such file or directory$/.test(t));
};
for (const [cmd, , , where] of Q.cheats) {
  if (where) assert.ok(runsIn(where === "any" ? "noexec" : where, cmd), `cheat sheet: "${cmd}" should run in ${where}`);
  else assert.ok(!runsIn("noexec", cmd), `cheat sheet: "${cmd}" now runs in the playground; give it a Try`);
}
const ids = new Set(SCENARIOS.map((s) => s.id));
for (const [, , , where] of Q.cheats) if (where && where !== "any") assert.ok(ids.has(where), `cheat sheet links to unknown scenario ${where}`);
for (const d of Q.doctor) for (const id of d.scenarios || []) assert.ok(ids.has(id), `troubleshoot "${d.id}" links to unknown scenario ${id}`);
for (const lv of Q.levels) for (const id of lv.practise || []) assert.ok(ids.has(id), `level ${lv.id} links to unknown scenario ${id}`);
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `${s.id}: level ${s.level} exists`);
// Every scenario is reachable from the troubleshooting reference.
const linked = new Set(Q.doctor.flatMap((d) => d.scenarios || []));
for (const s of SCENARIOS) assert.ok(linked.has(s.id), `${s.id}: no troubleshooting entry links to it`);

console.log(`playground ok: ${SCENARIOS.length} scenarios, ${Q.cheats.length} cheat sheet commands checked`);
