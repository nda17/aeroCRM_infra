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

## Billing capacity FK migration

The additive Billing migration `20260921010000_defer_crm_capacity_bindings` makes two
capacity foreign keys deferred within an existing checkout transaction. For its first
backend release only, set `target=backend`, `billing_capacity_migration=true`, and
`billing_migration_env_hash` to the SHA-256 of the private fixed VPS file
`/opt/aerocrm/env/migrations/billing.env`. The file must be regular, non-symlinked,
mode 0600, and contain only `NODE_ENV=production` and a loopback
`BILLING_DATABASE_URL` for the `aerocrm_billing_migration` role, `aerocrm_billing`
database and `billing` schema. The workflow verifies a pinned local Node runtime before
image transfer. Under the ordinary release lock, `scripts/release.sh` checks exact images
and active env, then runs `scripts/billing-capacity-migration.mjs` before switching images.
The helper verifies the image migration inventory, existing migration history and both
foreign keys before and after Prisma deploy. A failure before image switching leaves the
previous runtime running; successful additive DDL remains on a later image rollback.
Subsequent releases leave `billing_capacity_migration=false` and the hash empty.

## Android artifact

Build/sign with `../aeroCRM_monorepo/aeroCRM_android/scripts/build-release.mjs`.
`scripts/publish-android-apk.mjs` verifies its certificate, publishes only the versioned
APK object to the agreed `content-files` bucket, verifies anonymous download bytes, and
updates the landing release metadata. A published version cannot be replaced with different
bytes. Signing keys and their encrypted backup stay outside Git and S3.
