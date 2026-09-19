#!/usr/bin/env bash
set -euo pipefail

# Run on the target VPS from /opt/aerocrm after CI has loaded every exact-SHA image.
role=${1:?frontend or backend required}
sha=${2:?exact commit SHA required}
expected_env_hash=${3:?env hash required}
[[ "$role" == frontend || "$role" == backend ]] || exit 64
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ "$expected_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
cd /opt/aerocrm
exec 9>release.lock
flock -n 9 || { echo 'Another aeroCRM release is active' >&2; exit 1; }
[[ -f "compose/$role.yml" && -d "env/$role" ]] || exit 1
actual_env_hash=$(cd "env/$role" && find . -maxdepth 1 -type f -name '*.env' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
[[ "$actual_env_hash" == "$expected_env_hash" ]] || { echo 'Environment hash mismatch' >&2; exit 1; }
if find "env/$role" -maxdepth 1 -type f -name '*.env' -perm /077 | grep -q .; then
  echo 'Environment file permissions must be 0600' >&2
  exit 1
fi
if [[ "$role" == frontend ]]; then
  apps=(landing crm admin-panel)
else
  apps=(api-gateway notification-delivery campaigns reporting billing identity platform support operations crm-access crm-intake crm-customers crm-sales)
fi
for app in "${apps[@]}"; do
  docker image inspect "aerocrm/$app:$sha" >/dev/null
  revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "aerocrm/$app:$sha")
  [[ "$revision" == "$sha" ]] || { echo "Image revision mismatch: $app" >&2; exit 1; }
done
previous=$(cat "releases/$role.sha" 2>/dev/null || true)
export IMAGE_SHA="$sha"
rollback() {
  if [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    IMAGE_SHA="$previous" docker compose -f "compose/$role.yml" up -d --remove-orphans
  fi
}
trap rollback ERR
docker compose -f "compose/$role.yml" up -d --remove-orphans
if [[ "$role" == frontend ]]; then
  for port in 3100 3200 3300; do
    curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused --connect-timeout 2 --max-time 5 --retry-max-time 45 "http://127.0.0.1:$port/__frontend/health" >/dev/null
  done
else
  ports=(4100 4401 4500 4600 4800 4801 4802 4803 4900 4901 4902 5000 5001 5100 5101 5102 5200 5201 5202 5300 5301 5302 5310 5311 5312 5317 5318 5320 5330 5331)
  for port in "${ports[@]}"; do
    curl --fail --silent --show-error --retry 20 --retry-delay 3 --retry-connrefused --connect-timeout 2 --max-time 5 --retry-max-time 90 "http://127.0.0.1:$port/health/ready" >/dev/null
  done
fi
mkdir -p releases
printf '%s\n' "$sha" > "releases/$role.sha.tmp"
mv "releases/$role.sha.tmp" "releases/$role.sha"
trap - ERR
printf 'Released %s at %s\n' "$role" "$sha"
