# Linux — Practical Linux Commands for DevOps & Cloud

A practical Linux reference for **DevOps engineers, cloud engineers, SREs, system administrators, developers, and Kubernetes users**.

## What this repository covers
- Linux file and directory management
- Users, groups, permissions, and ownership
- Processes and systemd
- Networking and port troubleshooting
- Package management
- Logs and text processing
- Disk and storage diagnostics
- Shell operators
- DevOps troubleshooting workflows

## DevOps Nimbus Linux: learn by fixing a server

**[Open DevOps Nimbus Linux](https://sandeepkomal.github.io/Linux/)**, a free site that runs in your browser, with nothing to install and no account:

- **Playground**: simulated Ubuntu 24.04 and Rocky Linux 9 servers with 60 real incidents to fix (permission denied, disk full but du finds nothing, services that will not start, DNS, firewalls, SELinux, LVM, NFS, sudoers, emergency mode, OOM kills, cron jobs that never run). Real commands, real error messages, three hints each.
- **Path**: 17 levels from your first `ls` to incident response, each with a lab for a real machine.
- **Troubleshoot**: paste an error message and get the cause, how to confirm it, the fix and how to prevent it. Also as plain HTML: [problems.html](https://sandeepkomal.github.io/Linux/problems.html).
- **Unit file X-ray**: paste a systemd unit or a crontab to see every line explained and the risky ones flagged.
- **Quiz**, **cheat sheet** and an interactive **Linux internals** diagram.

The site lives in [`site/`](./site) (static files, no dependencies, no trackers). Run it locally with `cd site && python3 -m http.server`, then open http://localhost:8000.

Tests (Node.js, no packages):

```bash
node tests/check_site_data.js     # levels, quiz, references, page security rules
node tests/check_playground.js    # every scenario starts broken, wrong moves fail, the fix works
node tests/fuzz_playground.js     # thousands of random commands, no exceptions
node tests/check_xray.js          # unit file and crontab explainer
node scripts/build-problems.js    # regenerate site/problems.html and sitemap.xml after editing site/data.js
node tests/check_problems.js      # fails if they are out of date
```

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

## Contributing
Corrections, useful commands, troubleshooting examples, shell scripts, and practical guides are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md), including how to add a playground scenario.

## License
MIT. See [LICENSE](./LICENSE). Linux® is the registered trademark of Linus Torvalds in the U.S. and other countries. This project is independent and not affiliated with the Linux Foundation.

## Security
Never commit passwords, private keys, API tokens, kubeconfigs, or production configuration.

## Author
**Sandeep Komal** — Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation, and DevSecOps.