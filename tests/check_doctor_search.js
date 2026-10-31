// Runs the error corpus (tests/doctor_corpus.json) through the Troubleshoot search the
// page uses (site/doctor-search.js). Every on-topic error must bring its entry first; an
// error no entry covers, and every off-topic one, must open nothing and match nothing.
// Run with: node tests/check_doctor_search.js
"use strict";
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));
require(path.join(root, "site/doctor-search.js"));
const { search, distinctive, compile } = window.LQDoctorSearch;
const D = window.TRACK.doctor;
const corpus = require("./doctor_corpus.json");
const ids = new Set(D.map((d) => d.id));

// Every entry has signatures that compile, say more than common words, and find the
// entry's own error text.
for (const d of D) {
  assert.ok(Array.isArray(d.match) && d.match.length, `${d.id}: match signatures`);
  for (const sig of d.match) {
    assert.doesNotThrow(() => compile(sig), `${d.id}: signature "${sig}" compiles`);
    assert.ok(distinctive(sig), `${d.id}: signature "${sig}" is more than common words`);
  }
  // Two entries show sample output (`id`, vmstat columns), which on its own is no error.
  if (d.id === "usermod-lost-groups" || d.id === "swap-thrashing") continue;
  const own = search(d.error, D);
  // firewalld-blocks shows the same curl timeout as connection-timed-out; the paste needs
  // a sign of firewalld (firewall-cmd, No route to host) to pick it.
  const same = d.id === "firewalld-blocks" && own.answer && own.answer.id === "connection-timed-out";
  assert.ok(own.matches.includes(d) || same, `${d.id}: its own error text matches it`);
}

assert.ok(corpus.onTopic.length >= 40 && corpus.offTopic.length >= 15, "corpus size");
const covered = new Set(corpus.onTopic.map((c) => c.expect));
for (const d of D) assert.ok(covered.has(d.id), `${d.id}: no corpus case covers it`);

const failures = [];
let top1 = 0;
for (const c of corpus.onTopic) {
  assert.ok(c.expect === null || ids.has(c.expect), `corpus names unknown entry ${c.expect}`);
  const r = search(c.q, D);
  const got = r.answer ? r.answer.id : null;
  if (got === c.expect) top1++;
  else failures.push(`on-topic: expected ${c.expect}, got ${got}\n    ${c.q.split("\n").join("\n    ")}`);
}
let offShown = 0;
for (const c of corpus.offTopic) {
  const r = search(c.q, D);
  if (r.answer || r.matches.length || r.topic.length) {
    offShown++;
    failures.push(`off-topic (${c.why}): shown as ${r.answer ? "the answer " + r.answer.id : "a match"}`);
  }
}
assert.ok(!failures.length, failures.length + " corpus failures:\n  " + failures.join("\n  "));

// The owner's example: no answer, no match, at most three "Related" chips.
const mysql = search(corpus.offTopic[0].q, D);
assert.strictEqual(mysql.answer, null);
assert.ok(mysql.related.length <= 3);
// A short topic query still lists entries, without claiming an answer.
assert.ok(search("cron", D).topic.length >= 3 && !search("cron", D).answer, "a tool name lists its entries");
assert.strictEqual(search("   ", D).answer, null);

console.log(`doctor search ok: ${top1}/${corpus.onTopic.length} on-topic first, ${offShown}/${corpus.offTopic.length} off-topic shown, ${D.length} entries`);
