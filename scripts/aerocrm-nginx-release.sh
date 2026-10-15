#!/usr/bin/env bash
set -euo pipefail

# Install this reviewed helper as root at /usr/local/sbin/aerocrm-nginx-release.
# A changed frontend vhost requires a reviewed helper with its new SHA-256.
action=${1:-}
sha=${2:-}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
if [[ "$action" == configure ]]; then
  [[ $# -eq 4 && "$3" =~ ^[a-f0-9]{64}$ && "$4" =~ ^[a-f0-9]{64}$ ]] || exit 64
elif [[ "$action" == recover ]]; then
  [[ $# -eq 3 && "$3" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ $# -eq 2 ]] || exit 64
fi
[[ "$action" == check || "$action" == apply || "$action" == rollback || "$action" == commit ||
  "$action" == recover || "$action" == verify || "$action" == configure || "$action" == ready ]] || exit 64
[[ $(id -u) -eq 0 && $(cat /etc/aerocrm-host-role) == frontend ]] || exit 1

vhost=/etc/nginx/sites-available/aerocrm
enabled=/etc/nginx/sites-enabled/aerocrm
staged=/opt/aerocrm/nginx/frontends.conf
state_dir=/var/lib/aerocrm/nginx-release
current_file=$state_dir/current.sha
pending_file=$state_dir/pending.sha
backup_file=$state_dir/previous.conf
baseline_sha=4e1b95ea60417e4ac3a7252fa62d1c9ed56472b48678df684540e617ac2f84a5
candidate_sha=4d1b6152e68f3997e8ad54f90542cdd8af1a816804ecb54a54df7181d902d35d

# Configure uses its root-owned durable journal, independently of ordinary release.
configure_pending=$state_dir/configure.pending.json
if [[ "$action" == configure ]]; then
  controller=$state_dir/configure-$candidate_sha/controller.py
  [[ -d "$state_dir" && ! -L "$state_dir" && $(stat -c '%u:%g:%a' "$state_dir") == 0:0:700 &&
    -d "${controller%/*}" && ! -L "${controller%/*}" && $(stat -c '%u:%g:%a' "${controller%/*}") == 0:0:700 &&
    -f "$controller" && ! -L "$controller" && $(stat -c '%u:%g:%a' "$controller") == 0:0:600 &&
    $(sha256sum "$controller" | cut -d' ' -f1) == '989693e7413b857d3cd5d5ef3f4ae68d5824cf224f7387aa4a1fffbe3dd2764c' ]] || exit 1
  exec python3 "$controller" configure "$sha" "$3" "$4"
fi
[[ ! -e "$configure_pending" && ! -L "$configure_pending" ]] || { echo 'Config-only Nginx transaction pending' >&2; exit 1; }
if [[ "$action" == ready ]]; then
  [[ ! -e "$pending_file" && ! -L "$pending_file" && ! -e "$backup_file" && ! -L "$backup_file" ]] || exit 1
  exit 0
fi

[[ -f "$vhost" && ! -L "$vhost" && -L "$enabled" ]] || exit 1
[[ $(readlink -f "$enabled") == "$vhost" ]] || exit 1
install -d -m 0700 "$state_dir"

file_sha() { sha256sum "$1" | cut -d' ' -f1; }

validate_health() {
  python3 -c 'import json,sys
def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result: raise ValueError("Duplicate health field")
        result[key]=value
    return result
value=json.load(sys.stdin,object_pairs_hook=unique)
assert type(value) is dict and set(value)=={"status","application","revision"}
assert value=={"status":"ok","application":sys.argv[1],"revision":sys.argv[2]}
' "$1" "$sha"
}

verify_https() {
  local app domain
  while read -r app domain; do
    curl --fail --silent --show-error --noproxy '*' --proto '=https' \
      --resolve "$domain:443:127.0.0.1" --connect-timeout 2 --max-time 5 \
      --retry 4 --retry-delay 1 --retry-connrefused \
      "https://$domain/__frontend/health" | validate_health "$app" || return 1
  done <<'TARGETS'
landing aerocrm.space
crm workspace.aerocrm.space
admin-panel admin.aerocrm.space
TARGETS
}

service_action() {
  local mode="$1" state
  state=$(systemctl show nginx --property=ActiveState --value) || return 1
  case "$state" in
    active) if [[ "$mode" != recover ]]; then systemctl reload nginx || return 1; fi ;;
    inactive|failed) systemctl start nginx || return 1 ;;
    *) echo 'Nginx is in an unreviewed transitional state' >&2; return 1 ;;
  esac
  systemctl is-active --quiet nginx
}

frontend_snapshot() {
  local app port observed
  while read -r app port; do
    observed=$(docker inspect --format '{{.Id}} {{.Image}} {{.Config.Image}} {{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.State.StartedAt}} {{.RestartCount}} {{.State.OOMKilled}}' "aerocrm-frontend-$app-1") || return 1
    read -r id image tag running revision started restarts oom <<< "$observed"
    [[ "$id" =~ ^[a-f0-9]{64}$ && "$image" =~ ^sha256:[a-f0-9]{64}$ &&
      "$tag" == "aerocrm/$app:$sha" && "$running" == true && "$revision" == "$sha" &&
      "$restarts" =~ ^[0-9]+$ && "$oom" == false && -n "$started" ]] || return 1
    printf '%s %s\n' "$app" "$observed"
    curl --fail --silent --show-error --noproxy '*' --connect-timeout 2 --max-time 5 \
      "http://127.0.0.1:$port/__frontend/health" | validate_health "$app" || return 1
  done <<'TARGETS'
landing 3100
crm 3200
admin-panel 3300
TARGETS
}

frontend_env_hash() {
  local directory=/opt/aerocrm/env/frontend
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  [[ $(find "$directory" -maxdepth 1 -type f -name '*.env' | wc -l) -eq 3 ]] || return 1
  [[ -z $(find "$directory" -maxdepth 1 -name '*.env' \( -type l -o -perm /077 \) -print) ]] || return 1
  (cd "$directory" && find . -maxdepth 1 -type f -name '*.env' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}

config_fingerprint() {
  sha256sum /etc/nginx/nginx.conf "$vhost" "$staged" "$current_file" \
    /etc/letsencrypt/live/aerocrm.space/{cert,chain,fullchain,privkey}.pem | sha256sum | cut -d' ' -f1
}
expected_current=$baseline_sha
if [[ -e "$current_file" ]]; then
  [[ -f "$current_file" && ! -L "$current_file" ]] || exit 1
  expected_current=$(cat "$current_file")
  [[ "$expected_current" =~ ^[a-f0-9]{64}$ ]] || exit 1
fi

atomic_install() {
  local temporary
  temporary=$(mktemp "${vhost}.aerocrm.XXXXXX") || return 1
  if ! install -m 0644 "$1" "$temporary" || ! mv -f "$temporary" "$vhost"; then
    rm -f "$temporary"
    return 1
  fi
}

restore() {
  [[ -f "$backup_file" && ! -L "$backup_file" ]] || return 1
  local restored_sha
  restored_sha=$(file_sha "$backup_file") || return 1
  atomic_install "$backup_file" || return 1
  nginx -t || return 1
  service_action apply || return 1
  printf '%s\n' "$restored_sha" > "$state_dir/current.sha.tmp" || return 1
  mv -f "$state_dir/current.sha.tmp" "$current_file" || return 1
  rm -f "$pending_file" || return 1
  rm -f "$backup_file" || echo 'Old Nginx backup remains for operator cleanup' >&2
}

if [[ "$action" == recover ]]; then
  lock=/opt/aerocrm/release.lock
  [[ -f "$lock" && ! -L "$lock" ]] || { echo 'Recovery requires the existing regular release lock' >&2; exit 1; }
  exec 9<"$lock"
  [[ ! -L "$lock" && $(stat -Lc '%d:%i' /proc/self/fd/9) == $(stat -c '%d:%i' "$lock") ]] || exit 1
  flock -n 9 || { echo 'Another frontend release is active' >&2; exit 1; }
  marker=/opt/aerocrm/releases/frontend.sha
  [[ -f "$marker" && ! -L "$marker" && $(cat "$marker") == "$sha" &&
    -f "$current_file" && "$expected_current" == "$candidate_sha" && $(cat "$current_file") == "$candidate_sha" &&
    ! -e "$pending_file" && ! -L "$pending_file" && ! -e "$backup_file" && ! -L "$backup_file" &&
    -f "$staged" && ! -L "$staged" && $(file_sha "$staged") == "$candidate_sha" &&
    $(file_sha "$vhost") == "$candidate_sha" ]] || { echo 'Frontend recovery state drifted' >&2; exit 1; }
  expected_env_hash="$3"
  [[ $(frontend_env_hash) == "$expected_env_hash" ]] || { echo 'Frontend recovery env hash mismatch' >&2; exit 1; }
  before=$(frontend_snapshot)
  config_before=$(config_fingerprint)
  compose_before=$(file_sha /opt/aerocrm/compose/frontend.yml)
  marker_before=$(file_sha "$marker")
  nginx -t
  service_action recover
  verify_https
  [[ $(frontend_snapshot) == "$before" && $(config_fingerprint) == "$config_before" &&
    $(file_sha /opt/aerocrm/compose/frontend.yml) == "$compose_before" &&
    $(file_sha "$marker") == "$marker_before" && $(frontend_env_hash) == "$expected_env_hash" &&
    ! -e "$pending_file" && ! -e "$backup_file" ]] || { echo 'Frontend recovery modified immutable state' >&2; exit 1; }
  echo 'Frontend edge recovery verified: three exact-SHA HTTPS health responses; app/config/cert/env state preserved'
  exit 0
fi

if [[ "$action" == verify ]]; then
  [[ $(file_sha "$vhost") == "$candidate_sha" ]] || { echo 'Live frontend vhost differs from reviewed config' >&2; exit 1; }
  verify_https
  exit 0
fi

if [[ "$action" == rollback ]]; then
  if [[ ! -e "$pending_file" ]]; then exit 0; fi
  [[ $(cat "$pending_file") == "$sha" ]] || exit 1
  restore || { echo 'Nginx rollback failed; inspect root-owned release state' >&2; exit 1; }
  exit 0
fi

if [[ "$action" == commit ]]; then
  if [[ ! -e "$pending_file" ]]; then
    [[ $(file_sha "$vhost") == "$candidate_sha" && "$expected_current" == "$candidate_sha" ]] || exit 1
    exit 0
  fi
  [[ $(cat "$pending_file") == "$sha" && $(file_sha "$vhost") == "$candidate_sha" ]] || exit 1
  printf '%s\n' "$candidate_sha" > "$state_dir/current.sha.tmp"
  mv -f "$state_dir/current.sha.tmp" "$current_file"
  rm -f "$pending_file"
  rm -f "$backup_file" || echo 'Old Nginx backup remains for operator cleanup' >&2
  exit 0
fi

[[ ! -e "$pending_file" && ! -e "$backup_file" ]] || { echo 'Previous Nginx release is pending' >&2; exit 1; }
[[ -f "$staged" && ! -L "$staged" ]] || exit 1
candidate_copy=$(mktemp "$state_dir/candidate.XXXXXX")
trap 'rm -f "$candidate_copy"' EXIT
cp "$staged" "$candidate_copy"
[[ $(file_sha "$candidate_copy") == "$candidate_sha" ]] || { echo 'Staged Nginx config differs from reviewed infra SHA' >&2; exit 1; }
[[ $(file_sha "$vhost") == "$expected_current" ]] || { echo 'Live Nginx vhost drifted from reviewed baseline' >&2; exit 1; }
nginx -t
if [[ "$action" == check ]]; then exit 0; fi
if [[ "$expected_current" == "$candidate_sha" ]]; then
  service_action recover
  exit 0
fi

cp "$vhost" "$backup_file"
chmod 0600 "$backup_file"
printf '%s\n' "$sha" > "$pending_file"
if ! atomic_install "$candidate_copy" || ! nginx -t || ! service_action apply; then
  restore || echo 'Nginx restore failed; root-owned backup and pending marker retained' >&2
  exit 1
fi
