# Email implementation evidence and acceptance gate

Date: 28 October 2026 (Africa/Johannesburg). Branch: `feature/email-notifications-reply-2fa`, based on `dc93941`. This report distinguishes automated behavior, observed provider delivery and the remaining real simplified-confirmation exercise. The owner’s 28 October instruction supersedes the original two-code workflow; this report does not treat earlier previews or tests as proof of the revised real-provider round trip.

## Automated evidence

`npm test` passed for the simplified implementation: **134 Node tests and 4 Python tests, zero failures/skips**. This includes the real headless Firefox test against the application's actual `index.html`, settings router and acceptance-test banner, with **26 browser behavior checks**. Those browser checks cover one-time address verification with automatic enablement, the simple button-and-send instructions, removal of extra enrollment, vault-password rejection, escaped data, protected optional preferences and navigation cleanup.

The coverage below identifies the tests and state assertions supporting the automated result. Real provider delivery and the owner-sent confirmation remain a separate acceptance gate.

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
| Real provider | Historical SMTP/IMAP transport and 17 earlier preview deliveries are documented below. A fresh simplified reminder, real sent confirmation and received acknowledgement remain pending. |
| Threat model | [Threat model](email-threat-model.md) records the mailbox authorization model, scanner behavior, parser boundaries, replay/race controls and restore handling. |

Synthetic tests use disposable databases and fake transports rather than the installed application's vault. The manual preview command does not open that vault or start application workers.

An earlier live-server JSON parsing failure came from `/api/notifications` returning the HTML application page. `tests/api-client.test.js` covers readable errors for HTML/malformed responses without exposing their contents; the copied-server tests cover JSON 404s for unknown API routes. The revised notification UI removes the previous code-setup shortcut and uses normal Settings enrollment. No production restart or deployment is recorded by these checks.

## Historical iCloud template delivery

This campaign used the earlier template revision, before the workflow was simplified. It proves those messages were delivered, not that the current reminder has completed real acceptance. It was explicitly requested by the owner. SMTP: `smtp.mail.me.com:587`, mandatory STARTTLS/certificate verification and app-specific-password authentication. IMAP: `imap.mail.me.com:993`, certificate-verified implicit TLS and read-only mailbox selection. These settings follow [Apple's mail-server instructions](https://support.apple.com/en-ie/102525). The private recipient and credentials stay out of this report and Git.

Campaign `58fad858-d95a-4083-be18-21bfc5aae151`:

- Started **09:30:04 SAST**, finished SMTP submissions **09:31:14 SAST**.
- **17/17** messages accepted by SMTP (`sent_to_server`).
- **17/17** exact Message-IDs independently observed in the recipient inbox using read-only IMAP at **09:32:02 SAST**.
- Inspected one delivered preview's headers: expected sender and Reply-To present. This mailbox response did **not** include `Authentication-Results`; no SPF/DKIM/DMARC pass is claimed from missing evidence. Apple manages DNS/signing for the `me.com` sender domain. Trusted authserv identifiers remain unconfigured until their trust boundary is verified.
- A direct DNS check on 28 October confirmed the sender domain publishes SPF (`v=spf1 redirect=_spf.icloud.com`) and a DMARC quarantine policy for the domain and subdomains. Published policy is separate from authentication of a particular delivered message; the missing result header still prevents claiming a per-message pass.
- Preview set: reminders for 5, 4, 3, 2 and 1 days; accepted/rejected check-in; address verification; emergency request and denial; manual grant and revoke; automatic emergency grant; switch release; configuration test; degraded and recovered transport health.
- Every subject is marked `[PREVIEW]`, with a prominent fictional-data notice. Example values in that historical revision were inactive; no usable recovery-code batch was emailed. No production check-in, permission or deadline changed.

Reproduce intentionally with `node scripts/email-template-previews.js --to owner@example.com`. This sends 17 messages; it is never run by `npm test` or the background worker. Sanitized per-message evidence is stored only in ignored `data/email-template-previews-<campaign>.json`, with mode 0600. Do not rerun merely because observation timed out: inspect the process and evidence first to avoid duplicate preview mail.

## Remaining simplified acceptance and review

The real round trip must be repeated with a fresh protocol-2 reminder from the revised implementation. An already verified test-owner address remains verified after upgrade; do not ask the owner to repeat completed enrollment. The owner only opens the newest **[ACCEPTANCE TEST] Check-in required** email, selects **Confirm I’m here**, and sends the prefilled reply. The current disposable account, accepted-reply state and mailbox evidence must be inspected before reporting success. An old two-code reply or previously delivered preview cannot satisfy this new gate.

The disposable instance was upgraded on 28 October while preserving the test owner's login, verified address and every existing beneficiary row. The prior run was archived; its unused legacy confirmations and offline codes were revoked. A fresh protocol-2 reminder was accepted by SMTP at **09:05:43.136 UTC / 11:05:43 SAST**, then its exact Message-ID was independently observed in the inbox at **09:06:03.394 UTC / 11:06:03 SAST**. SMTP and IMAP health were ready. This proves delivery of the revised reminder; acceptance of an owner-sent confirmation and delivery of its acknowledgement remain pending. No production database or service was changed.

Targeted read-only inspection subsequently identified two confirmations rejected because the mail app sent from a different, unverified account. Both contained the valid prepared confirmation and subject; exact verified-sender matching correctly refused them. A later reply used the verified address, but a signed-in check-in at **09:14:18.985 UTC / 11:14:18 SAST** had already superseded the reminder and revoked its confirmation. These replies did not reset the timer or change access. The superseded disposable run was archived and a replacement synthetic acceptance reminder was submitted at **09:17:43.481 UTC / 11:17:43 SAST**, preserving enrollment and all prior beneficiary rows. The owner was instructed to send the new prepared message from the already verified account; no further email verification or offline codes are required.

The isolated harness is started explicitly with `node scripts/email-acceptance-server.js --allow-real-email` and serves `http://127.0.0.1:4445/`. It uses a private temporary application/database with synthetic beneficiaries, establishes the mailbox checkpoint through read-only IMAP, marks notices **[ACCEPTANCE TEST]**, and expires within two hours. The direct **Send test reminder** form is protected by the test owner's vault password; routine email confirmation is not. See [operations](email-operations.md) for the complete procedure and isolation boundaries.

`node scripts/email-acceptance-evidence.js --check-mailbox` verifies a read-only snapshot of the disposable database and independently observes the reminder and acknowledgement's exact Message-IDs through read-only IMAP. Required evidence includes one consumed protocol-2 confirmation linked to an accepted receipt, the matching `last_check_in`, a new configured cycle with future reminders, stopped old work, preserved synthetic emergency request and prior grant, and matching audit/acknowledgement data. It sends no mail and cannot complete enrollment or create a check-in. A database-only pass or pending report does not prove mailbox receipt.

**Current gate: simplified real-provider acceptance pending.** Preserve the actual final report and sanitized UTC timestamps after the revised round trip. The historical 17-message preview delivery is complete; the revised confirmation round trip is not claimed complete. No merge or production deployment is recorded. Review [operations](email-operations.md) for systemd, key rotation, backup, restore quarantine and rollback steps.
