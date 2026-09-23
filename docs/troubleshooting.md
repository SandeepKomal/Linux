# Linux Troubleshooting Guide

Use this sequence when diagnosing a Linux server issue:

```text
Reachability
  -> CPU / memory / disk
  -> process / service
  -> listening ports
  -> application logs
  -> DNS / routes
  -> permissions / dependencies
```

## Resource checks
```bash
uptime
free -h
df -h
lsblk
top
```

## CPU / memory
```bash
ps aux --sort=-%cpu | head
ps aux --sort=-%mem | head
free -h
```

## Disk
```bash
df -h
du -sh /var/* 2>/dev/null | sort -h
find /var -type f -size +500M -ls 2>/dev/null
```

## Services and logs
```bash
systemctl status <service>
journalctl -u <service> --since '30 min ago'
journalctl -u <service> -f
```

## Network
```bash
ip addr
ip route
ss -lntp
getent hosts example.com
curl -v http://localhost:8080
```