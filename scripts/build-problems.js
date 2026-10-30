// Builds site/problems.html (the troubleshooting reference as plain HTML,
// readable without JavaScript and by search engines) and site/sitemap.xml
// from site/data.js. tests/check_problems.js fails when they are out of date.
// Run with: node scripts/build-problems.js
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// `code` in the data becomes <code>.
const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

// The site's scripts attach themselves to window, as in the browser.
function load() {
  global.window = global.window || {};
  for (const f of ["data.js", "sim.js", "sim-ops.js", "world.js", "scenarios.js"]) require(path.join(root, "site", f));
  return { Q: window.QUEST, titles: Object.fromEntries(window.LQSim.SCENARIOS.map((s) => [s.id, s.title])) };
}

function problems() {
  const { Q, titles } = load();
  const groups = [...new Set(Q.doctor.map((d) => d.group))];
  const list = (items) => `<ul>${items.map((t) => `<li>${rich(t)}</li>`).join("")}</ul>`;
  const entry = (d) => `
      <section class="card fix problem" id="${d.id}">
        <p class="tag">${esc(d.group)}</p>
        <h3>${esc(d.title)}</h3>
        <pre class="fix-error"><code>${esc(d.error)}</code></pre>
        <h4>What you see</h4>
        <p>${rich(d.symptom)}</p>
        <h4>Why it happens</h4>
        ${list(d.cause)}
        <h4>Confirm it</h4>
        <pre><code>${esc(d.confirm.join("\n"))}</code></pre>
        <h4>Fix it</h4>
        ${list(d.fix)}
        <h4>Prevent it</h4>
        <p>${rich(d.prevent)}</p>
        <p class="note">Practise it: ${d.scenarios.map((id) => `<a href="index.html#play/${id}">${esc(titles[id])}</a>`).join(" · ")} · <a href="index.html#fix/${d.id}">Open in the interactive reference</a> · <a href="#${d.id}">Link to this answer</a></p>
      </section>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="Common Linux errors and how to fix them: ${esc(Q.doctor.slice(0, 6).map((d) => d.title).join(", "))}, and ${Q.doctor.length - 6} more, each with the cause, how to confirm it, the fix and how to prevent it.">
  <meta property="og:type" content="article">
  <meta property="og:title" content="Linux errors and how to fix them">
  <meta property="og:description" content="${Q.doctor.length} common Linux error messages, each with the cause, how to confirm it, the fix and how to prevent it.">
  <meta property="og:url" content="${Q.site}problems.html">
  <link rel="canonical" href="${Q.site}problems.html">
  <title>Linux errors and fixes</title>
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="logo.svg" type="image/svg+xml">
</head>
<body>
  <header class="top">
    <div class="wrap top-inner">
      <a class="brand" href="index.html"><img src="logo.svg" alt="" width="22" height="22"> Linux Quest</a>
      <nav aria-label="Sections"><a href="index.html#path">Path</a><a href="index.html#doctor">Troubleshoot</a><a href="index.html#cheats">Cheat sheet</a></nav>
    </div>
  </header>
  <main class="wrap problems">
    <h1 class="big-title">Linux errors and how to fix them</h1>
    <p class="lede">${Q.doctor.length} error messages and symptoms from real servers. Each answer gives the exact message, why it happens, how to confirm it, the fix, how to prevent it, and a scenario to practise it in the <a href="index.html#path">playground</a>. Generated from the site's data; the <a href="index.html#doctor">interactive reference</a> adds search by pasted error text.</p>
    <nav class="card toc" aria-label="Problems">
${groups.map((g) => `      <h2>${esc(g)}</h2>\n      <ul>${Q.doctor.filter((d) => d.group === g).map((d) => `<li><a href="#${d.id}">${esc(d.title)}</a></li>`).join("")}</ul>`).join("\n")}
    </nav>
${groups.map((g) => `    <h2 class="section-title">${esc(g)}</h2>${Q.doctor.filter((d) => d.group === g).map(entry).join("")}`).join("\n")}
  </main>
  <footer class="foot">
    <div class="wrap foot-base">
      <p>© 2024–2026 Sandeep Komal Pothu and contributors. Open source under the MIT License. No trackers, no cookies.</p>
      <p class="foot-tm">Linux® is the registered trademark of Linus Torvalds in the U.S. and other countries. This project is independent and not affiliated with the Linux Foundation.</p>
    </div>
  </footer>
</body>
</html>
`;
}

function sitemap() {
  const { Q } = load();
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${Q.site}</loc></url>
  <url><loc>${Q.site}problems.html</loc></url>
</urlset>
`;
}

module.exports = { problems, sitemap };
if (require.main === module) {
  fs.writeFileSync(path.join(root, "site/problems.html"), problems());
  fs.writeFileSync(path.join(root, "site/sitemap.xml"), sitemap());
  console.log("wrote site/problems.html and site/sitemap.xml");
}
