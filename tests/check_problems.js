// problems.html and sitemap.xml are generated from site/data.js, and
// scenario-index.js from site/scenarios.js. This fails
// when someone edits the data without running: node scripts/build-problems.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { problems, sitemap, scenarioIndex } = require("../scripts/build-problems.js");

const root = path.resolve(__dirname, "..");
const html = problems();
assert.strictEqual(fs.readFileSync(path.join(root, "site/problems.html"), "utf8"), html, "site/problems.html is out of date: run node scripts/build-problems.js");
assert.strictEqual(fs.readFileSync(path.join(root, "site/sitemap.xml"), "utf8"), sitemap(), "site/sitemap.xml is out of date: run node scripts/build-problems.js");
assert.strictEqual(fs.readFileSync(path.join(root, "site/scenario-index.js"), "utf8"), scenarioIndex(), "site/scenario-index.js is out of date: run node scripts/build-problems.js");
assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=/i, "problems.html works without JavaScript and keeps the CSP");
for (const d of window.TRACK.doctor) {
  assert.ok(html.includes(`id="${d.id}"`), `problems.html has a section for ${d.id}`);
  assert.ok(html.includes(d.error.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")), `problems.html shows the error text of ${d.id}`);
}
assert.match(fs.readFileSync(path.join(root, "site/robots.txt"), "utf8"), /Sitemap: https:\/\/sandeepkomal\.github\.io\/Linux\/sitemap\.xml/);
console.log(`problems ok: ${window.TRACK.doctor.length} entries in problems.html, sitemap and scenario index in sync`);
