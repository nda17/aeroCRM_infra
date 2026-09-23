#!/usr/bin/env bash
set -euo pipefail

# Run on the target VPS from /opt/aerocrm after CI has loaded every exact-SHA image.
role=${1:?frontend or backend required}
sha=${2:?exact commit SHA required}
expected_env_hash=${3:?env hash required}
billing_capacity_migration=${4:-false}
billing_migration_env_hash=${5:-}
crm_custom_roles_migration=${6:-false}
crm_custom_roles_migration_env_hash=${7:-}
crm_sales_commerce_migration=${8:-false}
crm_sales_commerce_migration_env_hash=${9:-}
crm_intake_notifications_migration=${10:-false}
crm_intake_notifications_migration_env_hash=${11:-}
workspace_closure_migration=${12:-false}
workspace_closure_migration_env_hash=${13:-}
[[ $# -le 13 ]] || exit 64
[[ "$role" == frontend || "$role" == backend ]] || exit 64
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ "$expected_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
[[ "$billing_capacity_migration" == true || "$billing_capacity_migration" == false ]] || exit 64
[[ "$crm_custom_roles_migration" == true || "$crm_custom_roles_migration" == false ]] || exit 64
[[ "$crm_sales_commerce_migration" == true || "$crm_sales_commerce_migration" == false ]] || exit 64
[[ "$crm_intake_notifications_migration" == true || "$crm_intake_notifications_migration" == false ]] || exit 64
[[ "$workspace_closure_migration" == true || "$workspace_closure_migration" == false ]] || exit 64
[[ "$billing_capacity_migration" == "$crm_custom_roles_migration" ]] || exit 64
if [[ "$billing_capacity_migration" == true ]]; then
  [[ "$role" == backend && "$billing_migration_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ -z "$billing_migration_env_hash" ]] || exit 64
fi
if [[ "$crm_custom_roles_migration" == true ]]; then
  [[ "$role" == backend && "$crm_custom_roles_migration_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ -z "$crm_custom_roles_migration_env_hash" ]] || exit 64
fi
if [[ "$crm_sales_commerce_migration" == true ]]; then
  [[ "$role" == backend && "$crm_sales_commerce_migration_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ -z "$crm_sales_commerce_migration_env_hash" ]] || exit 64
fi
if [[ "$crm_intake_notifications_migration" == true ]]; then
  [[ "$role" == backend && "$crm_intake_notifications_migration_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ -z "$crm_intake_notifications_migration_env_hash" ]] || exit 64
fi
if [[ "$workspace_closure_migration" == true ]]; then
  [[ "$role" == backend && "$billing_capacity_migration" == false &&
    "$crm_sales_commerce_migration" == false && "$crm_intake_notifications_migration" == false &&
    "$workspace_closure_migration_env_hash" =~ ^[a-f0-9]{64}$ ]] || exit 64
else
  [[ -z "$workspace_closure_migration_env_hash" ]] || exit 64
fi
cd /opt/aerocrm
exec 9>release.lock
flock -n 9 || { echo 'Another aeroCRM release is active' >&2; exit 1; }
[[ ! -f releases/crm-contract-cutover.pending ]] || { echo 'CRM contract cutover pending; resume its guarded workflow before an ordinary release' >&2; exit 1; }
rollback_pending=$(cat releases/backend-rollback-blocked.pending 2>/dev/null || true)
[[ -z "$rollback_pending" || "$rollback_pending" =~ ^[a-f0-9]{40}$ ]] || exit 1
if [[ -n "$rollback_pending" && ( "$role" != backend || "$sha" != "$rollback_pending" ) ]]; then
  echo 'A blocked backend rollback must be recovered by repeating its exact target SHA' >&2
  exit 1
fi
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
closure_gate='false'
if [[ "$role" == backend ]]; then
  closure_gate_count=0
  for runtime in crm-access-api crm-access-worker crm-access-outbox-publisher; do
    gate_file="env/backend/$runtime.env"
    [[ -f "$gate_file" ]] || exit 1
    if grep -qx "CRM_ACCESS_CLOSURE_ENABLED='true'" "$gate_file"; then
      closure_gate_count=$((closure_gate_count + 1))
    elif ! grep -qx "CRM_ACCESS_CLOSURE_ENABLED='false'" "$gate_file"; then
      echo 'CRM Access closure gate must be explicit in every process role' >&2
      exit 1
    fi
  done
  [[ "$closure_gate_count" == 0 || "$closure_gate_count" == 3 ]] || {
    echo 'CRM Access closure gate differs across process roles' >&2; exit 1;
  }
  [[ "$closure_gate_count" == 0 ]] || closure_gate=true
  if [[ "$workspace_closure_migration" == true ]]; then
    [[ "$closure_gate" == false ]] || { echo 'Closure gate must be OFF during schema migration' >&2; exit 1; }
  elif [[ "$closure_gate" == true ]]; then
    [[ "$(cat releases/workspace-closure-compatible.sha 2>/dev/null || true)" == "$sha" &&
      "$(cat releases/backend.sha 2>/dev/null || true)" == "$sha" ]] || {
      echo 'Closure gate requires a preceding exact-SHA compatible backend rollout' >&2; exit 1;
    }
  fi
fi
for app in "${apps[@]}"; do
  docker image inspect "aerocrm/$app:$sha" >/dev/null
  revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "aerocrm/$app:$sha")
  [[ "$revision" == "$sha" ]] || { echo "Image revision mismatch: $app" >&2; exit 1; }
done
if [[ "$role" == frontend ]]; then
  sudo -n /usr/local/sbin/aerocrm-nginx-release check "$sha"
else
  node_bin=/opt/aerocrm/tools/node-v22.23.2-linux-x64/bin/node
  [[ -x "$node_bin" ]] || { echo 'Pinned backend release Node is unavailable' >&2; exit 1; }
  "$node_bin" --check scripts/backend-rollback-compatibility-guard.mjs
fi
if [[ "$billing_capacity_migration" == true ]]; then
  "$node_bin" --check scripts/billing-capacity-migration.mjs
  "$node_bin" scripts/billing-capacity-migration.mjs "$sha" "$billing_migration_env_hash"
fi
if [[ "$crm_custom_roles_migration" == true ]]; then
  "$node_bin" --check scripts/crm-custom-roles-migration.mjs
  "$node_bin" scripts/crm-custom-roles-migration.mjs "$sha" "$crm_custom_roles_migration_env_hash"
fi
if [[ "$crm_sales_commerce_migration" == true ]]; then
  "$node_bin" --check scripts/crm-sales-commerce-migration.mjs
  "$node_bin" scripts/crm-sales-commerce-migration.mjs "$sha" "$crm_sales_commerce_migration_env_hash"
fi
if [[ "$crm_intake_notifications_migration" == true ]]; then
  "$node_bin" --check scripts/crm-intake-notifications-migration.mjs
  "$node_bin" scripts/crm-intake-notifications-migration.mjs "$sha" "$crm_intake_notifications_migration_env_hash"
fi
if [[ "$workspace_closure_migration" == true ]]; then
  "$node_bin" --check scripts/workspace-closure-migration.mjs
  "$node_bin" scripts/workspace-closure-migration.mjs "$sha" "$workspace_closure_migration_env_hash"
fi
previous=$(cat "releases/$role.sha" 2>/dev/null || true)
export IMAGE_SHA="$sha"
backend_writers=(api-gateway notification-delivery-worker campaigns-service reporting-service
  billing-api billing-scheduler billing-worker billing-outbox-publisher
  identity-api identity-worker identity-outbox-publisher platform-api platform-outbox-publisher
  support-api support-worker support-outbox-publisher operations-api operations-worker operations-outbox-publisher
  crm-access-api crm-access-worker crm-access-outbox-publisher
  crm-intake-api crm-intake-worker crm-intake-publisher crm-intake-sla-worker crm-intake-sla-publisher
  crm-customers-api crm-sales-api crm-sales-reminders)
guard_backend_candidate() {
  local candidate="$1"
  local guard_status=0
  local writer_id
  local writer_ids_output
  local -a stopped_writer_ids=()
  if "$node_bin" scripts/backend-rollback-compatibility-guard.mjs "$candidate"; then
    return 0
  else
    guard_status=$?
  fi
  [[ "$guard_status" == 2 ]] || return "$guard_status"
  writer_ids_output=$(docker compose -f compose/backend.yml ps -q "${backend_writers[@]}") || return 1
  while IFS= read -r writer_id; do
    [[ -z "$writer_id" ]] || stopped_writer_ids+=("$writer_id")
  done <<< "$writer_ids_output"
  for writer_id in "${stopped_writer_ids[@]}"; do
    [[ "$writer_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  done
  if ! docker compose -f compose/backend.yml stop -t 30 "${backend_writers[@]}"; then
    ((${#stopped_writer_ids[@]} == 0)) || docker start "${stopped_writer_ids[@]}" >/dev/null ||
      echo 'Compatible backend writers need operator recovery' >&2
    return 1
  fi
  if "$node_bin" scripts/backend-rollback-compatibility-guard.mjs "$candidate" --writers-stopped; then
    return 0
  fi
  ((${#stopped_writer_ids[@]} == 0)) || docker start "${stopped_writer_ids[@]}" >/dev/null ||
    echo 'Compatible backend writers need operator recovery' >&2
  return 1
}
if [[ "$role" == backend ]] && ! guard_backend_candidate "$sha"; then
  echo 'Backend image switch blocked by incompatible persisted CRM data or an unverifiable guard' >&2
  exit 1
fi
rollback() {
  local failure=$?
  trap - ERR
  if [[ "$role" == frontend ]]; then
    sudo -n /usr/local/sbin/aerocrm-nginx-release rollback "$sha" || echo 'Nginx rollback needs operator recovery' >&2
  fi
  if [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    if [[ "$role" == backend ]] && ! guard_backend_candidate "$previous"; then
      printf '%s\n' "$sha" > releases/backend-rollback-blocked.pending.tmp
      mv releases/backend-rollback-blocked.pending.tmp releases/backend-rollback-blocked.pending
      echo 'Automatic backend rollback blocked; keeping compatible target writers' >&2
      exit "$failure"
    fi
    if IMAGE_SHA="$previous" docker compose -f "compose/$role.yml" up -d --remove-orphans; then
      printf '%s\n' "$previous" > "releases/$role.sha.tmp" && mv "releases/$role.sha.tmp" "releases/$role.sha"
    else
      echo 'Image rollback needs operator recovery' >&2
    fi
  fi
  exit "$failure"
}
trap rollback ERR
if [[ "$role" == backend && "$closure_gate" == true ]]; then
  docker compose -f "compose/$role.yml" up -d --no-deps --force-recreate \
    crm-access-api crm-access-worker crm-access-outbox-publisher
  docker compose -f "compose/$role.yml" up -d --remove-orphans
else
  docker compose -f "compose/$role.yml" up -d --remove-orphans
fi
if [[ "$role" == frontend ]]; then
  for port in 3100 3200 3300; do
    curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused --connect-timeout 2 --max-time 5 --retry-max-time 45 "http://127.0.0.1:$port/__frontend/health" >/dev/null
  done
  sudo -n /usr/local/sbin/aerocrm-nginx-release apply "$sha"
else
  ports=(4100 4401 4500 4600 4800 4801 4802 4803 4900 4901 4902 5000 5001 5100 5101 5102 5200 5201 5202 5300 5301 5302 5310 5311 5312 5317 5318 5320 5330 5331)
  for port in "${ports[@]}"; do
    curl --fail --silent --show-error --retry 20 --retry-delay 3 --retry-connrefused --connect-timeout 2 --max-time 5 --retry-max-time 90 "http://127.0.0.1:$port/health/ready" >/dev/null
  done
  if [[ "$workspace_closure_migration" == true || "$closure_gate" == true ]]; then
    access_status=$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
      -o /dev/null -w '%{http_code}' \
      'http://127.0.0.1:5300/api/v1/crm/access/workspace-closures')
    [[ "$access_status" == 401 || "$access_status" == 403 ]] || {
      echo 'CRM Access closure capability endpoint unavailable' >&2; exit 1;
    }
    for port in 4900 4800 5320 5330 5310 4401; do
      status=$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
        -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -H 'x-aerocrm-service: crm-access' --data '{}' \
        "http://127.0.0.1:$port/internal/v1/workspace-closures/fence")
      [[ "$status" == 401 || "$status" == 403 ]] || {
        echo "Closure capability endpoint unavailable on port $port" >&2; exit 1;
      }
    done
  fi
  if [[ "$closure_gate" == true ]]; then
    for runtime in crm-access-api crm-access-worker crm-access-outbox-publisher; do
      docker compose -f compose/backend.yml exec -T "$runtime" sh -c '[ "$CRM_ACCESS_CLOSURE_ENABLED" = true ]' >/dev/null
    done
  fi
fi
mkdir -p releases
printf '%s\n' "$sha" > "releases/$role.sha.tmp"
mv "releases/$role.sha.tmp" "releases/$role.sha"
if [[ "$role" == backend ]]; then
  rm -f releases/backend-rollback-blocked.pending
  if [[ "$workspace_closure_migration" == true ]]; then
    printf '%s\n' "$sha" > releases/workspace-closure-compatible.sha.tmp
    mv releases/workspace-closure-compatible.sha.tmp releases/workspace-closure-compatible.sha
  elif [[ "$closure_gate" == true ]]; then
    printf '%s\n' "$sha" > releases/workspace-closure-enabled.sha.tmp
    mv releases/workspace-closure-enabled.sha.tmp releases/workspace-closure-enabled.sha
  fi
fi
if [[ "$role" == frontend ]]; then
  sudo -n /usr/local/sbin/aerocrm-nginx-release commit "$sha"
fi
trap - ERR
printf 'Released %s at %s\n' "$role" "$sha"
