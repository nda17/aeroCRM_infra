#!/usr/bin/env bash
set -euo pipefail
umask 077

version=v22.23.2
archive="node-${version}-linux-x64.tar.xz"
expected_sha256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
tools_dir=/opt/aerocrm/tools
install_dir="$tools_dir/node-${version}-linux-x64"
node_bin="$install_dir/bin/node"
case "${1:-}" in
  '') checked_scripts=(crm-contract-cutover.mjs crm-contract-cutover-preflight.mjs) ;;
  --billing) checked_scripts=(billing-capacity-migration.mjs) ;;
  --crm-custom-roles) checked_scripts=(crm-custom-roles-migration.mjs) ;;
  --crm-sales-commerce) checked_scripts=(crm-sales-commerce-migration.mjs) ;;
  --crm-intake-notifications) checked_scripts=(crm-intake-notifications-migration.mjs) ;;
  --rollback-guard) checked_scripts=(backend-rollback-compatibility-guard.mjs) ;;
  *) echo 'Unknown Node verification mode' >&2; exit 64 ;;
esac
[[ $# -le 1 ]] || { echo 'Too many Node verification arguments' >&2; exit 64; }

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'Cutover Node requires Linux x86_64'
for command in curl xz tar sha256sum flock docker; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command is unavailable: $command"
done
mkdir -p "$tools_dir"
[[ -w "$tools_dir" ]] || fail 'Cutover tools directory is not writable'

verify_runtime() {
  local candidate="$1"
  [[ -f "$candidate" && -x "$candidate" ]] || fail 'Cutover Node binary is unavailable'
  [[ "$("$candidate" --version)" == "$version" ]] || fail 'Cutover Node version mismatch'
  "$candidate" -e "import('node:util').then(({ parseEnv }) => {
    if (parseEnv('AEROCRM_CUTOVER_NODE_OK=1').AEROCRM_CUTOVER_NODE_OK !== '1' ||
        typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') process.exit(1)
  })" || fail 'Cutover Node runtime smoke failed'
  for checked_script in "${checked_scripts[@]}"; do
    "$candidate" --check "/opt/aerocrm/scripts/$checked_script"
  done
}

if [[ -e "$install_dir" || -L "$install_dir" ]]; then
  verify_runtime "$node_bin"
  printf '%s\n' "$node_bin"
  exit 0
fi

temporary_dir=$(mktemp -d "$tools_dir/.node-${version}.XXXXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --max-time 120 \
  --output "$temporary_dir/$archive" \
  "https://nodejs.org/dist/$version/$archive"
(
  cd "$temporary_dir"
  printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check --status
) || fail 'Cutover Node archive checksum mismatch'
mkdir "$temporary_dir/unpacked"
tar -xJf "$temporary_dir/$archive" -C "$temporary_dir/unpacked" --strip-components=1
verify_runtime "$temporary_dir/unpacked/bin/node"
[[ ! -e "$install_dir" && ! -L "$install_dir" ]] || fail 'Cutover Node cache appeared during install'
mv -T "$temporary_dir/unpacked" "$install_dir"
verify_runtime "$node_bin"
printf '%s\n' "$node_bin"
