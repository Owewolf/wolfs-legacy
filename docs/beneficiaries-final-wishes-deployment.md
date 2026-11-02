# Beneficiaries and Final Wishes production deployment

Deployed on **28 October 2026**, with live verification completed at **18:45:22 SAST (UTC+02:00)**, following the owner's explicit request to deploy.

- Runtime revision: `8a8be54377ef3deb867a85ec33a941e700f16000`.
- Previous revision: `6c008a3`.
- Service: `wolfs-legacy.service`, running as `wolf` from `/home/wolf/Projects/wolfs-legacy` on port **4444**.
- The live checkout is pinned to the tested revision. The separate feature worktree/PR holds this deployment documentation; no GitHub merge was performed.

## Recovery prepared before cutover

The service was stopped using Fedora administrator authentication. With application writers stopped, a complete private local rollback snapshot was taken at:

`/home/wolf/backups/wolfs-legacy/pre-beneficiaries-20261028T164140Z`

The snapshot contains the database/WAL, matching keys, private configuration, complete managed files, source revision and effective systemd unit. SQLite integrity/foreign keys, authenticated decryption and managed-file hashes verified successfully. A separate disposable restore at `/home/wolf/backups/wolfs-legacy/restore-verification-20261028T164140Z` also passed; only that restored copy's email state was quarantined. The original live notification configuration was retained.

Private preservation fingerprints, recovery evidence, the original untracked expansion brief and live verification results are in:

`/home/wolf/backups/wolfs-legacy/deployment-20261028T164140Z`

These are local same-host recovery copies, not an off-host backup. Their contents and secrets are excluded from Git. See [complete recovery and rollback](legacy-recovery.md) before restoring or changing source revisions.

## Verified live

- systemd reports active/running, successful exit status and zero restart failures following cutover. `/health` returns `status: ok`.
- Schema version 1, all nine feature tables and the persistent restricted-document flag are installed. SQLite integrity passes and there are no foreign-key violations.
- Private fingerprints verify preservation of existing users, vault entries (including original Final Wishes), beneficiaries/token hashes, managed-document metadata, document associations and Dead Man's Switch configuration. Configuration and encryption/JWT key files are byte-for-byte unchanged.
- The owner page serves the new assets and private-media CSP. Authenticated protected-content configuration/list routes work; an invalid beneficiary token is denied. The existing vault API and HomeBank overview respond successfully.
- Storage ownership/private permissions pass validation. Managed files retain their recorded checksums in the verified snapshot.
- Both existing SMTP and IMAP worker health channels report `ready`. No manual check-in, grant, release, test email or synthetic personal content was created in the production vault. Normal configured background processing resumes after startup.
- The full predeployment suite passed **196 Node tests and 4 Python tests**, with zero failures/skips, including both Firefox suites. Actual token-release, media upload, checklist, date/migration and review/check-in independence tests use synthetic fixtures rather than modifying live personal records.

The owner can use the existing **Beneficiaries** and **Final Wishes** sections immediately. Managed binary file bytes retain the documented plaintext/private-filesystem storage behavior; this deployment does not add binary encryption.
