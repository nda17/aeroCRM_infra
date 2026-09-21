# aeroCRM infrastructure

Two Ubuntu VPS: frontend (landing, workspace, admin) and backend (Gateway, isolated services, PostgreSQL 18, RabbitMQ 4). Containers use host networking with application/database/broker listeners on loopback; Nginx exposes HTTPS.

Keep this checkout beside `aeroCRM_monorepo`. Private inputs live in the parent `.env` and `.deploy/`, outside Git. Never source the consolidated `.env.prod` backup into a runtime.

- `scripts/bootstrap-host.sh`: initial OS, Docker, Nginx and firewall setup; inspect role input before running.
- `scripts/render-env.mjs`: generate explicit service/role env files from approved private input and new credentials.
- `scripts/sync-env.mjs frontend|backend`: reject unexplained drift, transfer atomically, download and verify exact bytes.
- `scripts/database-access.mjs`: generate transactional grants and assertions from each service-owned ACL manifest after migrations.
- `scripts/render-rabbitmq-definitions.mjs`: generate private scoped broker users, topology and permissions before publishers start.
- `scripts/backup-env.mjs`: refresh the private portable configuration backup.

Release through `aeroCRM_monorepo/.github/workflows/release.yml`: exact green production CI SHA, immutable infra SHA and both verified env hashes are required. CI builds images; VPS only load and run them. `scripts/release.sh` serializes deployment and checks every enabled role.

Fresh database bootstrap precedes writers: apply each service migration with its migration role, apply/verify ACLs, bootstrap service administrators and commercial policy, then service-owned settings. Database and broker roles use credentials dedicated to this deployment.

Database backups go to private S3. The Ed25519 private signing key is mounted only into the maintenance worker. Restore stays disabled until the separate S3 admission/shared-cluster recovery requirements are fulfilled.

## CRM contract cutover

The namespace change requires one coordinated backend release. Use the release workflow
with `target=backend` and `crm_contracts_cutover=true`, then release the frontend separately
after backend readiness succeeds. Stage new configuration outside active `env/`, preserving
mode 0600; the stage contains `backend/` plus only the required migration-role files
`migrations/identity.env` and `migrations/notification-delivery.env`. Supply the workflow
with both active and staged env hashes, the exact reviewed infra SHA, and the topology JSON
path. A topology document may omit `users` when existing broker credentials stay unchanged.
Before image transfer, `scripts/ensure-cutover-node.sh` verifies or installs the pinned official Node v22.23.2 archive under `/opt/aerocrm/tools` and checks both cutover scripts. The host needs `curl`, `xz`, `tar`, `sha256sum`, `flock`, `docker`, and write access to that tools directory.
Migration env files retain the renderer's quoted values; the cutover parses them and passes only variable names to Docker, with unquoted values in the Docker client's private environment.

`scripts/crm-contract-cutover.mjs` owns the release lock, stops all affected writers,
requires empty contract ledgers and queues, applies migrations, imports scoped topology,
starts exact-SHA images and reopens Gateway only after readiness. It retires only empty,
unused obsolete queues. Unrelated deliveries are preserved. A private snapshot supports
guarded rollback only while both old and new contract ledgers remain empty; otherwise
writers stay stopped for inspection. No database records or messages are purged.

After a guarded rollback, a pending marker prevents ordinary releases. Inspect the failure
and resume the same reviewed SHA/config using `crm_contracts_cutover_resume=true`.
Do not perform an image-only rollback across this contract migration. After successful
cutover, ordinary releases use `scripts/release.sh` again.

## Billing capacity and administrative-seat migrations

The Billing migrations `20260921010000_defer_crm_capacity_bindings` and
`20260921030000_crm_admin_seat_adjustments` defer two capacity foreign keys and add the
append-only administrative seat ledger. The first compatible backend release is
coordinated with the CRM Access migrations below: set `target=backend`, both
`billing_capacity_migration=true` and `crm_custom_roles_migration=true`, and provide both
private env hashes. `billing_migration_env_hash` is the SHA-256 of the fixed VPS file
`/opt/aerocrm/env/migrations/billing.env`. The file must be regular, non-symlinked,
mode 0600, and contain only `NODE_ENV=production` and a loopback
`BILLING_DATABASE_URL` for the `aerocrm_billing_migration` role, `aerocrm_billing`
database and `billing` schema. The workflow verifies a pinned local Node runtime before
image transfer. Under the ordinary release lock, `scripts/release.sh` checks exact images
and active env, then runs both migration helpers before switching images. The Billing
helper verifies the exact migration inventory and history, deferred foreign keys, ledger
constraints, append-only triggers, and runtime/backup ACL. A failure before image
switching leaves the previous runtime running; successful additive DDL remains after an
image rollback. Subsequent releases set both migration flags to `false` and leave both
migration hashes empty.

## CRM custom roles migration

The same compatible backend release applies the additive CRM Access migrations
`20260921020000_add_crm_custom_member_role`, `20260921020100_crm_custom_roles`, and
`20260921030100_crm_admin_seat_capacity`. Use the coupled flags described above and set
`crm_custom_roles_migration_env_hash` to the SHA-256 of
the private fixed file `/opt/aerocrm/env/migrations/crm-access.env`. The file is a
regular non-symlink with mode 0600 and contains only `NODE_ENV=production` and the
loopback migration-role `CRM_ACCESS_DATABASE_URL`. All three CRM Access runtime env
files must still set `CRM_ACCESS_CUSTOM_ROLES_ENABLED=false`. Under `release.lock`, the
helper checks the exact image and migration inventory, applies all three migrations,
installs and verifies the catalog table/function ACL, and verifies the administrative
seat command/fence constraints before the image switch. Enabling custom-role writes is a
separate reviewed env release after every compatible reader and worker is running.

Every backend switch also checks the candidate Billing and CRM Access image inventories.
Before switching to an older incompatible image, the release stops Gateway and all
Billing/CRM Access writers, then rejects the switch if CUSTOM data exists, an
administrative-seat operation is unfinished, or any paid period has an administrative
seat adjustment. Failed checks restart the exact containers stopped by the guard. If an
automatic rollback is blocked, `releases/backend-rollback-blocked.pending` permits only a
repeat of the same target SHA; a successful release clears it. Do not remove this marker
or perform an image-only rollback to bypass the data checks.

## Android artifact

Build/sign with `../aeroCRM_monorepo/aeroCRM_android/scripts/build-release.mjs`.
`scripts/publish-android-apk.mjs` verifies its certificate, publishes only the versioned
APK object to the agreed `content-files` bucket, verifies anonymous download bytes, and
updates the landing release metadata with `https://aerocrm.space/downloads/aeroCRM.apk`.
The exact Nginx route proxies only the reviewed versioned S3 object over verified HTTPS,
without forwarding browser credentials. Update that fixed target for each new APK version
before running the publisher. The frontend release transfers the reviewed config and,
under `release.lock` after app health checks, uses the root-owned
`/usr/local/sbin/aerocrm-nginx-release` helper for drift-checked install, `nginx -t`,
reload, and rollback. Bootstrap this helper from the reviewed infra commit as root once;
grant the `aerocrm` account passwordless sudo for this exact helper only. A changed
`frontends.conf` requires a reviewed helper with its new SHA-256 before release. The
helper accepts the original vhost SHA-256 only for the first install and records later
applied hashes in its root-owned state. After deployment, verify GET bytes and SHA-256,
HEAD, a small Range request, POST 405, query 400, and no redirect or `Set-Cookie` through
the same-origin route. A published S3 version cannot be replaced with
different bytes. Signing keys and their encrypted backup stay outside Git and S3.
