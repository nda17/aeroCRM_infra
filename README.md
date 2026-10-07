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

## Selective backend releases

CI emits `backend-manifest.json` for the complete 13-app composition. Each entry binds
its own source SHA, effective build-context SHA-256, immutable Docker image ID,
compressed artifact SHA-256 and originating green CI run. The manifest's release SHA
identifies the product snapshot; retained apps may keep older source SHAs. Compose uses
per-app image variables and `APP_REVISION`, so ordinary releases preserve containers
whose image and effective configuration have not changed. Every runtime role, including
retained roles, is checked against its expected image ID, revision and effective
configuration. Resolved snapshot env plus image defaults, process command/user, network,
restart/security policy and stable bind mounts are compared with Docker inspect without
printing private values. The restore profile
is excluded, and an unexpected restore process blocks adoption.

The workflow uploads reviewed infra and manifest into a unique
`releases/staging/<sha>-<run>-<attempt>` directory. It invokes the staged `release.sh`
with its existing arguments plus `REVIEWED_INFRA_DIR`, `BACKEND_MANIFEST_PATH`,
`INFRA_SHA` and `CI_RUN_ID`. The controller acquires `release.lock` before it snapshots
or applies any configuration. Config snapshots retain private env files and reviewed
Compose/RabbitMQ configuration. Active Compose paths stay stable; image substitutions
live in `releases/backend-images.env`, passed explicitly with `docker compose --env-file`.
The host's unrelated `.env` file is preserved.

After the snapshot's reviewed readiness endpoints (30 historically, 32 with mail), immutable runtime identities and enabled closure
capability checks pass, one atomic write commits `releases/backend-state.json`.
This canonical document contains the CI manifest, infra SHA, env/compose hashes and
closure enabled/schema-anchor state. `backend.sha` and closure marker files are derived
projections. The previous complete state is saved in `backend-previous-state.json`;
its matching config snapshot is retained for rollback. Rollback validates every old
image and persisted-data compatibility before restoring its full mixed composition
and private configuration. It never rolls database changes back.

A durable `backend-release.pending.json` journal records the exact target and previous
states before hooks or switching. Repeating its original target/config can complete a
verified partial switch. An unrelated target, unexpected runtime or conflicting canonical
state fails closed. A crash after the canonical write is repaired by validating the
committed runtime/readiness and rewriting projections without restarting containers.
Repeating the same committed manifest/config also skips the Compose switch.

Initial adoption requires a uniform full CI manifest (`force_full_backend=true`), coherent
legacy release/closure markers and the exact 30-role live image inventory. Legacy image
provenance has no CI artifact metadata; the private rollback-only synthesized manifest
uses zero context/artifact hashes and CI run `0`. New committed target manifests always
come from the verified green CI. Existing migration flags retain their reviewed hooks,
but require a uniform full manifest before any mutation. Historical contract cutover and
initial closure-gate enable must finish before adoption; their legacy workflows reject
an adopted canonical state. Ordinary enabled-closure upgrades do not force-recreate CRM
Access. A changed RabbitMQ configuration explicitly recreates RabbitMQ; unchanged broker
configuration retains its container and stable bind path.

The three loopback-only RabbitMQ directives are published as `0644` so the broker's
non-root runtime can read the bind mount after a cold start. Env files and release
marker writes keep `0600`. Under `release.lock`, a release first checks the live
RabbitMQ file against the validated previous snapshot (or previous/target during
an exact pending retry), its owner and inode, and the existing broker container's
labels, read-only bind and restart policy. A known `0600` file is repaired in place;
the controller waits for automatic broker health before continuing normal runtime
and release readiness guards. An explicitly stopped broker or
unrecognized file fails closed. The broker volume, users and queues are preserved.

Infrastructure CI runs strict manifest/runtime fixtures, interrupted-switch and rollback
fixtures, existing policy checks and a real Docker Compose container-retention regression.
Production release continues exclusively through the GitHub workflow.

## Corporate mail configuration and release

Use `aeroCRM_monorepo/.github/workflows/corporate-mail-release.yml` for the backend.
The first release uses a green uniform full manifest, `apply_migration=true`, and
`crm_customers_migration_env_hash` for the existing private
`/opt/aerocrm/env/migrations/crm-customers.env`. To install the missing workers' env
and API mail configuration, also set `install_env=true`,
`backend_env_before_hash`, `mail_env_bundle_hash`, and `backend_env_hash` (the approved
aggregate **after** the change). Keep all three mail gates `false` and provision
the valid mail encryption key/id in this first disabled snapshot before enabling.
The next enable release preserves that exact key/id, so a guarded rollback still
retains the key needed to read admitted writes. Later config/enable releases use
`apply_migration=false` with an empty migration hash and retain `install_env=true`.
An image-only release uses `install_env=false` and leaves both scoped hashes empty.
Frontend release follows successful backend readiness at the same approved SHA.

