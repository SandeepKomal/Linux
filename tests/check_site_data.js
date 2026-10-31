// Checks the site's data and page: levels are complete and point at files
// that exist, quiz questions are well formed, the references hang together,
// and the page keeps its security rules.
// Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));
require(path.join(root, "site/quiz-bank.js"));
const Q = window.TRACK;
const quiz = window.TRACK_QUIZ;
const ticks = (text, where) => assert.strictEqual((String(text).match(/`/g) || []).length % 2, 0, `${where}: unbalanced backticks in "${text}"`);

Q.levels.forEach((lv, i) => {
  assert.strictEqual(lv.id, String(i).padStart(2, "0"), `level ids run in order: ${lv.id}`);
  assert.ok(lv.title && lv.topic && lv.stage, `level ${lv.id}: title, topic, stage`);
  assert.ok(lv.learn.length >= 3 && lv.lab.length >= 4, `level ${lv.id}: what you learn and a lab`);
  assert.ok(fs.existsSync(path.join(root, lv.docs)), `level ${lv.id}: ${lv.docs} exists in the repository`);
  lv.learn.forEach((t) => ticks(t, `level ${lv.id}`));
});
for (const s of [...new Set(Q.levels.map((l) => l.stage))]) {
  const ids = Q.levels.map((l, i) => (l.stage === s ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(ids[ids.length - 1] - ids[0] + 1, ids.length, `stage "${s}" levels are contiguous`);
}

let total = 0;
assert.deepStrictEqual(Object.keys(quiz).sort(), Q.levels.map((l) => l.id), "a quiz for every level and no other");
for (const lv of Q.levels) {
  assert.ok(quiz[lv.id].length >= 6, `level ${lv.id} needs at least 6 quiz questions`);
  const seen = new Set();
  for (const item of quiz[lv.id]) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(typeof item.q === "string" && item.q.length > 10, `${where}: question text`);
    assert.ok(!seen.has(item.q), `${where}: duplicate question`);
    seen.add(item.q);
    assert.strictEqual(item.options.length, 4, `${where}: needs 4 options`);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: options must differ`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer index`);
    assert.ok(typeof item.why === "string" && item.why.length > 40, `${where}: explanation`);
    for (const text of [item.q, item.why, ...item.options]) ticks(text, where);
  }
}

// Troubleshooting entries read like reference answers, each with a stable id.
assert.ok(Q.doctor.length >= 50, "at least 50 troubleshooting entries");
assert.strictEqual(new Set(Q.doctor.map((d) => d.id)).size, Q.doctor.length, "troubleshooting ids are unique");
for (const d of Q.doctor) {
  assert.match(d.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `doctor id "${d.id}" is a clean link`);
  for (const k of ["title", "error", "symptom", "prevent", "group"]) assert.ok(d[k], `doctor ${d.id}: ${k}`);
  for (const k of ["cause", "confirm", "fix", "scenarios"]) assert.ok(d[k].length, `doctor ${d.id}: ${k}`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `doctor ${d.id} links to a missing level`);
  [d.symptom, d.prevent, ...d.cause, ...d.fix].forEach((t) => ticks(t, `doctor ${d.id}`));
}
for (const c of Q.architecture.components) {
  assert.ok(c.id && c.name && c.short && c.where && c.role && c.does.length && c.breaks && c.look.length && c.practise.length, `architecture ${c.id}: complete`);
  ticks(c.breaks, `architecture ${c.id}`);
}
for (const [key, g] of Object.entries(Q.guides)) assert.ok(g.what && g.steps.length && g.uses.length && g.tips.length, `guide ${key}: complete`);
for (const row of Q.cheats) {
  assert.ok(row.length === 3 || row.length === 4, `cheat "${row[0]}": [command, what, group, where?]`);
  assert.ok(row[0] && row[1] && row[2], `cheat "${row[0]}": filled in`);
}
assert.ok(Q.cheats.length >= 120, "at least 120 cheat sheet commands");
assert.strictEqual(new Set(Q.cheats.map((r) => r[0])).size, Q.cheats.length, "cheat sheet commands are unique");

// The page: the CSP, no inline styles or handlers, nothing from other sites.
const html = fs.readFileSync(path.join(root, "site/index.html"), "utf8");
assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">/);
assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<script>(?!<\/script>)|(src|href)="https?:\/\/(?!sandeepkomal\.github\.io\/(Linux|devops-nimbus)\/")/i, "no inline styles, handlers, scripts or third-party loads");
for (const src of html.match(/src="[^"]+"/g)) assert.ok(fs.existsSync(path.join(root, "site", src.slice(5, -1))), `${src} exists`);
assert.match(html, /<meta name="description" content="[^"]{80,}">/);
assert.match(html, /<meta property="og:title" content="[^"]+">/);
assert.match(html, /<meta property="og:description" content="[^"]+">/);
assert.doesNotMatch(html, /og:image/, "no external images for Open Graph");
assert.match(html, /© 2024–2026 Sandeep Komal Pothu and contributors\./);
assert.match(html, /Linux® is the registered trademark of Linus Torvalds in the U\.S\. and other countries\. This project is independent and not affiliated with the Linux Foundation\./);
assert.match(html, /id="forget">Clear it</);
for (const f of fs.readdirSync(path.join(root, "site")).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/, `${f}: no HTML injection or network calls`);
  assert.doesNotMatch(src, /localStorage\.(get|set)Item\("(?!lq:)/, `${f}: storage keys use the lq: prefix`);
}

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.doctor.length} troubleshooting entries, ${Q.cheats.length} cheat sheet commands, ${Q.architecture.components.length} components`);
