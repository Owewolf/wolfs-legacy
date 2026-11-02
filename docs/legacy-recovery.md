# Protected Final Wishes deployment and recovery

The expansion uses the existing Beneficiaries and Final Wishes screens. It adds encrypted letters, recordings metadata, family stories, practical instructions, recipient mappings, revision/review history and append-only release events in separate `legacy_*` SQLite tables. Existing Final Wishes entries retain their category, details and contact fields. No existing beneficiary token is replaced by the migration.

## What is private

New items default to `draft` and `owner_only`. A beneficiary needs both a current authorized token and a released, explicitly assigned item. Marking a draft ready never releases it. Manual release requires the owner's explicit item confirmation; switch and emergency policies require their corresponding confirmed access events. Revoking a beneficiary sets a separate restricted-content barrier even if the old general-vault behavior later grants access again. A late check-in preserves existing releases. Editing released content makes the new revision private until another qualifying release.

Titles, Markdown, introductions, descriptions, people/tags, checklist text and revisions are encrypted using AES-256-GCM. Scheduling dates, lifecycle/policy, identifiers and access events remain readable in SQLite. **Managed file bytes, including recordings and photographs, are plaintext files protected by service ownership and filesystem permissions.** Use encrypted storage/backup media when encryption of those bytes is required. The application does not encrypt binary files.

The existing owner JSON backup/export is an export of ordinary vault entries. It does not include these protected records, their binary attachments, complete recipient/release history, keys or notification state. Use the complete operational snapshot below.

## Fedora service and migration

1. Keep the source revision and take a stopped complete snapshot before upgrading. Stop `wolfs-legacy.service` and every separate app/mail writer. Confirm the old checkout or development server is also stopped.
2. Use the `wolf` service account, private `.env` and `data/.secrets` files (`0600`), and `data` plus `/srv/data/files/legacy-vault-managed-documents` directories (`0700`). The managed directory must be a real directory outside public/source-document locations, without symlinks or mountpoints within it; a disk may be mounted at an ancestor. Do not relocate selected originals into managed storage.
3. Install dependencies with `npm ci` and run `npm test` against disposable synthetic fixtures. The supported host needs Node.js and the native `better-sqlite3` build prerequisites. On Fedora, the baseline toolchain is `gcc-c++`, `make`, `python3` and a suitable Node.js installation.
4. Review `.env` using `.env.example`. The normal application listens on **4444**. `DOCUMENT_MAX_FILE_MB` defaults to 25 MiB (capped at 100 MiB); the common picker accepts up to eight files per request. See the email runbook for independent verified-mailbox setup and the actual five-day check-in protocol.
5. Render/check the existing systemd definition with `bash scripts/setup-systemd.sh --check`; render the unit for review with `bash scripts/setup-systemd.sh`. Installation uses `sudo bash scripts/setup-systemd.sh --install --user wolf --node /absolute/node`. This installer does not start the service. Review the working directory, `.env`, Node executable and unit before a production restart.
6. On reviewed application startup, `server/db.js` applies the additive, transactional, idempotent migration in `server/legacy-schema.js`. It records schema version 1 without rebuilding `vault_entries` or rewriting old ciphertext/token hashes. Partial or incompatible feature schemas fail initialization. Confirm `/health`, the existing sections, owner/beneficiary permission tests and HomeBank reporting after the approved deployment.

This runbook describes deployment steps. Automated local tests do not establish a real production restart, successful SMTP delivery or host recovery.

## Complete stopped snapshot

The snapshot tool reads the explicitly supplied app/data, managed-document and optional unit paths. It never initializes the application, generates keys, starts workers, changes source data or sends mail. It copies `data/` (including generated secrets), protected `.env`, the complete managed-file tree and the source commit identifier into a new private directory. Optional effective systemd output is included in the manifest. If a matching encryption key cannot be resolved from the copied `.env` or `data/.secrets`, it fails. If secrets/configuration are supplied only by an external environment or secret manager, first preserve a matching private configuration export; the tool does not infer external secrets.

```bash
sudo systemctl stop wolfs-legacy.service
sudo systemctl is-active wolfs-legacy.service
# Expected: inactive. Inspect and stop every separate/old app or mail writer.

umask 077
WL_BACKUP_ROOT=/mnt/offline/wolfs-legacy-snapshots
WL_SNAPSHOT="$WL_BACKUP_ROOT/20261028T120000Z"
# Choose a unique name and verify the independent disk and free space first.
systemctl cat wolfs-legacy.service > "$WL_BACKUP_ROOT/service-effective.txt"
DOCUMENT_STORAGE_ROOT=/srv/data/files/legacy-vault-managed-documents \
  bash scripts/backup-managed.sh --service-stopped "$WL_SNAPSHOT" \
  "$WL_BACKUP_ROOT/service-effective.txt"
node scripts/managed-recovery.js verify "$WL_SNAPSHOT"
```