Prepare only from approved private input and the existing runtime credentials;
do not regenerate database/service credentials or an existing mail encryption key.
With all three mail gates explicitly `false`, the three Customers roles can start
without S3 or encryption settings; a keyless disabled release must be followed by
another disabled release provisioning the key/id before enablement. Enabling
requires that same valid 32-byte base64 key/id in the previous snapshot and
complete private S3 configuration, with a separate access key restricted to
`mail/*`. Backup, Support and avatar access keys cannot be reused. Verify the real
bucket policy separately; configuration validation does not prove its permissions.
An existing mail encryption key and key id cannot be removed or rotated by this path.

From this infra checkout, render and create a private canonical three-file bundle:

```bash
umask 077
node scripts/render-env.mjs
node scripts/backend-mail-env.mjs --bundle ../.deploy/env/backend ../.deploy/crm-customers-mail-env.json
gh secret set CRM_CUSTOMERS_MAIL_ENV_BUNDLE --repo nda17/aeroCRM_monorepo < ../.deploy/crm-customers-mail-env.json
```

The helper prints only the bundle SHA-256 and reviewed filenames. GitHub reads the
secret from stdin; never paste its contents into workflow inputs, logs, or artifacts.
The existing reusable workflow inherits repository secrets, so this secret lives in
the monorepo repository. Local `sync-env.mjs` is not a mail install/enable path.

For both aggregate hashes, use the existing release algorithm from the corresponding
private backend directory (GNU `sha256sum`/`sort` are required):

```bash
find . -maxdepth 1 -type f -name '*.env' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
```

The before directory must be a verified private copy of the current VPS env,
matching its read-only aggregate hash. Build a local candidate from that copy with
the same scoped validation used by the controller; supply absolute private paths:

```bash
node --input-type=module - /absolute/bundle.json BUNDLE_SHA256 /absolute/before-env /absolute/new-candidate <<'NODE'
import { stageMailEnvironment } from './scripts/backend-mail-env.mjs';
const [bundleFile, bundleHash, sourceDirectory, candidateDirectory] = process.argv.slice(2);
stageMailEnvironment({ bundleFile, bundleHash, sourceDirectory, candidateDirectory });
NODE
```

Compute the after aggregate in `new-candidate` and review both hashes and the scoped
change before dispatch. Only three fixed Customers files can differ; canonical env
rows reject duplicate keys and unreviewed mail fields. All unrelated API/worker
settings and existing keys are preserved. CI stages the pinned bundle privately
with mode 0600. Under the same `release.lock`, the controller builds the target
snapshot from the immutable previous env, checks before/bundle/after hashes, and
records the existing durable journal before applying live configuration. Its
guarded rollback restores the previous complete env and process inventory while
preserving additive database changes. A pending 30-to-32 switch may temporarily
have one new worker; only the exact reviewed target can resume it, and final
readiness/runtime verification still requires both workers. Do not combine this
path with historical closure/cutover or unrelated migration hooks.

Missing S3, an allowed live mailbox, and a verified IMAP/SMTP roundtrip remain
acceptance limits. A disabled deployment does not constitute mail enablement.

## Reviewed backend image cleanup

Cleanup runs separately through the monorepo `release-backend-image-cleanup.yml` workflow,
using the same `aerocrm-production-release` concurrency group as deployment.
The frozen approval artifact is `scripts/backend-image-cleanup-reviewed.json`:
105 exact unused backend image IDs and the 27 retained images from the reviewed
28 September inventory. Its unchanged SHA-256 is
`951c3cbdc4894e31941f084c98afe2058acf4ed474336b752346698717aaec3a`.
The artifact retains the original read-only note; the owner's subsequent explicit
approval authorizes only this listed cleanup. It does not authorize a newly
calculated candidate set.

Dispatch from production with `sha` equal to the current workflow commit,
`ci_run_id` for its green exact-SHA monorepo CI, the reviewed `infra_sha`, and
`approved_inventory_hash` above. Before dispatch the operator separately verifies
green exact-SHA Infrastructure CI and records its run ID in the release handoff.
The workflow uses the existing infra SSH deploy key for pinned checkout and runs
cleanup regression tests; it does not claim a cross-repository Actions API guard
for Infrastructure CI. No new GitHub API credential is required.

The staged controller holds `/opt/aerocrm/release.lock` throughout inventory,
deletion and postflight. Before its first deletion, every reviewed candidate and
retained identity/tag/revision/size/reason must match the current inventory.
Canonical, previous, both pending states, schema anchors, legacy markers, and
all stopped/running containers protect their images. A legacy cutover marker,
including an empty one, blocks cleanup. The controller also records hashes and
presence of release files, exact container references, and every installed image
ID, including dangling images, in a durable private journal.

