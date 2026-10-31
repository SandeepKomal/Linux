// Troubleshoot search: finds the entry for a pasted error, or says there is none.
// An entry is "the answer" only when the paste contains one of its signatures (the
// entry's `match` list): its distinctive error line, an error code, or a phrase that only
// that error prints. Shared common words (error, failed, denied, access, user,
// connection) never make a match on their own. Used by app.js and tests/check_doctor_search.js.
"use strict";

(function (root) {
  // Words that appear in errors from every tool. They never count as evidence.
  const GENERIC = new Set(("error errors err failed failure fail fatal critical warning warn info debug notice crit emerg alert " +
    "denied access permission permissions user users connection connect connecting connected refused timeout timed time out " +
    "not found such file files directory no cannot can't could unable invalid the and for with from this that was were has have is are " +
    "you your into onto then than when while there their which what after before again still only will would should " +
    "main root admin app application service server host localhost database operation process program command line system " +
    "message exception traceback status code exit exited unknown missing bad wrong problem issue help why how does doesn't " +
    "run running start started starting stop new old get set use using via http https www com org net example internal").split(/\s+/));

  // Log prefixes and noise at the start of a line: timestamps, levels, host and process names.
  const PREFIXES = [
    /^\s*\[?\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/,
    /^\s*[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \S+ [\w.@/-]+(?:\[\d+\])?:\s*/,
    /^\s*\[\s*\d+\.\d+\]\s*/,
    /^\s*(?:INFO|DEBUG|WARN|WARNING|ERROR|CRITICAL|FATAL|NOTICE)(?::[\w.]+)*:\s*/i,
    /^\s*\S+@[\w.-]+:[^$#\n]*[$#]\s*/
  ];
  function clean(text) {
    return String(text).replace(/\r/g, "").split("\n").map((line) => {
      for (let i = 0; i < 4; i++) {
        const before = line;
        for (const re of PREFIXES) line = line.replace(re, "");
        if (line === before) break;
      }
      return line;
    }).join("\n");
  }

  // Words that can carry meaning: no numbers, paths, quoted names, ids or host-like names.
  function words(text) {
    return String(text).toLowerCase()
      .replace(/(['"`])[^'"`\n]{0,120}\1/g, " ")
      .replace(/(?:^|\s)[~.]?\/\S*/g, " ")
      .split(/[^a-z0-9_-]+/)
      .map((w) => w.replace(/^[-_]+|[-_]+$/g, ""))
      .filter((w) => w.length > 2 && !/\d/.test(w) && !GENERIC.has(w));
  }

  // A signature is literal text, case-insensitive, where * stands for any text on the same
  // line, # for a number, and any run of spaces matches any whitespace. "a && b" needs both parts.
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  function compilePart(part) {
    const body = part.trim().split("*").map((bit) => esc(bit.trim()).replace(/\s+/g, "\\s+").replace(/#/g, "\\d+(?:[.,]\\d+)?")).join("[^\\n]*?");
    const start = /^[a-z0-9]/i.test(part.trim()) ? "(?<![\\w])" : "";
    const end = /[a-z0-9]$/i.test(part.trim()) ? "(?![\\w])" : "";
    return new RegExp(start + body + end, "i");
  }
  function compile(sig) {
    const parts = sig.split(" && ");
    return { sig, res: parts.map(compilePart), weight: parts.reduce((n, p) => n + p.replace(/\*/g, "").replace(/\s+/g, " ").trim().length, 0) };
  }

  const cache = new WeakMap();
  function prepare(entries) {
    if (cache.has(entries)) return cache.get(entries);
    const df = new Map();
    const prepared = entries.map((d) => {
      const vocab = new Set(words(d.title + " " + d.error));
      for (const w of vocab) df.set(w, (df.get(w) || 0) + 1);
      return { d, sigs: (d.match || []).map(compile), vocab };
    });
    const out = { prepared, df };
    cache.set(entries, out);
    return out;
  }

  // search(text, entries) -> { answer, matches, related, topic }
  //   matches: entries whose signature is in the text, best first; answer is the first.
  //   related: when there is no match, at most three entries that share distinctive words
  //            ("Related, may not apply"). topic: for a short query such as "cron" or
  //            "disk", the entries that mention every word (a listing, not an answer).
  function search(text, entries) {
    const raw = String(text || "");
    const none = { answer: null, matches: [], related: [], topic: [] };
    if (!raw.trim()) return none;
    const { prepared, df } = prepare(entries);
    const body = clean(raw);

    const matches = [];
    for (const p of prepared) {
      let best = 0;
      for (const s of p.sigs) if (s.res.every((re) => re.test(body) || re.test(raw))) best = Math.max(best, s.weight);
      if (best) matches.push({ d: p.d, score: best });
    }
    matches.sort((a, b) => b.score - a.score);
    if (matches.length) return { ...none, answer: matches[0].d, matches: matches.map((m) => m.d) };

    // A short query names a topic or a tool: list the entries that mention all of it.
    const typed = raw.toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 1);
    if (!raw.includes("\n") && typed.length && typed.length <= 3 && raw.length <= 40) {
      const text = (d) => [d.title, d.error, d.symptom, ...d.cause, ...d.confirm, ...d.fix, d.prevent, d.group].join(" ").toLowerCase();
      const topic = entries.filter((d) => typed.every((w) => text(d).includes(w)));
      if (topic.length) return { ...none, topic };
    }

    // Otherwise: no answer. Offer entries only when they share distinctive words: words of
    // their title or error that few other entries use.
    const mine = new Set(words(body));
    const related = prepared.map((p) => {
      const shared = [...p.vocab].filter((w) => mine.has(w) && df.get(w) <= 4);
      return { d: p.d, n: shared.length };
    }).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.d);
    return { ...none, related };
  }

  // For the data check: a signature must say more than one or two common words. It needs a
  // distinctive word, a code or a path, or an exact phrase of three words or more.
  function distinctive(sig) {
    return sig.split(" && ").some((part) => words(part.replace(/\*/g, " ")).length > 0 || /\d{2,}|[A-Z_]{4,}|\/\w/.test(part) ||
      part.split("*").some((bit) => (bit.match(/[a-z']+/gi) || []).length >= 3));
  }

  root.LQDoctorSearch = { search, clean, words, compile, distinctive, GENERIC };
})(typeof window !== "undefined" ? window : globalThis);
