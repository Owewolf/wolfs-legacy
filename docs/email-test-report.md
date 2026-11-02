# Email implementation evidence and acceptance gate

Date: 28 October 2026 (Africa/Johannesburg). Branch: `feature/email-notifications-reply-2fa`, based on `dc93941`. This report distinguishes automated behavior, observed provider delivery and the completed real simplified-confirmation exercise. The owner’s 28 October instruction supersedes the original two-code workflow; this report does not treat earlier previews or tests as proof of the revised real-provider round trip.

## Automated evidence

`npm test` passed for the simplified implementation: **134 Node tests and 4 Python tests, zero failures/skips**. This includes the real headless Firefox test against the application's actual `index.html`, settings router and acceptance-test banner, with **26 browser behavior checks**. Those browser checks cover one-time address verification with automatic enablement, the simple button-and-send instructions, removal of extra enrollment, vault-password rejection, escaped data, protected optional preferences and navigation cleanup.

The coverage below identifies the tests and state assertions supporting the automated result. Real provider delivery and the owner-sent confirmation were verified independently in the completed acceptance exercise below.

| Brief acceptance item | Verification source |
| --- | --- |
| Five reminders against final expiry | `tests/email-service.test.js`, `tests/email-worker.test.js`: 30+7 releases day 37; worker sends once on days 32–36, with no day-31 or historical backfill. |
| Simple confirmation and new cycle | `tests/email-service.test.js`: real MIME parsing, one protocol-2 confirmation consumed, one check-in, old jobs/challenges cancelled, a new configured cycle and acknowledgement. |
| Address and message validation | Parser/service tests for valid prepared-mail subject without thread headers, direct threaded reply, forged sender, wrong mailbox/subject/thread, forward/automatic/quoted mail, missing/conflicting confirmations, expired/revoked/disabled/released/wrong-owner/cycle and replay. |
| Races and rollback | Separate SQLite connections concurrently process the same confirmation; exactly one succeeds. Forced transactional failure must leave check-in, consumption, audit and outbox unchanged. |
| Dates and restart | Legacy UTC timestamps, host-timezone/DST utility checks, exact release boundary, persistent uniqueness and per-local-date send ledger across restart/clock changes. Production scheduling and presentation use Johannesburg. |
| SMTP outage and ambiguity | `tests/email-worker.test.js`: persisted attempts/backoff, dead letter, unchanged check-in, sanitized provider errors and uncertain status after provider acceptance followed by database failure. |
| IMAP outage/recovery | Adapter/worker tests: read-only bounded retrieval, UIDVALIDITY/UID checkpoints, monotonic resume, degraded/recovered health and rejection of expired late mail. |
| Access compatibility | `tests/beneficiary-notifications.test.js`: actual transitions queue atomically; repeated no-ops do not duplicate notices; emergency waits, denial, revoke and triggered-switch regrant rules are preserved. Accepted email leaves emergency requests and prior grants unchanged. |
| Privacy and UI | Template whitelist/escaping, no attachments/external images, sanitized logs and digest-only SQLite state. The Firefox test confirms one-time verification, immediate enablement, no second-code workflow, protected settings and cleared password inputs. |
| Migration/restore | `tests/email-migration.test.js`: additive upgrade preserves prior application columns and verified recipients; legacy challenges/batches are revoked without reinterpretation. `tests/email-restore-safety.test.js`: stopped-copy quarantine, idempotency, malformed-schema refusal and preservation of access/vault/history. |
| Real provider | A fresh protocol-2 reminder, owner-sent confirmation, database transition and mailbox acknowledgement passed the real-provider exercise below. The 17 earlier preview deliveries remain separate historical evidence. |
| Threat model | [Threat model](email-threat-model.md) records the mailbox authorization model, scanner behavior, parser boundaries, replay/race controls and restore handling. |

Synthetic tests use disposable databases and fake transports rather than the installed application's vault. The manual preview command does not open that vault or start application workers.

An earlier live-server JSON parsing failure came from `/api/notifications` returning the HTML application page. `tests/api-client.test.js` covers readable errors for HTML/malformed responses without exposing their contents; the copied-server tests cover JSON 404s for unknown API routes. The revised notification UI removes the previous code-setup shortcut and uses normal Settings enrollment. No production restart or deployment is recorded by these checks.

## Historical iCloud template delivery

