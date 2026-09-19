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

Fresh database bootstrap precedes writers: apply each service migration with its migration role, apply/verify ACLs, bootstrap service administrators and commercial policy, then service-owned settings. Do not reuse old WinWidget databases or credentials for database/broker roles.

Database backups go to private S3. The Ed25519 private signing key is mounted only into the maintenance worker. Restore stays disabled until the separate S3 admission/shared-cluster recovery requirements are fulfilled.
