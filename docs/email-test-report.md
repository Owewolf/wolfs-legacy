# Email implementation evidence and acceptance gate

Date: 28 October 2026 (Africa/Johannesburg). Branch: `feature/email-notifications-reply-2fa`, based on `dc93941`. This report distinguishes automated behavior, observed provider delivery and the remaining real two-factor reply exercise.

## Automated evidence

`npm test` passed: **118 Node tests, 4 Python tests, zero failures/skips**. This includes a real headless Firefox run against the application's actual `index.html` and settings route. `tests/email-ui.test.js` documents the 16 browser behavior checks and explicitly skips only on machines without Firefox; this run did not skip it.

| Brief acceptance item | Evidence |
| --- | --- |
| Five reminders against final expiry | `tests/email-service.test.js`, `tests/email-worker.test.js`: 30+7 releases day 37; actual fake-transport worker sends once on each day 32–36, never day 31 or on a missed historical date. |
| Two-factor reply and new cycle | Real MIME parsing plus database inspection in `tests/email-service.test.js`: both hashes consumed, exactly one check-in, old jobs/challenges cancelled, new 30+7 cycle and acknowledgement. |
| Factor isolation | Missing factors, forged sender, wrong mailbox/thread, forward/automatic mail, conflicting lines, expired/revoked/disabled/released/wrong-owner/cycle and reused offline codes reject without changing check-in. |
| Races | Two worker threads using separate SQLite connections concurrently submit replies; exactly one succeeds and consumes the code. Forced outbox failure rolls back all check-in/consumption/audit work. |
| Dates and restart | Explicit UTC parsing of legacy timestamps, host-timezone and DST utility checks; release boundary test; persistent uniqueness and one-send-per-local-date ledger across restart/clock changes. Production schedule/presentation is Johannesburg only. |
| SMTP outage and ambiguous acceptance | `tests/email-worker.test.js`: persisted attempts/backoff, five-attempt dead letter, no check-in changes, safe provider error codes; SMTP success followed by SQLite failure becomes uncertain and never auto resends. |
| IMAP outage/recovery | Adapter and worker tests: EXAMINE/read-only bounded message fetches, persistent UIDVALIDITY/UID checkpoint, monotonic resume, degraded/recovered health, expired late reply rejection. |
| Access compatibility | `tests/beneficiary-notifications.test.js`: all actual transitions queue atomically; no-op repeats do not duplicate events; emergency wait, denial, revoke and triggered-switch regrant rules preserved. |
| Already released | Email cannot reset released/expired cycles or alter beneficiary grants; normal signed-in policy remains available separately. |
| Privacy | Template payload whitelist/escaping, no attachments/external images, no raw errors/MIME/passwords in routine logs; SQLite dumps contain only code hashes and nonsecret derivation nonces. API exposes codes once with no-store; UI clears secret material on Done/navigation. |
| Migration/restore | `tests/email-migration.test.js` executes actual schema upgrade over synthetic prior data and compares all preexisting column values by hash. `tests/email-restore-safety.test.js` verifies stopped-copy quarantine, idempotency, malformed-schema refusal and preservation of existing access/vault/history. Rollback procedure is in operations guide. |
| Real provider | SMTP and IMAP transport plus all 17 preview deliveries verified below. Full real recipient enrollment/two-code reply/acknowledgement remains pending user interaction. |
| Threat model | [Threat model](email-threat-model.md), with adapter/service/worker tests for spoofing, replay, independent-code theft, MIME, flooding, failure logging and concurrency. |

The synthetic tests never open the installed application's vault. The manual template preview command also never opens that database or starts workers.

## Real iCloud template delivery

Explicitly requested by the owner. SMTP: `smtp.mail.me.com:587`, mandatory STARTTLS/certificate verification and app-specific-password authentication. IMAP: `imap.mail.me.com:993`, certificate-verified implicit TLS and read-only mailbox selection. These settings follow [Apple's mail-server instructions](https://support.apple.com/en-ie/102525). The private recipient and credentials stay out of this report and Git.

Campaign `58fad858-d95a-4083-be18-21bfc5aae151`:

- Started **09:30:04 SAST**, finished SMTP submissions **09:31:14 SAST**.
- **17/17** messages accepted by SMTP (`sent_to_server`).
- **17/17** exact Message-IDs independently observed in the recipient inbox using read-only IMAP at **09:32:02 SAST**.
- Inspected one delivered preview's headers: expected sender and Reply-To present. This mailbox response did **not** include `Authentication-Results`; no SPF/DKIM/DMARC pass is claimed from missing evidence. Apple manages DNS/signing for the `me.com` sender domain. Trusted authserv identifiers remain unconfigured until their trust boundary is verified.
- A direct DNS check on 28 October confirmed the sender domain publishes SPF (`v=spf1 redirect=_spf.icloud.com`) and a DMARC quarantine policy for the domain and subdomains. Published policy is separate from authentication of a particular delivered message; the missing result header still prevents claiming a per-message pass.
- Preview set: reminders for 5, 4, 3, 2 and 1 days; accepted/rejected check-in; address verification; emergency request and denial; manual grant and revoke; automatic emergency grant; switch release; configuration test; degraded and recovered transport health.
- Every subject is marked `[PREVIEW]`, with a prominent fictional-data notice. Example codes are inactive and no offline single-use code is emailed. No production check-in, permission or deadline changed.

Reproduce intentionally with `node scripts/email-template-previews.js --to owner@example.com`. This sends 17 messages; it is never run by `npm test` or the background worker. Sanitized per-message evidence is stored only in ignored `data/email-template-previews-<campaign>.json`, with mode 0600. Do not rerun merely because observation timed out: inspect the process and evidence first to avoid duplicate preview mail.

## Remaining acceptance and review

The full real recipient verification, independently saved offline batch, reminder reply containing both actual factors, resulting database timestamps/cycle cancellation and delivered acknowledgement must still be observed. Preview delivery alone does not prove that gate. The isolated local acceptance harness is available with `node scripts/email-acceptance-server.js --allow-real-email`, at `http://127.0.0.1:4445/#register`. It runs the copied actual application against a fresh private database, seeds an IMAP checkpoint read-only before enrollment, marks messages `[ACCEPTANCE TEST]`, and stops after two hours. Its two tests verify isolation, authentication, one-run scheduling, synthetic beneficiary fixtures and the read-only mailbox preflight. See the operations guide for enrollment and reply instructions. Production mail remains globally disabled in `.env` during review.

`node scripts/email-acceptance-evidence.js --check-mailbox` verifies 22 named invariants using a read-only snapshot of the disposable database, followed by exact reminder/acknowledgement Message-ID observations in the read-only mailbox. It checks actual single-use consumption, receipt/deadline/challenge bounds, the new 30+7 cycle and queued future reminders, stopped old jobs, preserved emergency requests/grants, and matching audit/acknowledgement data. Five tests cover a real service-produced synthetic transition, tampered/missing state, queued acknowledgement, exact header matching, safe output and production-path rejection. The live run currently reports `pending`, with zero acceptance runs; neither unit tests nor previews are presented as a completed real reply exercise. No message is sent by the verifier.

No merge or production deployment is authorized before review and acceptance testing. See [operations](email-operations.md) for systemd, key rotation, backup, restore quarantine and rollback steps.
