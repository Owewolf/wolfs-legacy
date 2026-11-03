# Automatic beneficiary Final Wishes: production deployment

Deployed to **https://wolfspack.co.za** through FTPS following the owner's explicit instruction to commit and deploy. Live verification completed on **3 November 2026 at 13:56:47 SAST (UTC+02:00)**.

- Runtime commit on `main`: `998f854797cdddde31182960e0e9b9dcbcd1197f`.
- Previous runtime: `02d0c63d782720f5b53b2e7c20f5ee7cc4cf592d`.
- All **71 runtime files** match the committed manifest; 11 files changed. Dependencies were unchanged.
- The implementation and deployment evidence are committed to `main`; private handover briefs, database copies, configuration and keys are excluded from Git.

## Verified rollout

Application writers were stopped, and new scheduled work was paused. Snapshot creation acquired the existing scheduler lock to wait for any earlier job to finish. The pre-upgrade database, matching keys/environment, all 69 previous runtime files, hosting/scheduler settings and 24 managed files were downloaded and verified locally. Temporary hosted database snapshots and sidecars were removed.

A disposable copy of that fresh production snapshot passed the full migration preflight before publication: all **3 existing wishes were adopted with their IDs, ciphertext, revisions and history preserved**; no replacement wishes were needed. Ninety encrypted fields were authenticated, 10,435 existing rows were preserved, nine recipient-isolation comparisons and three revocation checks passed. A repeated repair changed no rows. No suppression or reconciliation cases were found, and no notification jobs were added.

After publication, the application and unchanged external scheduler resumed. Live verification confirmed:

- Healthy application and matching public JavaScript assets.
- Legacy schema versions 1, 2 and 3, valid SQLite integrity and zero foreign-key violations.
- Three beneficiaries with three valid, exclusive dedicated wish identities; nine live database isolation checks passed.
- Existing values in 12 protected tables preserved, including accounts, vault entries, beneficiaries/tokens/grants, wish payloads/history, documents and associations.
- Private environment and key files unchanged; owner approval and the real Clickatell transport configuration remain valid. Verification sent **zero SMS messages**.
- Invalid beneficiary tokens receive private/no-store 403 responses; anonymous owner administration receives 401; unapproved registration receives 403.

Predeployment local acceptance passed **437 Node tests and 17 Python tests**, with zero failures/skips, plus real Firefox desktop/mobile workflows and 18 actual-entrypoint checks on disposable loopback port 4444. See [implementation and local acceptance](beneficiary-auto-wish-access.md).

## Local-only backup retention

The owner's hosting-space instruction was applied: **89 hosted files were downloaded, verified locally and removed**, including 88 backup files and one obsolete deployment archive. This freed **18,021,692 bytes (about 18 MB)**. Four downloaded SQLite snapshots passed integrity and foreign-key checks. Thirteen backup directories were removed.

The fresh rollout and postflight snapshots are also retained locally. Temporary hosted snapshots, SQLite sidecars, helper scripts and upload files were removed after verification. A final FTP scan found **zero retained backup or deployment artifacts** in the inspected application/domain/temporary/trash/Softaculous trees. Active database files, managed storage, dependencies and normal hosting logs remain present.

Private local recovery material:

- Fresh rollout: `/home/wolf/.cache/wolfs-vault-deploy/auto-wish-20261103T115207Z-a97569eb`.
- Downloaded historical backups: `/home/wolf/.cache/wolfs-vault-deploy/host-backups-local-only-20261103T114545Z`.

These directories contain private recovery material and are excluded from Git. Future deployments must retain recovery copies locally only; download and verify any temporary hosted snapshot, then remove it. No hosted backup retention job was introduced. The existing scheduler continues its normal application background work.

For rollback, stop application and scheduler writers and restore the matching local pre-upgrade source, database, configuration/keys and managed files together. Verify integrity, decryption and managed-file checksums before resuming. Preserve a local stopped snapshot of the current state first if newer owner changes require reconciliation. See [recovery guidance](legacy-recovery.md).