Before each deletion it rechecks that fingerprint and the complete expected
image inventory. Its only mutation command is
`docker image rm --no-prune <one-reviewed-image-id>`, without force; containers,
volumes, tags outside the approved image, databases and broker are not deleted.
Any unexplained drift stops further deletion. One in-flight ID is journaled
before Docker runs and its actual absence is checked before recording completion.
After interruption, rerun the same approved hash and infra SHA: an absent in-flight
ID may reconcile the lost response only when every other reference and installed
ID matches the exact expected post-delete state. Unexpected absence, retagging,
reappearance or extra images require review; no automatic reload or new selection
is attempted.

The completed journal and deterministic report remain in
`releases/backend-image-cleanup/<approval-hash>.json` and `.report.json`. CI uploads
the public report with removed IDs, protected references, remaining inventory,
and total/free/available filesystem bytes for `/opt/aerocrm`, Docker data and
containerd data where present. Image sizes share layers and do not predict freed
space. Repeat the ordinary release capacity gate before delivering new images;
cleanup does not relax its reserve or release checks.

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
Before switching to an older incompatible image, the release stops all 30
non-profile backend writers and consumers, then rejects the switch if CUSTOM data exists, an
administrative-seat operation is unfinished, or any paid period has an administrative
seat adjustment. Failed checks restart the exact containers stopped by the guard. If an
automatic rollback is blocked, `releases/backend-rollback-blocked.pending` permits only a
repeat of the same target SHA; a successful release clears it. Do not remove this marker
or perform an image-only rollback to bypass the data checks.

## CRM Sales commerce migration

The first compatible backend release uses `target=backend` and
`crm_sales_commerce_migration=true`, independently of the historical Billing/CRM Access
migration flags. Set `crm_sales_commerce_migration_env_hash` to the SHA-256 of the fixed
private VPS file `/opt/aerocrm/env/migrations/crm-sales.env`. The file must be regular,
non-symlinked, mode 0600, and contain only `NODE_ENV=production` and the loopback
`CRM_SALES_DATABASE_URL` for the `aerocrm_crm_sales_migration` role, `aerocrm_crm_sales`
database and `crm_sales` schema. The release checks the exact image revision, pinned
service-owned migration and ACL inventories, applies Prisma migrations and new-object
ACL under `release.lock`, and verifies the schema before switching images. Subsequent
releases set the flag to `false` and leave its migration hash empty.

Release order: verify the current service-owned S3 backups and the private migration
env hash, run the green exact-SHA backend release with the commerce migration flag,
confirm the applied CRM Sales migration and all backend readiness checks, then run a
separate frontend release of the same approved application SHA. The frontend must
not expose the new controls before the compatible backend is ready. The new schema
is additive and remains after an image rollback; keep that schema in place and use
the guarded release path for any recovery.

The backend compatibility guard also checks the candidate CRM Sales image. When it
lacks the commerce migration, the release first stops all non-profile backend writers
and consumers, then rejects the image if commerce
business data exists. A preview without applied changes does not bar rollback. A
blocked automatic rollback leaves the existing recovery marker and requires a
commerce-aware target SHA; an image-only rollback is unsafe once commerce data exists.
The verified S3 backups remain recovery evidence, but automatic S3 restore is still
disabled and requires the separate PostgreSQL 18 restore admission work described
in the project backlog.

## CRM Intake notification UUID default migration

The first compatible backend release uses `crm_intake_notifications_migration=true`
and the SHA-256 of the fixed private VPS file
`/opt/aerocrm/env/migrations/crm-intake.env` as
`crm_intake_notifications_migration_env_hash`. The file must be regular,
non-symlinked, mode 0600, and contain only `NODE_ENV=production` and a
loopback `CRM_INTAKE_DATABASE_URL` for the `aerocrm_crm_intake_migration` role,
`aerocrm_crm_intake` database, and `crm_intake` schema. This independent hook
runs under `release.lock`, verifies the exact image and service-owned migration
and ACL inventories, applies only the additive `inbox_notifications.id` UUID
default, then verifies the migration history, trigger and existing runtime/backup
privileges. It does not rewrite ACLs or existing IDs. A failed hook leaves the
previous images running; successfully applied DDL stays in place across image
rollback. Later releases set the flag to `false` and leave its hash empty.

## Workspace closure release

