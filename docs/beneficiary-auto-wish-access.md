# Automatic beneficiary Final Wishes: local implementation and rollout

Date: 3 November 2026. Implemented in the existing `main` checkout. This report describes local implementation and acceptance; it does not record a production deployment.

## Result and permission boundary

Beneficiary creation now atomically creates an encrypted, dedicated Final Wish and its immutable relational identity. The same ID appears in the creation response, Final Wishes, the beneficiary's Personal Content summary and token retrieval. A manually assigned wish does not satisfy this requirement.

A beneficiary's valid, unexpired, unrevoked token can immediately list/read only their own automatic wish and its eligible attachments, including draft edits. The normal `no_access` and `waiting` vault responses retain their meaning. This personal entitlement does not grant the ordinary vault, unrelated wishes/files, or unreleased manual content. General vault links and parent entry IDs also require their independent grant and visibility checks. List, detail, media and acknowledgement routes share the same checks and use private/no-store responses.

The owner can edit the content and informational contact fields; the next token read retrieves those edits from the same record. Automatic recipients are locked in both the editor and server mutation paths. A request cannot add, remove, substitute or impersonate an automatic identity through JSON metadata. Manually created wishes retain their multiple beneficiaries, named contacts and existing release policies.

Explicit beneficiary revoke records a separate personal-access barrier even when general vault access was never granted. The authenticated owner can confirm **Restore personal wish access**, which clears only that barrier and the dedicated wish's revoked mapping. General grants, emergency releases and token regeneration do not silently clear it. Expired/rotated tokens and deleted beneficiaries are denied.

An active automatic wish can be archived, retaining its identity and files; ordinary permanent deletion is rejected. Removing the beneficiary archives its wish and records an immutable retirement identity before cascading token/recipient cleanup. The resulting owner archive cannot be edited, restored or reassigned. Its owner can explicitly permanently delete the retired archive through the existing confirmed deletion flow.

## Schema and repair policy

Legacy schema version **3** adds:

- `beneficiaries.auto_wish_access_revoked_at` (nullable).
- `legacy_beneficiary_auto_wishes`, with unique beneficiary/content identities and owner-alignment constraints.
- `legacy_beneficiary_auto_wish_retirements`, retaining original identity after beneficiary removal.
- Triggers protecting identity, owner alignment, exclusive recipient assignments and retirement.

The additive schema initializer is transactional and idempotent. Startup repairs missing dedicated identities before accepting requests. Repair obtains a SQLite write lock before checking assignments; creation, mapping, identity and durable audit changes roll back together on failure. Neither repair path imports notification workers nor sends email/SMS, changes access tokens, grants the vault or triggers a release.

Historical records are handled as follows:

| Existing state | Repair action |
| --- | --- |
| Exactly one consistent prior automatic origin, same owner, one matching recipient, appropriate wish metadata, no named recipients or parent entry | Adopt its ID unchanged. Preserve ciphertext, edits, revisions, dates, files and history. |
| Only ordinary manually authored wishes are assigned | Preserve them and create a separate, empty dedicated automatic wish. |
| Duplicate, mismatched, unreadable or ambiguous historical automatic candidates | Preserve every old record and its permissions; create an empty dedicated wish. Record candidate IDs/reasons in `legacy_auto_wish_reconciliation` audit rows for owner review. |
| Existing `legacy_beneficiary_wish_suppressions` row | Honor it as an administrative disablement. Do not resurrect old content or generate a replacement. |
| Archived dedicated wish | Keep the same identity and archived status; repair does not reactivate it. |
| Retired automatic archive | Preserve its retired identity; never adopt it for a new beneficiary. |

Historical explicit mapping revocation and the latest applicable beneficiary revoke audit are carried into the independent personal-access barrier. New manual-wish deletion no longer creates automatic-wish suppressions. Existing suppressions require a separate, deliberate administrative decision if the owner wants a new empty automatic wish later; removing them is not part of this rollout.

`metadata.origin` is only a migration hint. The persisted relational marker authorizes live access. Ambiguous records are never made newly readable merely because their JSON resembles an automatic wish.

## Local maintenance

Use `scripts/repair-beneficiary-auto-wishes.js` against an explicitly named absolute database path. Supply its matching `ENCRYPTION_KEY` through a private environment, never in command history or a tracked file. The script does not load `.env`, generate keys, import the default application database or start workers.

Default operation is a dry run on a private SQLite online-backup copy:

```sh
node scripts/repair-beneficiary-auto-wishes.js --db /absolute/private/copied-vault.db
```

After reviewing the dry run, an apply operation requires a new absolute backup destination:

```sh
node scripts/repair-beneficiary-auto-wishes.js --db /absolute/private/copied-vault.db --apply --backup /absolute/private/pre-auto-wish.db
```

Run this maintenance against a locally retained snapshot. The apply path makes and verifies the local database backup before migration. Treat its JSON output as operational evidence; it contains counts and reconciliation IDs/reasons, not decrypted contents or access tokens. Repeating repair should produce no new identities, content revisions or duplicate audit events. This database backup is not a substitute for a complete application/media/key recovery snapshot.

