# Beneficiaries and Final Wishes implementation evidence

Date: 28 October 2026 (South Africa). Baseline: `6c008a3`, the tested `feature/email-notifications-reply-2fa` branch. Implementation branch: `feature/beneficiaries-final-wishes-legacy`. This feature is proposed as a separate PR against the email baseline; the existing email PR remains independent.

## Delivered behavior

The existing Final Wishes section now contains Personal Letters, Audio & Video Messages, Family History, Personal Instructions and Information Reviews. Existing category/details/contact fields remain available in their original records. Beneficiary cards show assigned content, recipient-specific release state and shortcuts for drafting and managing content in Final Wishes. The separate sign-in and token-entry flows keep their existing behavior.

Owners can edit and preview safe Markdown, inspect encrypted revisions, assign several existing beneficiaries to one record, link existing vault entries, link letters/recordings, attach multiple managed files, mark ready, explicitly release/revoke, archive, and schedule/complete/snooze reviews. Family histories retain unknown or approximate dates and have chronological/search views. Ordered instruction acknowledgements are separate from the canonical owner checklist.

## Permission and migration decisions

- Restricted content stays in `legacy_*` tables and new access-controlled routes. Existing full-vault beneficiary serialization/search/export never reads those tables. Encrypted payloads include titles, Markdown, descriptions, introductions, family details, tags and checklist text; previous revisions remain encrypted. IDs, lifecycle, policies, review dates and event times are ordinary SQLite metadata.
- The additive schema migration preserves old vault ciphertext, beneficiary/token rows and document associations. It is transactional, repeatable and refuses partial feature schemas. Optional Final Wishes parents use `ON DELETE SET NULL`. Removing a beneficiary deletes its mappings rather than the owner's record or files.
- Token-authenticated content uses the existing beneficiary identity. Each list, detail, acknowledgement, preview, download and range request checks the current token, expiry, general grant, explicit assignment, released lifecycle, matching policy and absence of revocation. Beneficiary-supplied IDs cannot change identity. Rejected attempts are recorded without personal contents or credentials.
- `draft`, `ready`, `archived` and `owner_only` do not confer beneficiary access. Manual release requires explicit owner confirmation. Emergency requests alone do not release; the elapsed waiting/manual emergency grant must occur. Switch items release only within the actual configured expiry transaction. A consumed event cannot release subsequently created content or mappings on replay. A late check-in preserves released content.
- The tested old general-vault regrant behavior is preserved. New per-recipient revocation barriers survive that regrant. Editing released payloads or attachment sets withdraws prior release and returns content to draft. Protected document labels/descriptions cannot be changed through the generic document API to bypass revision/release controls.
- Release/access events are append-only. Release/grant/audit/notification changes share transactions where applicable; failed durable release auditing rolls back permission changes. Mutation-denial auditing occurs outside the failed transaction.

## Managed media

New attachment uploads reuse the existing picker/drop component and private managed storage. Accepted extensions are PDF, PNG, JPEG, WebP, DOC/DOCX, XLS/XLSX, TXT, MP3, M4A, WAV, MP4 and MOV. The server checks signatures and media framing/container structure instead of trusting browser MIME. MP3 uses complete MPEG frame bounds, WAV uses RIFF chunks, and MP4-family containers require compatible format, movie metadata and media data. These checks do not transcode or establish browser codec compatibility.

`DOCUMENT_MAX_FILE_MB` defaults to 25 MiB, capped at 100 MiB, with eight files per multipart request. Invalid configuration retains a finite default. `LEGACY_STORAGE_QUOTA_MB` defaults to 2048 MiB per owner. Content supports up to 100 attachments. Files are copied under generated names, with private folders/files and recorded SHA-256/size. New managed photo copies strip incidental EXIF/GPS/text metadata; originals remain unchanged. Existing images are not retroactively scrubbed.

A durable `managed_documents.legacy_restricted` flag prevents protected copies from leaking through old document associations/endpoints, even after every protected association is removed. Unassigned ordinary managed documents can be promoted; documents already shared through ordinary vault records require a separate protected copy. Multiple records/recipients can share the same protected managed file. Unlink/archive/remove never deletes source files or the retained managed master copy.

