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
Corrections, useful commands, troubleshooting examples, shell scripts, and practical guides are welcome.

## Security
Never commit passwords, private keys, API tokens, kubeconfigs, or production configuration.

## Author
**Sandeep Komal** — Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation, and DevSecOps.