`--service-stopped` is an explicit operator acknowledgement, not a process detector. An active writer can invalidate a multi-file snapshot. The destination must not exist, and must be outside the app/media roots. The tool rejects symlinks, nested mountpoints, unsafe manifest paths and non-regular files. It creates directories as `0700` and files as `0600`; it never overwrites an older snapshot or deletes the selected originals. Snapshot files and secrets are not encrypted by this tool: use a verified independent encrypted/offline backup destination.

The copied database's WAL is consolidated **only in the copy**, preserving committed rows. The tool checks SQLite integrity and foreign keys, authenticates every encrypted value using the copied key, verifies every managed document's stored checksum/size, and writes SHA-256 hashes for every copied file. A missing/corrupt managed file or wrong key fails the snapshot. A failed copy remains available for inspection without a valid `manifest.json` completion marker. The manifest detects accidental corruption; it is not a signed authenticity proof.

## Disposable restore verification

Restore to a new, independent, empty staging location while every application/mail worker remains stopped. Never restore over live data. Preserve the original snapshot and current deployment. Keep the staging host disconnected from production SMTP/IMAP during verification.

```bash
node scripts/managed-recovery.js restore --service-stopped \
  /mnt/offline/wolfs-legacy-snapshots/20261028T120000Z \
  /absolute/private/disposable-restore
```

The tool verifies the snapshot first, copies it without changing the original, and checks recovered ciphertext/media again. The existing `email-restore-safety.js` quarantines pending mail, verification state and unused check-in challenges. Legitimate beneficiary grants, item releases, token hashes, revisions, mappings and review history remain preserved. Restored root `.env` appends `NOTIFICATIONS_ENABLED=false`, loopback binding, port 4445 and the staging managed-document path. No server is started.

Inspect `restore-report.json`, SQLite integrity/FK results, file checksums and representative owner records. The copied original manifest describes the original snapshot; quarantine intentionally changes the restored database, and `.env`/report are new staging files, so do not treat the quarantined directory as an unchanged snapshot. Create a new stopped snapshot if that staging state later needs preservation.

Review switch deadlines before any later startup: transport quarantine does **not** pause expiry or reset check-in. A deliberately restarted application may process an elapsed deadline. Production cutover requires a reviewed source revision, correct service paths/ownership, matching secrets and managed-document configuration; reverify the owner notification address before restoring email check-ins. Keep old snapshots until acceptance is complete.

## Rollback and media lifecycle

Prefer a separate checkout of the recorded previous source commit with its matching pre-upgrade stopped snapshot. Preserve a fresh snapshot of the failed/new state for reconciling later owner changes. Do not drop `legacy_*` tables, reset release flags or assume an older executable understands a newer database. See [email rollback operations](email-operations.md#roll-back-code-without-destroying-data) for unit and quarantine steps.

Removing a recipient/beneficiary or unlinking an attachment preserves the owner's master content and managed copies. Unlinked managed files may remain for recovery; review association tables and take a complete snapshot before any deliberate orphan cleanup. An upload/save failure cleans its temporary server copy; none of these operations delete the original selected file on the owner's computer.

## Storage maintenance

The maintenance command reports abandoned upload-temporary files and untracked generated managed copies, and retains files younger than 24 hours. It requires explicit existing database/storage paths, verifies database integrity, and checks private service ownership, generated names, symlinks, mountpoints and hard links. Run it as the storage-owning service account. The default command only reports candidates:

```bash
node scripts/maintenance-legacy-storage.js \
  --database /home/wolf/Projects/wolfs-legacy/data/vault.db \
  --storage-root /srv/data/files/legacy-vault-managed-documents
```

After reviewing the report and taking a complete snapshot, stop every application/mail writer. Deliberate deletion additionally requires both `--purge --service-stopped` on the same command. Purge rechecks file identity and database tracking before removal. The flag acknowledges the stop; it does not detect running processes. Files referenced by `managed_documents` remain preserved even when their last content association was removed. The command never scans or removes source files in the owner's Documents directory.

## Review reminders

The existing durable outbox sends a generic owner notice when an enabled item's review date is due and its snooze has expired. Unique keys include the item and review occurrence, preventing duplicates across retries/restarts. Content titles, messages, filenames and checklist text are omitted. The worker rechecks review state before sending and cancels stale jobs after review, rescheduling, snooze, archive or disable. SMTP failure/uncertainty uses the existing persisted retry rules.

An owner must have a verified notification recipient and enable the existing notification worker. Review actions and emails never check in, consume a check-in challenge, grant access or alter the five daily expiry reminders. Beneficiary email delivery is not enabled: the existing verified owner notification channel is reused, and the protected content appears through the authorized token interface.

## Automated recovery evidence

`node --test tests/legacy-recovery.test.js tests/legacy-review-reminders.test.js tests/legacy-release-integration.test.js` uses only synthetic data in disposable private directories/in-memory SQLite. It verifies ciphertext, revisions, recipient mappings, release history, media, matching keys and mail quarantine; corrupt media, wrong/missing keys, symlinks and traversal are denied. It also checks the distinct switch-release event and rollback, review deduplication and the unchanged five reminder schedule. Run the complete `npm test` regression suite before release.
