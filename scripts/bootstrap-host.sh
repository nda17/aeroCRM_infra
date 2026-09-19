#!/usr/bin/env bash
set -Eeuo pipefail

# Run via scripts/ssh.mjs as the initial administrator on a new aeroCRM VPS.
: "${CRM_HOST_ROLE:?frontend or backend required}"
: "${CRM_DEPLOY_PUBLIC_KEY:?deployment public key required}"
: "${CRM_SSH_PORT:=22}"
[[ "$CRM_HOST_ROLE" == frontend || "$CRM_HOST_ROLE" == backend ]]
[[ "$CRM_SSH_PORT" =~ ^[0-9]+$ ]]
[[ "$CRM_DEPLOY_PUBLIC_KEY" == ssh-ed25519\ * ]]
[[ "$(id -u)" == 0 ]]
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 22.04 ]]
if [[ -e /etc/aerocrm-host-role ]]; then
  [[ "$(cat /etc/aerocrm-host-role)" == "$CRM_HOST_ROLE" ]]
fi
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
install -m 0600 /dev/null /var/log/aerocrm-bootstrap.log
exec 3>&1
exec >>/var/log/aerocrm-bootstrap.log 2>&1
trap 'printf "Bootstrap failed in phase %s; inspect the private host log\n" "$phase" >&3' ERR

phase=packages
printf 'Installing host packages\n' >&3
apt-get update
apt-get install -y ca-certificates curl gnupg ufw nginx certbot python3-certbot-nginx unattended-upgrades
apt-get upgrade -y
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

phase=access
printf 'Preparing deployment account and directories\n' >&3
id aerocrm >/dev/null 2>&1 || useradd --create-home --shell /bin/bash aerocrm
usermod -aG docker aerocrm
install -d -m 0700 -o aerocrm -g aerocrm /home/aerocrm/.ssh
touch /home/aerocrm/.ssh/authorized_keys
grep -qFx "$CRM_DEPLOY_PUBLIC_KEY" /home/aerocrm/.ssh/authorized_keys || printf '%s\n' "$CRM_DEPLOY_PUBLIC_KEY" >>/home/aerocrm/.ssh/authorized_keys
chmod 0600 /home/aerocrm/.ssh/authorized_keys
chown aerocrm:aerocrm /home/aerocrm/.ssh/authorized_keys
install -d -m 0750 -o aerocrm -g aerocrm /opt/aerocrm /opt/aerocrm/releases
install -d -m 0700 -o aerocrm -g aerocrm /opt/aerocrm/private
install -d -m 0755 /var/www/aerocrm-acme

phase=limits
# Bounded logs and emergency swap protect these initial 4-GiB hosts.
install -d -m 0755 /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  printf '%s\n' '{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' >/etc/docker/daemon.json
  systemctl restart docker
fi
if ! swapon --show --noheadings | grep -q .; then
  if [[ ! -e /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/90-aerocrm.conf
sysctl --system

phase=firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow "$CRM_SSH_PORT/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Containers are subsequently published only on loopback; UFW does not filter
# Docker's public port publishing. DB and RabbitMQ have no public ports.
printf '%s\n' "$CRM_HOST_ROLE" >/etc/aerocrm-host-role
chmod 0644 /etc/aerocrm-host-role
printf 'Bootstrap complete: role=%s; deploy account ready; SSH password access preserved\n' "$CRM_HOST_ROLE" >&3
docker --version >&3
docker compose version >&3