Use `target=backend` with `workspace_closure_migration=true` and the aggregate hash of
the seven fixed private files `env/migrations/{billing,crm-access,crm-customers,crm-intake,crm-sales,identity,notification-delivery}.env`.
Each file must be regular, non-symlinked, mode 0600, and contain only
`NODE_ENV=production` and its service migration-role loopback URL. From
`/opt/aerocrm/env/migrations` on the backend VPS, calculate the aggregate without
printing private values:

```bash
sha256sum ./billing.env ./crm-access.env ./crm-customers.env ./crm-intake.env ./crm-sales.env ./identity.env ./notification-delivery.env | sha256sum | cut -d' ' -f1
```

Keep `CRM_ACCESS_CLOSURE_ENABLED='false'` in all three CRM Access role env files for
this first backend release. Under `release.lock`, the hook checks the exact image
revision, reviewed migration and ACL checksums, private env identities, schema/ACL
and trigger inventory before starting all compatible roles. It records
`releases/workspace-closure-compatible.sha` only after readiness and capability
checks pass. Enable the gate through the GitHub release workflow with
`target=backend`, `workspace_closure_enable=true`, the same green CI/image SHA,
`backend_env_before_hash` for the gate-off env and `backend_env_hash` for the
approved gate-on env. Keep all migration flags false. The reviewed helper runs
under `release.lock`, checks the exact compatible SHA and all image revisions,
and changes only the three CRM Access gate lines; it can resume a partial change
after verifying both projected aggregate hashes. The existing release then
recreates the three CRM Access roles, verifies their live gate and records
`releases/workspace-closure-enabled.sha`. Release
`target=frontend` last at the same SHA; the workflow checks the backend enabled
marker. `target=all` and parallel frontend/backend releases are forbidden. Do not
rerun the historical CRM contract cutover or its previous migration flags.

For a later backend SHA while the closure gate is on, use a green exact-SHA CI
release with all migration and enable flags false. The release keeps the initial
`workspace-closure-compatible.sha` as the schema anchor and verifies every new
and rollback candidate image against the reviewed migrations and ACL for all
seven participants. If the Identity runtime still lacks the manifest's
`UPDATE` grant on `identity.workspaces`, select
`workspace_closure_identity_acl_repair=true` and provide
`workspace_closure_identity_env_hash` as the SHA-256 of the existing private
`env/migrations/identity.env` file. This GitHub release step checks the exact
image, migration history, database owner, ACL and closure triggers, grants only
that table privilege, then verifies the ACL before switching images. It is safe
to repeat with the same reviewed SHA. Mismatched release markers remain blocked
for operator review.

The guarded rollback stops all non-profile backend writers and consumers and
checks all seven databases before allowing images without closure enforcement.
Once a closure fence or operation exists, retain the additive schema and fence;
do not use an image-only rollback. Turning off new closure admission does not
stop recovery of a durable CLOSING operation. Acceptance closes only a dedicated
test workspace; no real payment or customer workspace is involved.

## Android artifact

Build/sign with `../aeroCRM_monorepo/aeroCRM_android/scripts/build-release.mjs`.
`scripts/publish-android-apk.mjs` verifies its certificate, publishes only the versioned
APK object to the agreed `content-files` bucket, verifies anonymous download bytes, and
updates the landing release metadata with `https://aerocrm.space/downloads/aeroCRM.apk`.
It reads the explicit deployment-only `ANDROID_APK_S3_ENDPOINT`, `REGION`, `BUCKET`,
`ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `FORCE_PATH_STYLE` fields from the private
parent `.env`. Avatar runtime credentials are independently restricted to
`content-files/identity/avatars/*` and are never used by this publisher. The existing
public versioned APK is the reviewed exception; runtime Mail, Support, Identity and
Messenger objects in the Standard PRIVATE `content-files` bucket stay private.
The Cold PRIVATE `backup-services` bucket stores only `database-backups/`.
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

## Planner and single-session release

The `planner-customization-release.yml` wrapper runs one reviewed full-backend
release with `crm_planner_customization_migration=true`. Its migration hash is
SHA-256 of sorted `sha256sum` lines for `./crm-sales.env` and `./identity.env`
in the private VPS migration directory. The hook checks both exact-SHA image
inventories and both live migration histories before applying either owner,
then verifies service-owned ACL, guard bodies, triggers, the planner composite
FK and the single-active-session partial unique index before switching images.
A partial attempt is resumed with the same immutable release SHA.

Rollback retains the SQL session policy. The exact reviewed previous Identity
baseline `26e65ad03d535fb7446dcac72dec4251ec820715` may recover after migration
only while all new database guards remain intact; live revocation notification
UX may degrade on that baseline. Other images lacking the new migration are
rejected. An old Sales image is rejected once planner configuration or task
placements exist. The canonical controller keeps its existing compatibility,
readiness, exact-image, configuration and durable release-state checks.
