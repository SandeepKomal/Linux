# Contributing

Useful additions are welcome: command corrections, troubleshooting workflows, shell examples, networking notes, and DevOps-focused Linux guides.

Before opening a pull request:
1. Test commands where practical.
2. Explain what changed.
3. Avoid destructive commands without warnings.
4. Never commit secrets or production configuration.

## The DevOps Nimbus Linux site

- Scenarios live in `site/scenarios.js`. Each one needs a story, a goal, three hints (each more direct), a lesson, `won(host)` and a live `check(host)`. Add it to a group in `GROUPS`, link it from a troubleshooting entry in `site/data.js`, and add tests to `tests/check_playground.js`: it starts broken, the tempting wrong moves do not fix it, and the intended fix does.
- Error messages must be the ones the real tool prints on Ubuntu 24.04.
- Cheat sheet rows marked Try must run cleanly in their scenario; the test checks this.
- After editing `site/data.js`, run `node scripts/build-problems.js` to regenerate `site/problems.html`.
- Run every test in the README before opening a pull request.