For historical reconciliation, inspect owner-scoped audit entries with `action='legacy_auto_wish_reconciliation'`. Each `detail` contains the replacement content ID and preserved candidate IDs/reasons. Review the historical material through the authenticated owner interface; do not automatically merge, retarget or release it. Also review suppression counts before rollout.

A dry run against the existing cached pre-approval deployment snapshot found **3 beneficiaries and 3 unambiguous historical wishes**: all 3 adopt their existing IDs, with **0 creations, 0 suppressions and 0 reconciliation cases**. The matching key was verified against ciphertext and the original snapshot bytes remained unchanged. This is historical snapshot evidence, not a current production audit. The current production database was neither inspected nor repaired; repeat this preflight on a fresh deployment snapshot before rollout.

## Verification and evidence

All automated tests use invented records, private temporary files and isolated SQLite databases. No production database or actual SMS is used.

- Full final `npm test`: **437 Node tests and 17 Python tests passed**, zero failures/skips. This includes the maintenance command and final archive/linked-entry regressions. JavaScript syntax checks for both new commands and `git diff --check` also pass.
- Real Firefox desktop (1440px) and phone (390px): 31 new workflow checks at each width, covering no-access/waiting, empty/edited wishes, locked recipients, manual flexibility, refresh, revoke/restore, retired archives, request races and token storage boundaries. Existing legacy desktop/mobile suites also pass.
- Actual Express entrypoint tests: startup repair, encrypted edits, token reads, unchanged grants, no notification outbox entries, restart idempotency and clean shutdown pass using disposable copied applications.
- Route/model tests cover same-name and cross-owner isolation, attachment/checklist authorization, linked vault filtering, expired/rotated/deleted tokens, crafted recipient/origin mutations, corrupt mappings, legacy adoption, ambiguous candidates, suppressions, concurrent repair and injected migration/mapping/identity/audit failures with successful retries.

The separately run local port-4444 acceptance passed **18 real Firefox/API checks** against the actual Express entrypoint bound to IPv6 loopback, `http://[::1]:4444`. It used a disposable source copy with only a local result callback added, synthetic data and outbound services disabled. Evidence confirms 1 synthetic owner, 2 beneficiaries, 2 dedicated wishes, 0 SMS challenges, 0 notification jobs and 0 unrestricted Final Wish copies. The existing IPv4 port-4444 frontend proxy remained untouched. See the [safe acceptance evidence](evidence/beneficiary-auto-wish-local-acceptance.json).

Repeat it with `node scripts/beneficiary-auto-wish-local-acceptance.js`; Firefox and an available IPv6 loopback port 4444 are required. The runner verifies a unique disposable-instance identity, removes its temporary application/database/profile, and writes the safe result to `/tmp/wolfs-legacy-auto-wish-local-acceptance.json` by default.

## Deployment recommendation and recovery

**Recommendation: deployment-ready with a fresh snapshot preflight.** The owner has now authorized committing and deploying this implementation; deployment is pending completion of the verified commit and rollout. The local acceptance results above do not claim a production deployment, FTP upload, production migration or live token/content test. Preserve the existing SMS OTP, Clickatell and notification configuration during rollout.

Backup retention is **local only**. Keep verified recovery databases, configuration/key copies, media snapshots and source archives in a protected local directory outside Git. Download and verify any temporary hosting backup against its size and cryptographic digest, then remove the hosted copy. Do not retain backup files or archives on the FTP host; this preserves its available disk space. Runtime application data and files remain in place.

Before rollout:

1. Stop every application/background writer and capture a complete verified snapshot: SQLite database/WAL, matching encryption/JWT/OTP keys and private environment, managed file tree, and current source/runtime configuration. Use the established [complete recovery instructions](legacy-recovery.md). Retain the protected recovery copy locally, outside the deployment tree and Git; remove any temporary hosted backup after downloading and verifying it.
2. Run the dry-run repair on a separate restored snapshot with its matching key. Review suppression and reconciliation counts/IDs with the owner; verify managed-file hashes and preserve the report privately.
3. Apply the reviewed source to the intended application directory. With writers still stopped, use the explicit maintenance apply path or allow the normal startup migration/repair. Preserve the verified pre-upgrade snapshot and source revision locally only.
4. Check health, schema version 3, SQLite integrity/foreign keys, one dedicated identity/mapping per non-disabled beneficiary, unchanged users/tokens/grants, historical ciphertext/revisions, private media and all existing authentication flows. Exercise a consented token flow without releasing other content or sending unsolicited notifications.

For rollback, stop all writers and restore the complete matching pre-upgrade source/database/files/keys snapshot together, then verify integrity, decryption and media hashes before starting. Do not deploy the old authorization code against the upgraded database: it lacks the new personal-access and immutable-recipient protections. A rollback discards writes after the snapshot unless they are separately reconciled; preserve a stopped post-upgrade snapshot locally first when recovery requires it, and remove any temporary hosted copy after verified download.
