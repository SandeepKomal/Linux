# Linux Commands — Practical DevOps & Cloud Reference

A hands-on Linux command reference for DevOps, cloud, SRE, system administration, Docker, Kubernetes, and CI/CD work.

## Quick navigation
- Files & directories
- Users & groups
- Permissions & ownership
- Processes & services
- Text processing
- Networking
- Packages
- Archives & transfers
- Disk & storage
- System diagnostics
- DevOps troubleshooting

## Files & directories
```bash
pwd
ls -lah
cd /var/log
mkdir app
touch app.log
cp file.txt /tmp/
mv old new
rm file.txt
find /var/log -name '*.log'
file app.jar
stat app.log
```
> `ll` is commonly an alias for `ls -l`, but is not guaranteed to exist on every Linux system.

## Viewing and editing text
```bash
cat file.txt
less file.txt
head -n 20 app.log
tail -n 50 app.log
tail -f /var/log/app.log
vi file.txt
grep -i 'error' app.log
grep -R 'timeout' /etc/myapp/
```

## Users & groups
```bash
sudo useradd -m appuser
sudo passwd appuser
whoami
id appuser
cat /etc/passwd
sudo groupadd appteam
sudo usermod -aG appteam appuser
groups appuser
cat /etc/group
sudo -iu appuser
sudo -i
```
Avoid using a root shell for routine work. Use `sudo` for scoped administrative commands where practical.

## Permissions & ownership
```bash
ls -l
chmod 640 config.yml
chmod +x deploy.sh
chown appuser:appteam config.yml
chmod 600 ~/.ssh/id_ed25519
chmod 644 app.conf
chmod 755 deploy.sh
```
Be careful with recursive `chmod -R` and `chown -R`; broad permission changes can create security problems.

## Processes & services
```bash
ps aux
ps -ef
top
pgrep -af nginx
kill -TERM <PID>
kill -KILL <PID>
systemctl status nginx
sudo systemctl start nginx
sudo systemctl stop nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
journalctl -u nginx
journalctl -u nginx -f
```
Prefer `TERM` before `KILL` so applications have an opportunity to shut down cleanly.

## Networking
Modern Linux systems commonly use `ip` rather than the older `ifconfig`.
```bash
ip addr
ip route
ip link
ping -c 4 8.8.8.8
curl -I https://example.com
curl -v https://example.com
getent hosts example.com
ss -tulpn
ss -lntp
sudo lsof -i :8080
```

## Packages
### RHEL / Fedora / Amazon Linux style systems
```bash
sudo dnf install nginx
sudo dnf update
rpm -qa
rpm -qi nginx
sudo dnf remove nginx
```
Older environments may use `yum`.

### Debian / Ubuntu
```bash
sudo apt update
sudo apt install nginx
sudo apt upgrade
dpkg -l
sudo apt remove nginx
```

## Archives & transfers
```bash
tar -czf app.tar.gz app/
tar -xzf app.tar.gz
wget https://example.com/file.zip
curl -LO https://example.com/file.zip
scp app.tar.gz user@server:/tmp/
rsync -avz ./app/ user@server:/opt/app/
```

## Disk & storage
```bash
df -h
du -sh .
du -sh /var/* 2>/dev/null | sort -h
lsblk
find /var -type f -size +500M -ls 2>/dev/null
mount
findmnt
```

## System diagnostics
```bash
uname -a
hostnamectl
uptime
free -h
lscpu
lsblk
dmesg | tail -n 50
echo "$PATH"
env
history
command -v docker
command -v kubectl
```

## Shell operators
```bash
command1 && command2
command1 || command2
command1 ; command2
command > file
command >> file
command 2> error.log
command | grep pattern
```

## DevOps troubleshooting workflow
```text
Reachability
   -> CPU / memory / disk
   -> process / systemd service
   -> listening ports
   -> application logs
   -> DNS / route / firewall
   -> permissions / dependencies
```
Useful first checks:
```bash
uptime
free -h
df -h
ps aux --sort=-%cpu | head
ps aux --sort=-%mem | head
ss -lntp
journalctl -u <service> --since '30 min ago'
```

## Safety notes
Commands such as `rm -rf`, `kill -KILL`, recursive `chmod`, recursive `chown`, package removal, and filesystem operations can cause irreversible changes.
Before destructive work on a server, confirm the target, verify whether it is production, and prefer the narrowest reversible action.

## Learning path
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