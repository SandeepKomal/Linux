// Throws thousands of random and malformed command lines at the simulator in
// every scenario. Any exception fails the run; every result must be printable.
// Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");
const assert = require("assert");

for (const f of ["sim.js", "sim-ops.js", "world.js", "scenarios.js"]) require(path.resolve(__dirname, "../site", f));
const { SCENARIOS, Host, shell, CMDS } = globalThis.LQSim;

let seed = 20261030;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (list) => list[rand(list.length)];

const WORDS = [...Object.keys(CMDS), "cd", "export", "umask", "ulimit", "kill", "sudo", "-i", "-u", "root", "postgres", "alice", "deploy", "-l", "-la", "-h", "-x", "-f", "-n", "5", "-9",
  "-TERM", "-s", "-a", "-aG", "-G", "-c", "-r", "-rf", "-p", "-o", "-y", "--now", "-tlnp", "+L1", "status", "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask",
  "daemon-reload", "reset-failed", "set-property", "MemoryMax=1G", "nginx", "ssh", "cron", "app", "ledger", "billing", "inventory", "postgresql", "/", "/etc", "/etc/fstab",
  "/etc/hosts", "/etc/resolv.conf", "/var/log", "/var/log/syslog", "/data", "/srv/www/current", "/proc/2231/fd/7", "/proc/1/limits", "/dev/nvme0n1", "/dev/nvme0n1p1", "/dev/nvme1n1p1",
  "~", "~/.ssh", "deploy.sh", "./deploy.sh", "*", "/var/lib/php/sessions/*", "'s/a/b/'", "'s/\\r$//'", "'/x/d'", "755", "u+x", "o-rwx", "640", "root:root", "shop:shop",
  "add", "default", "via", "10.0.1.1", "dev", "eth0", "allow", "8080/tcp", "from", "10.0.1.0/24", "example.com", "db.internal", "localhost:8080", "http://localhost/",
  "https://api.payments.example", "@10.0.0.2", "+short", "jq", "install", "update", "net.ipv4.ip_forward=1", "-w", "true", "300", "60", "-", "|", "||", "&&", ";", ">", ">>",
  "2>&1", "2>/dev/null", "<", "/tmp/x", "$HOME", "$(pwd)", "\"quoted text\"", "'single'", "(", ")", "\\", "$", "#", "=", "PATH=/usr/bin", "EDITOR=true", "-e", "-v", "--", "é"];

const rounds = Number(process.argv[2]) || 3000;
let n = 0;
for (let i = 0; i < rounds; i++) {
  const s = SCENARIOS[i % SCENARIOS.length];
  const h = new Host(s);
  for (let j = 0; j < 4; j++) {
    const line = rand(5) === 0 ? String.fromCharCode(...Array.from({ length: rand(40) }, () => 32 + rand(95)))
      : Array.from({ length: 1 + rand(9) }, () => pick(WORDS)).join(" ");
    try {
      const out = shell(h, line);
      assert.ok(Array.isArray(out));
      for (const l of out) assert.ok(Array.isArray(l) && typeof l[0] === "string", "each line is [text, class]");
      s.won(h);
      const c = s.check(h);
      assert.ok(typeof c.text === "string" && typeof c.ok === "boolean");
    } catch (err) {
      console.error(`scenario ${s.id}, command: ${JSON.stringify(line)}`);
      throw err;
    }
    n++;
  }
}
console.log(`fuzz ok: ${n} commands across ${SCENARIOS.length} scenarios, 0 exceptions`);
