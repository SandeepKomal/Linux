# DevOps Nimbus Linux

**Linux, zero to on-call.** A command reference and a free browser site with simulated Ubuntu and Rocky Linux servers and real incidents to fix, for DevOps, cloud and SRE engineers learning Linux.

[![Learning site](https://img.shields.io/badge/learn-DevOps%20Nimbus-1d1d1f)](https://sandeepkomal.github.io/Linux/)
[![CI](https://github.com/SandeepKomal/Linux/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/Linux/actions/workflows/ci.yml)
[![Pages](https://github.com/SandeepKomal/Linux/actions/workflows/pages.yml/badge.svg)](https://github.com/SandeepKomal/Linux/actions/workflows/pages.yml)
[![Linux](https://img.shields.io/badge/Linux-commands-FCC624?logo=linux&logoColor=black)](https://www.kernel.org/doc/html/latest/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No trackers](https://img.shields.io/badge/site-no%20trackers%20%C2%B7%20no%20cookies-2ea44f)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)
![Last commit](https://img.shields.io/github/last-commit/SandeepKomal/Linux)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/Linux?style=social)](https://github.com/SandeepKomal/Linux/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/Linux?style=social)](https://github.com/SandeepKomal/Linux/network/members)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/SandeepKomal/Linux)

**[Open the learning site](https://sandeepkomal.github.io/Linux/)** · [Troubleshoot an error](https://sandeepkomal.github.io/Linux/#doctor) · [Every error on one page](https://sandeepkomal.github.io/Linux/problems.html) · [All DevOps Nimbus tracks](https://sandeepkomal.github.io/devops-nimbus/)

## Contents

- [Learn it in your browser](#learn-it-in-your-browser)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [Common DevOps checks](#common-devops-checks)
- [Learning roadmap](#learning-roadmap)
- [Who is this for?](#who-is-this-for)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [Privacy and cost](#privacy-and-cost)
- [License and trademarks](#license-and-trademarks)
- [Author and contributors](#author-and-contributors)

## Learn it in your browser

**[Open DevOps Nimbus Linux](https://sandeepkomal.github.io/Linux/)**, a free site that runs in your browser, with nothing to install and no account:

- **Playground**: simulated Ubuntu 24.04 and Rocky Linux 9 servers with 60 real incidents to fix (permission denied, disk full but du finds nothing, services that will not start, DNS, firewalls, SELinux, LVM, NFS, sudoers, emergency mode, OOM kills, cron jobs that never run). Real commands, real error messages, three hints each.
- **Path**: 17 levels from your first `ls` to incident response, each with a lab for a real machine.
- **Troubleshoot**: paste an error message and get the cause, how to confirm it, the fix and how to prevent it. Also as plain HTML: [problems.html](https://sandeepkomal.github.io/Linux/problems.html).
- **Unit file X-ray**: paste a systemd unit or a crontab to see every line explained and the risky ones flagged.
- **Quiz**, **cheat sheet** and an interactive **Linux internals** diagram.
- **Scoreboard**: a score, a skill radar, learning uptime and on-call shifts against the clock; **Download my progress** and **Load my progress** move it to another device.

The site lives in [`site/`](./site) (static files, no dependencies, no trackers). Run it locally with `cd site && python3 -m http.server`, then open http://localhost:8000.

## What's in this repository

A practical Linux reference for **DevOps engineers, cloud engineers, SREs, system administrators, developers, and Kubernetes users**.

### What this repository covers
- Linux file and directory management
- Users, groups, permissions, and ownership
- Processes and systemd
- Networking and port troubleshooting
- Package management
- Logs and text processing
- Disk and storage diagnostics
- Shell operators
- DevOps troubleshooting workflows

## Quick start
Start with the main reference:

➡️ [Linux Commands](./Linux_commands.md)

## Common DevOps checks
```bash
uptime
free -h
df -h
ss -lntp
ps aux --sort=-%cpu | head
ps aux --sort=-%mem | head
journalctl -u <service> --since '30 min ago'
```

## Learning roadmap
```text
Linux basics
  -> Files & permissions
  -> Users & processes
  -> systemd
  -> Networking
  -> Storage
  -> Shell scripting
  -> Logs & troubleshooting
  -> Docker
  -> Kubernetes
  -> CI/CD
```

## Who is this for?
- Linux beginners
- DevOps and cloud engineers
- SREs
- System administrators
- Developers working with Linux servers
- Engineers preparing for Linux/DevOps interviews

## Repository layout

| Path | What it holds |
| --- | --- |
| [`Linux_commands.md`](./Linux_commands.md) | The main command reference |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | A step-by-step server troubleshooting guide |
| [`site/`](./site) | The learning site (static HTML, CSS and JavaScript) |
| [`scripts/`](./scripts) | `build-problems.js`, which regenerates `site/problems.html` and `sitemap.xml` |
| [`tests/`](./tests) | Node.js checks for the site data, playground, X-ray and problems page |
| [`.github/workflows/`](./.github/workflows) | `ci.yml` (site tests) and `pages.yml` (deploys `site/`) |

## Troubleshooting

- Paste an error into the site's [Troubleshoot](https://sandeepkomal.github.io/Linux/#doctor) tab, or browse [every error on one page](https://sandeepkomal.github.io/Linux/problems.html).
- For a step-by-step diagnosis of a real server, see [docs/troubleshooting.md](./docs/troubleshooting.md).

## Contributing
Corrections, useful commands, troubleshooting examples, shell scripts, and practical guides are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md), including how to add a playground scenario.

Tests (Node.js, no packages):

```bash
node tests/check_site_data.js     # levels, quiz, references, page security rules
node tests/check_playground.js    # every scenario starts broken, wrong moves fail, the fix works
node tests/fuzz_playground.js     # thousands of random commands, no exceptions
node tests/check_xray.js          # unit file and crontab explainer
node scripts/build-problems.js    # regenerate site/problems.html and sitemap.xml after editing site/data.js
node tests/check_problems.js      # fails if they are out of date
```

## Security
Never commit passwords, private keys, API tokens, kubeconfigs, or production configuration.

To report a vulnerability, follow [SECURITY.md](./SECURITY.md): contact the repository owner privately through GitHub rather than opening a public issue. CI runs the site tests, including the page security rules in `tests/check_site_data.js`; no separate security scanners run in CI.

## Privacy and cost

The site runs entirely in your browser: no accounts, cookies, trackers or database. Your progress stays in your own browser's storage. It is hosted free on GitHub Pages, and nothing in this repository costs money to use. See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## License and trademarks
MIT. See [LICENSE](./LICENSE). Linux® is the registered trademark of Linus Torvalds in the U.S. and other countries. This project is independent and not affiliated with the Linux Foundation.

## Author and contributors

**Sandeep Komal** · [github.com/SandeepKomal](https://github.com/SandeepKomal)

Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation, and DevSecOps.

Built and maintained with [DevopsNimbus](https://github.com/DevopsNimbus). See everyone who has contributed in the [contributors graph](https://github.com/SandeepKomal/Linux/graphs/contributors).

If this helped you, a ⭐ on the repository helps others find it.
