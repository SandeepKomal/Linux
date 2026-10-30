// Checks the unit file and crontab X-ray: known keys are explained, risky
// values warn, missing settings are listed, and the examples all parse.
// Run with: node tests/check_xray.js
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/xray-explain.js"));
const { explain, EXAMPLES } = globalThis.LQExplain;
const at = (r, start) => r.lines.find((l) => l.line.trim().startsWith(start));

const risky = explain("[Unit]\nDescription=Worker\n\n[Service]\nExecStart=worker > /tmp/log\nUser=root\nEnvironment=API_TOKEN=abc\nRestart=always\nLimitNOFILE=1024\nBogus=1\n");
assert.strictEqual(risky.kind, "unit");
assert.match(at(risky, "ExecStart").warns[0], /203\/EXEC/);
assert.match(at(risky, "User=").warns[0], /root/);
assert.match(at(risky, "Environment=").warns[0], /systemctl show/);
assert.match(at(risky, "Restart=").warns[0], /on-failure/);
assert.match(at(risky, "LimitNOFILE").warns[0], /Too many open files/);
assert.strictEqual(at(risky, "Bogus").level, "unknown");
assert.match(at(risky, "[Service]").note, /How the program is started/);
assert.ok(risky.review.some((n) => /\[Install\]/.test(n)), "review: no [Install]");
assert.ok(risky.review.some((n) => /RestartSec/.test(n)), "review: no RestartSec");

const good = explain(EXAMPLES[0].text);
assert.deepStrictEqual(good.review, [], "the good example needs nothing");
assert.ok(good.lines.every((l) => l.level !== "unknown"), "every key of the good example is known");

const dropin = explain("[Unit]\nAfter=postgresql.service\nWants=postgresql.service\n");
assert.strictEqual(dropin.kind, "drop-in");
assert.match(at(dropin, "After=").note, /does not pull them in/);

const cron = explain("*/5 * * * * backup.sh\n0 3 * * 1-5 /usr/local/bin/report.sh >> /var/log/report.log 2>&1\n15 2 1 * * tar -czf /b/etc-$(date +%F).tar.gz /etc >> /var/log/t.log 2>&1\n61 * * * * /bin/true\n");
assert.strictEqual(cron.kind, "crontab");
assert.match(cron.lines[0].note, /every 5 minutes/);
assert.ok(cron.lines[0].warns.some((w) => /PATH/.test(w)) && cron.lines[0].warns.some((w) => /mails it/.test(w)));
assert.match(cron.lines[1].note, /at 03:00, Monday to Friday/);
assert.deepStrictEqual(cron.lines[1].warns, []);
assert.ok(cron.lines[2].warns.some((w) => /unescaped %/.test(w)));
assert.match(cron.lines[3].warns[0], /minute field/);
assert.ok(cron.review.some((n) => /PATH=/.test(n)));

const sys = explain("# /etc/cron.d/db-backup\n*/10 * * * * pg_dump -Fc shop -f /x\n");
assert.strictEqual(sys.kind, "system crontab");
assert.ok(sys.lines[1].warns.some((w) => /user field/.test(w)));
assert.match(explain("# /etc/cron.d/x\n*/10 * * * * postgres pg_dump -Fc shop -f /x >> /l 2>&1\n").lines[1].note, /as postgres/);

assert.match(explain("").error, /Paste/);
assert.match(explain("hello world").error, /No \[Unit\]/);
assert.match(explain("x\n".repeat(400)).error, /up to 300 lines/);
for (const e of EXAMPLES) assert.ok(!explain(e.text).error, `example ${e.name} parses`);
console.log(`xray ok: ${EXAMPLES.length} examples, unit files, drop-ins and crontabs`);
