#!/usr/bin/env bash
set -euo pipefail

# Install this reviewed helper as root at /usr/local/sbin/aerocrm-nginx-release.
# A changed frontend vhost requires a reviewed helper with its new SHA-256.
action=${1:-}
sha=${2:-}
[[ $# -eq 2 && "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ "$action" == check || "$action" == apply || "$action" == rollback || "$action" == commit ]] || exit 64
[[ $(id -u) -eq 0 && $(cat /etc/aerocrm-host-role) == frontend ]] || exit 1

vhost=/etc/nginx/sites-available/aerocrm
enabled=/etc/nginx/sites-enabled/aerocrm
staged=/opt/aerocrm/nginx/frontends.conf
state_dir=/var/lib/aerocrm/nginx-release
current_file=$state_dir/current.sha
pending_file=$state_dir/pending.sha
backup_file=$state_dir/previous.conf
baseline_sha=4e1b95ea60417e4ac3a7252fa62d1c9ed56472b48678df684540e617ac2f84a5
candidate_sha=9c150bf83575156e605798e9e805f4f80f1ca3b3314a1fa4766bdaa0970b80bb

[[ -f "$vhost" && ! -L "$vhost" && -L "$enabled" ]] || exit 1
[[ $(readlink -f "$enabled") == "$vhost" ]] || exit 1
install -d -m 0700 "$state_dir"

file_sha() { sha256sum "$1" | cut -d' ' -f1; }
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
  systemctl reload nginx || return 1
  printf '%s\n' "$restored_sha" > "$state_dir/current.sha.tmp" || return 1
  mv -f "$state_dir/current.sha.tmp" "$current_file" || return 1
  rm -f "$pending_file" || return 1
  rm -f "$backup_file" || echo 'Old Nginx backup remains for operator cleanup' >&2
}

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
if [[ "$action" == check || "$expected_current" == "$candidate_sha" ]]; then exit 0; fi

cp "$vhost" "$backup_file"
chmod 0600 "$backup_file"
printf '%s\n' "$sha" > "$pending_file"
if ! atomic_install "$candidate_copy" || ! nginx -t || ! systemctl reload nginx; then
  restore || echo 'Nginx restore failed; root-owned backup and pending marker retained' >&2
  exit 1
fi