This campaign used the earlier template revision, before the workflow was simplified. It proves delivery of those earlier messages. The revised reminder’s real acceptance is documented separately below. It was explicitly requested by the owner. SMTP: `smtp.mail.me.com:587`, mandatory STARTTLS/certificate verification and app-specific-password authentication. IMAP: `imap.mail.me.com:993`, certificate-verified implicit TLS and read-only mailbox selection. These settings follow [Apple's mail-server instructions](https://support.apple.com/en-ie/102525). The private recipient and credentials stay out of this report and Git.

Campaign `58fad858-d95a-4083-be18-21bfc5aae151`:

- Started **09:30:04 SAST**, finished SMTP submissions **09:31:14 SAST**.
- **17/17** messages accepted by SMTP (`sent_to_server`).
- **17/17** exact Message-IDs independently observed in the recipient inbox using read-only IMAP at **09:32:02 SAST**.
- Inspected one delivered preview's headers: expected sender and Reply-To present. This mailbox response did **not** include `Authentication-Results`; no SPF/DKIM/DMARC pass is claimed from missing evidence. Apple manages DNS/signing for the `me.com` sender domain. Trusted authserv identifiers remain unconfigured until their trust boundary is verified.
- A direct DNS check on 28 October confirmed the sender domain publishes SPF (`v=spf1 redirect=_spf.icloud.com`) and a DMARC quarantine policy for the domain and subdomains. Published policy is separate from authentication of a particular delivered message; the missing result header still prevents claiming a per-message pass.
- Preview set: reminders for 5, 4, 3, 2 and 1 days; accepted/rejected check-in; address verification; emergency request and denial; manual grant and revoke; automatic emergency grant; switch release; configuration test; degraded and recovered transport health.
- Every subject is marked `[PREVIEW]`, with a prominent fictional-data notice. Example values in that historical revision were inactive; no usable recovery-code batch was emailed. No production check-in, permission or deadline changed.

Reproduce intentionally with `node scripts/email-template-previews.js --to owner@example.com`. This sends 17 messages; it is never run by `npm test` or the background worker. Sanitized per-message evidence is stored only in ignored `data/email-template-previews-<campaign>.json`, with mode 0600. Do not rerun merely because observation timed out: inspect the process and evidence first to avoid duplicate preview mail.

## Completed simplified real-provider acceptance

The simplified round trip **passed on 28 October 2026** against the disposable test vault. The test owner's existing login and verified address were preserved. The owner sent the confirmation from the already verified mailbox, and the application accepted it at **09:24:10.755 UTC / 11:24:10 SAST**. No repeated enrollment or additional code was required.

The disposable instance was upgraded on 28 October while preserving the test owner's login, verified address and every existing beneficiary row. The prior run was archived; its unused legacy confirmations and offline codes were revoked. A fresh protocol-2 reminder was accepted by SMTP at **09:05:43.136 UTC / 11:05:43 SAST**, then its exact Message-ID was independently observed in the inbox at **09:06:03.394 UTC / 11:06:03 SAST**. SMTP and IMAP health were ready. This was the first delivery observation for the revised reminder; the completed replacement run is recorded below. No production database or service was changed.

Targeted read-only inspection subsequently identified two confirmations rejected because the mail app sent from a different, unverified account. Both contained the valid prepared confirmation and subject; exact verified-sender matching correctly refused them. A later reply used the verified address, but a signed-in check-in at **09:14:18.985 UTC / 11:14:18 SAST** had already superseded the reminder and revoked its confirmation. These replies did not reset the timer or change access. The superseded disposable run was archived and a replacement synthetic acceptance reminder was submitted at **09:17:43.481 UTC / 11:17:43 SAST**, preserving enrollment and all prior beneficiary rows. An outgoing message at approximately **11:20 SAST** was addressed to the owner mailbox rather than the configured reply mailbox and did not reach the inbound verifier. Sending the confirmation to the expected reply mailbox produced the successful result below. These earlier routing and validation failures did not cause an unintended check-in; no repeat email verification or offline codes were needed.

The isolated harness is started explicitly with `node scripts/email-acceptance-server.js --allow-real-email` and serves `http://127.0.0.1:4445/`. It uses a private temporary application/database with synthetic beneficiaries, establishes the mailbox checkpoint through read-only IMAP, marks notices **[ACCEPTANCE TEST]**, and expires within two hours. The direct **Send test reminder** form is protected by the test owner's vault password; routine email confirmation is not. See [operations](email-operations.md) for the complete procedure and isolation boundaries.

`node scripts/email-acceptance-evidence.js --check-mailbox` verifies a read-only snapshot of the disposable database and independently observes the reminder and acknowledgement's exact Message-IDs through read-only IMAP. Required evidence includes one consumed protocol-2 confirmation linked to an accepted receipt, the matching `last_check_in`, a new configured cycle with future reminders, stopped old work, preserved synthetic emergency request and prior grant, and matching audit/acknowledgement data. It sends no mail and cannot complete enrollment or create a check-in. A database-only pass or pending report does not prove mailbox receipt.

The passing point-in-time read-only evidence collection began at **2026-10-28T09:24:53.280Z** and independently observed both exact reminder and acknowledgement Message-IDs in the mailbox at **2026-10-28T09:24:59.878Z / 11:24:59 SAST**. Its result was `outcome: "verified"`, `database_verified: true` and `round_trip_verified: true`, with **all 22 named invariants true**.

| State captured by the passing report | Observed result |
| --- | --- |
| Accepted inbound replies | `1` |
| Consumed protocol-2 confirmations / used challenges | `1` / `1` |
| Accepted timestamp and persisted `last_check_in` | Both `2026-10-28T09:24:10.755Z` |
| New routine due date | `2026-11-27T09:24:10.755Z` |
| New final release deadline | `2026-12-04T09:24:10.755Z` |
| Old cycle | Superseded; remaining work invalidated |
| New cycle | Configured 30+7-day cycle with five future reminders |
| Beneficiary state | Synthetic independent emergency request and prior grant preserved |
| Mailbox receipt | Reminder and acknowledgement exact Message-IDs both observed through read-only IMAP |

At **2026-10-28T09:25:15.944Z / 11:25:15 SAST**, after that successful snapshot, the owner initiated another notification-address verification (`notification_verification_requested`). This subsequent settings action cleared live recipient verification and cancelled future reminder work. Later checks of the mutable test database consequently no longer satisfy the verified-enrollment and five-future-reminder invariants. The accepted confirmation, `last_check_in` and new due/release timestamps remained unchanged. The passing report records the earlier completed round trip; it does not claim that later owner settings remained unchanged. No owner action was rolled back.

The owner completed verification of the replacement recipient at **2026-10-28T09:26:30.581Z / 11:26:30 SAST**. At the owner's explicit request to retest, the completed run was archived and a new isolated synthetic acceptance cycle was queued at **2026-10-28T09:29:18.579Z / 11:29:18 SAST**. Login, replacement-address verification and every prior beneficiary row were preserved. The new reminder was submitted at **09:29:44.484 UTC / 11:29:44 SAST** and independently observed by exact Message-ID at **09:30:30.736 UTC / 11:30:30 SAST**. The first passing report is retained privately with a note about the later settings change.

**The replacement-recipient retest also passed.** Its confirmation was accepted once at **2026-10-28T09:31:18.858Z / 11:31:18 SAST**, matching the persisted `last_check_in`. The next routine due date is **2026-11-27T09:31:18.858Z** and final release is **2026-12-04T09:31:18.858Z**. A second passing report, collected at **09:32:42.186 UTC**, observed the reminder and acknowledgement's exact Message-IDs at **09:32:48.743 UTC / 11:32:48 SAST**. It again passed all **22 invariants**, with exactly one accepted reply and one consumed protocol-2 confirmation, five future reminders, stopped old work and preserved synthetic beneficiary permissions. This report was saved directly by the read-only collector in ignored private evidence with mode 0600. No additional verification was required for the reminder response itself, and no production state changed.

**Real protocol-2 confirmation acceptance is complete.** The historical 17-message preview campaign remains separate evidence. No production database or service was changed by these acceptance exercises. The subsequent owner-authorized production deployment is recorded below. Review [operations](email-operations.md) for systemd, key rotation, backup, restore quarantine and rollback steps.

## Production deployment

The owner explicitly requested saving to Git and deploying to the server after the two successful real-provider runs. The implementation and acceptance evidence were pushed, and application source revision **`1cfee81`** was deployed on **28 October 2026 at 09:43:07 UTC / 11:43:07 SAST** through the existing **`wolfs-legacy.service`**, on port **4444**. Independent read-only review found no code blocker; the existing regression suite, both real-provider runs, dependency checks and generated-systemd-unit validation had passed.

Before migration, the sole production writer was frozen while a consistent private rollback snapshot copied the complete data directory including SQLite WAL/SHM, vault secrets, protected environment, managed documents, effective service unit and source revision. Snapshot integrity and original-column digests were verified. This is a same-host rollback snapshot, not an independent disaster-recovery backup. The writer was resumed after the additive migration and configuration update. Root-managed unit restart required interactive authentication; the service owner's existing Node process was deliberately terminated with uncaught `SIGUSR2`, without a core dump, and the existing `Restart=on-failure` supervisor performed one controlled restart. The root-managed unit was not rewritten.

Deployment verification confirmed:

- The service is active, `/health` returns healthy JSON, the protected notification route returns JSON 401, and an unknown API route returns JSON 404.
- Critical original columns in users, switch configuration, beneficiaries, vault entries, managed documents and associations match the snapshot digests. Database integrity passed; persisted encryption and JWT secrets are unchanged.
- No disposable account, beneficiary or acceptance table was copied into production. Both passing acceptance reports remain private, and the temporary test server was stopped afterward.
- Configured certificate-verified SMTP and IMAP authentication passed. `NOTIFICATIONS_ENABLED=true`; the production IMAP worker reported `ready` at **09:43:42 UTC / 11:43:42 SAST**.
- The fresh production mailbox checkpoint was initialized from the current read-only IMAP UID state only after confirming there was no production mail enrollment, challenge or outbox. Historical personal messages and disposable-test mail were not replayed during deployment.
- The real vault's existing Dead Man's Switch remains **paused** and its check-in timestamp is unchanged. Its notification address has not yet been enrolled; the authenticated owner performs the one-time verification in the real vault's Settings. Test-account verification was not transferred.

Ignored private deployment metadata records the source revision, service/process identifiers, snapshot location and preservation checks. Credentials and actual recipient details remain outside Git. Later documentation-only commits record this deployment without changing the running application code. No PR merge was performed.