Authenticated HTTP content supports full and single/suffix byte ranges with bounded 206/416 handling and private/no-store headers. Browser playback uses a fetched private blob, never a token-bearing URL; navigation closes playback and revokes object URLs. Unsupported codecs retain authenticated downloads. HTML/SVG/script previews and remote Markdown images are not supported.

**Managed binary bytes remain plaintext**, protected by filesystem ownership and permissions. Textual encryption must not be described as binary encryption. Use encrypted storage and backup destinations when needed.

## Review/email and recovery

Reviews use an independent durable outbox job with deduplication per review occurrence and send-time validation. Notices contain generic wording and omit item titles/body/files/checklists. Reviewing information does not change owner check-in, switch cycles, grants, the five daily expiry reminders or the current verified-mailbox reply protocol. No new beneficiary email channel is introduced.

The ordinary JSON backup/export remains an ordinary-entry export and does not contain protected records/media. Settings and README say so explicitly. The complete stopped snapshot tool includes the database/WAL, matching keys, private configuration, full managed-file tree, source revision and optional effective service unit. Verification authenticates encrypted values with the matching key, checks SQLite integrity/FKs and all media hashes. Disposable restore preserves releases/mappings/revisions/reviews and quarantines outbound mail. See [recovery and rollback instructions](legacy-recovery.md).

Failed multipart saves clean staged/new files and roll back rows/revisions. Explicit storage maintenance reports aged abandoned uploads/untracked generated copies by default; purging requires a stopped-writer acknowledgement. Tracked/unassigned managed masters and original source files are preserved.

## Validation and deployment boundary

Automated tests use synthetic in-memory databases and disposable private directories. Browser acceptance loads the real application HTML/JS/styles in Firefox with synthetic API responses. Startup acceptance starts the actual Express entrypoint in a disposable copied checkout on a private loopback port, exercises both new route mounts, confirms old export isolation and private-media CSP, then shuts it down. The systemd unit passes `bash scripts/setup-systemd.sh --check`; it configures `wolfs-legacy.service` for the `wolf` account and port 4444.

Final verification on Node.js 24.16.0: `npm test` passed **196 Node tests and 4 Python tests**, with zero failures or skipped tests. This includes real Firefox suites for the existing email flow and 28 Final Wishes/beneficiary interaction and safety checks. `git diff --check`, `bash -n scripts/backup-managed.sh` and `bash scripts/setup-systemd.sh --check` passed. Suites cover existing email/auth/documents/HomeBank behavior, positive and negative beneficiary permissions, release distinctions/replay/rollback, safe Markdown, media uploads/metadata/quota/cleanup, additive migrations, reviews, complete recovery, maintenance and browser workflows.

Screenshots contain synthetic examples only:

- [Owner Final Wishes workspace](screenshots/legacy/final-wishes-owner.png)
- [Beneficiary released-content view](screenshots/legacy/beneficiary-personal-content.png)

The owner subsequently authorized deployment; see the [production deployment record](beneficiaries-final-wishes-deployment.md). The following checklist is retained for future deployments:

1. Review this PR and its baseline email dependency, audit, migration and recovery runbook.
2. Stop every application/mail writer and capture/verify a complete pre-upgrade snapshot with the matching keys and effective unit.
3. Confirm service ownership, private storage permissions, configuration/limits and the intended source revision.
4. Apply the reviewed code, then check `/health`, both existing sections, representative token authorization, documents/media and HomeBank on port 4444.
5. Recheck provider email operation under the existing email acceptance process when operational configuration changes. Keep the previous source/snapshot available for reviewed rollback.

Final review identified the original working checkout as the active service working directory. The completed feature was moved into a separate worktree, and the service checkout was restored to its original `6c008a3` email baseline before publishing the PR. The service was not restarted; no live database migration, real-email send or merge was performed. Isolated tests and unit validation do not claim production deployment acceptance.

The subsequent owner-authorized production cutover deployed runtime revision `8a8be54` on 28 October 2026. See the [live verification and rollback record](beneficiaries-final-wishes-deployment.md); the isolation statements above describe the preceding implementation phase.
