# Wolf's Legacy — Complete Email Integration, Five-Day Reminders and Verified Reply Check-In

**Status:** Implemented on `feature/email-notifications-reply-2fa`; automated tests and real template delivery passed. Full real two-factor reply acceptance and review remain open. See [test evidence](email-test-report.md), [baseline audit](email-baseline-audit.md), [threat model](email-threat-model.md) and [operations](email-operations.md).\
**Repository:** `Owewolf/wolfs-legacy`\
**Starting branch:** current approved development head\
**Suggested new branch:** `feature/email-notifications-reply-2fa`\
**Deployment:** Fedora / Ultramarine, Node.js, systemd (`wolfs-legacy.service`), port `4444`\
**Database:** SQLite\
**Timezone for scheduling and email presentation:** `Africa/Johannesburg`\
**Scope:** Backend notification services, two-factor reply confirmation, secure email transport, durable event processing, email template content, logging, tests and deployment documentation.

## 1. Objective and non-negotiable schedule

Build a complete, reliable two-way email system for Wolf's Legacy. The owner receives automated notifications for beneficiary access events and Dead Man's Switch events, and can confirm continued activity **by replying to an email with two separate codes**. A successful authenticated reply resets the check-in clock; it does **not** disable the Dead Man's Switch, and it does **not** cancel independent beneficiary emergency requests.

**Exactly ONE scheduled check-in reminder per day for FIVE consecutive days immediately before the final Dead Man's Switch expiry/release deadline:** `T-5 days`, `T-4`, `T-3`, `T-2`, `T-1`. No additional recurring daily reminders for that cycle. Event-driven confirmations, security warnings and release notices are separate from the five reminder emails.

**Definition of expiry:** `expiry_at = last_successful_checkin_at + check_in_interval_days + grace_period_days`. Use the actual final release deadline, **not** merely the earlier routine check-in due date. Example: with a 30-day interval and 7-day grace period, the last release opportunity is day 37; reminders are on days 32, 33, 34, 35 and 36. Send at the same scheduled local clock time as the final expiry (or at an explicitly configured daily reminder time, consistently for all five dates). Never release before the deadline; the existing hourly polling may process the release shortly afterward.

Each reminder must report the exact final deadline, days remaining, and what happens if no valid check-in is received. An accepted confirmation stops any remaining reminders in the current cycle immediately and generates a **new** 30+7-day cycle (or the owner's actual configured intervals).

If a cycle is configured or re-enabled with fewer than five days remaining, send only the upcoming reminder dates within its remaining window; do not backfill or send multiple reminders in one day.

## 2. Read-only audit of current behaviour — before coding

Audit the **actual** current Wolf's Legacy branch, not only the upstream `slavhate/legacy-vault` implementation. In the upstream baseline examined, the relevant components are:

- `server/routes/beneficiaries.js`: add/remove beneficiary, grant/revoke, emergency-access request and token-based access; automatic emergency granting may occur when the beneficiary requests access again.
- `server/routes/deadswitch.js`: configuration, check-in, due and grace deadline calculations.
- `server/index.js`: Dead Man's Switch periodic release checker (baseline hourly) and beneficiary access grants.
- `server/db.js`: users, beneficiaries, Dead Man's Switch settings, existing audit log.
- Authentication and encryption helpers and existing HomeBank/document extensions.

Record every transition that can grant, revoke or delay access. Verify idempotency and restart behaviour. Verify there are no existing mail workers, SMTP integrations, notification tables or altered deadline semantics that would conflict with this feature. Produce an audit report and preserve existing business rules except changes explicitly required by this specification.

## 3. Email transport architecture

- **Outbound:** SMTP client (e.g. Nodemailer), authenticated, TLS enforced, proper timeouts and safe redaction of credentials. Production sender and reply-to addresses configured through environment variables or another server-side secret store.
- **Inbound:** a dedicated reply mailbox using IMAP with read-only message retrieval plus explicit processed-message tracking, or an authenticated provider inbound webhook. Inbound service must survive restarts, identify messages by provider message UID/message ID, and reject malformed/replayed messages.
- Verify the configured owner notification address before enabling the new reply-based mechanism. Do not infer authorization solely from `From:` or `Reply-To:` headers, and do not trust forwarding or display names.
- Configure SPF/DKIM/DMARC for the outgoing domain and review inbound email authentication results where available. Sender authentication is defense in depth, **not** the second factor.
- Mail transport failure must never silently be treated as an accepted check-in. Do not emit raw secrets, raw MIME email, tokens or personally sensitive content to logs.
- SMTP and IMAP credentials are **not** `HOMEBANK_OWNER_EMAIL`; HomeBank's owner email is a separate feature-specific setting.

## 4. Two-factor reply protocol (chosen workflow)

**Reply with code is the selected primary workflow.** Do not substitute a browser-only confirmation flow.

### Factors

1. **Email factor:** the owner receives a fresh, cryptographically random **challenge code** in each reminder email, tied to that owner, current Dead Man's Switch cycle and an expiration window.
2. **Independent factor:** the owner possesses a separate **single-use recovery/check-in code** issued *in advance*, in a batch, and retained outside the email account (for example, printed and stored securely, or in a separate authenticator/password vault). **Do not send this second code in the reminder email or to the same inbox.**

The second code must be long, random, single-use and suitable for typed email replies. Hash or HMAC it at rest, mark it consumed atomically, and offer authenticated regeneration/rotation of the code batch through a protected owner-only operation. The offline batch is a distinct factor only if it is stored independently of the email account.

A short-lived TOTP code should **not** be accepted in an asynchronous email reply: delivery time can exceed a standard TOTP window. If authenticator-based TOTP is added later, verify it in a synchronous authenticated flow; the reply workflow must continue to use independent single-use codes.

### Email reply format

```text
CONFIRM <EMAIL-CHALLENGE> <OFFLINE-SINGLE-USE-CODE>
```

Illustrative **fake** response, never a valid credential:

```text
CONFIRM WL-7K9P-4Q2R-Z6TM RC-8FQ2-V9KB-7L5D
```

Require both codes in **one unambiguous line** of the reply. Normalize harmless whitespace and letter case consistently; ignore quoted text and signatures when parsing, but reject multiple conflicting confirmation lines. A forwarded reminder, automatic vacation reply, or reply containing only `CONFIRM` must never reset the timer.

### Validation and state transition

1. Identify the intended owner and pending cycle using a server-side challenge record; require an expected originating address and corroborating mail metadata, without treating email address as sufficient authorization.
2. Verify challenge purpose, token hash/HMAC using constant-time comparison where feasible, owner, cycle, expiry, one-time-use status, and challenge revocation/supersession rules.
3. Verify the independent code from that same owner's unused batch; consume it **only together with the successful check-in update**, in a single SQLite transaction.
4. Lock check-in acceptance if the release has already happened, if the Dead Man's Switch is disabled, or if the relevant cycle was superseded. A late email **must not** automatically undo access already granted.
5. On success: set `last_check_in` to successful receipt/verification time (using an unambiguous UTC server timestamp); clear overdue state only according to existing rules; generate a new cycle; invalidate outstanding reminders/challenges from the previous cycle; cancel future queued reminders for that cycle; append an audit event; queue confirmation email **in the same transaction**.
6. On failure: no change to `last_check_in`, release deadlines, or beneficiary permissions. Record a sanitized failure reason, enforce rate limits, and warn the owner as appropriate without disclosing which code was wrong.

Issue challenge codes per reminder, valid for up to **24 hours**, never beyond the final release deadline. Invalidate superseded challenges if using only the most recent reminder, and document that rule in the template. Protect against brute force, mailbox flooding, replay and concurrent arrivals. Avoid putting either code into URLs, logs, analytics, error reports or Git.

## 5. Notification matrix

| Trigger | Recipient | Timing / behavior |
|---|---|---|
| Dead Man's Switch expiry T-5, T-4, T-3, T-2, T-1 | Verified owner | **Exactly one reminder per day**, while the cycle remains unconfirmed and release is pending |
| Verified reply accepted | Owner | Immediate acknowledgement showing the new due date and release deadline |
| Reply invalid, expired or suspected attack | Owner | Controlled security notification; avoid loops and information leakage |
| Beneficiary emergency access requested | Owner | Immediate queued notification |
| Beneficiary emergency request denied | Owner; beneficiary only where address and policy permit | Event notification; no sensitive token |
| Beneficiary access manually granted or revoked | Owner | Immediate queued notification |
| Emergency waiting period ends and access is granted | Owner | Immediate notification at the actual access-state change |
| Dead Man's Switch triggers and grants access | Owner | High-priority notification; one event per release transition |
| Email delivery/IMAP processing repeatedly fails | Owner through alternate configured channel when available, plus persistent audit status | Clear operational alert; never silently assume check-in success |

**Important separation:** The beneficiary's own emergency-access waiting period is separate from the Dead Man's Switch. A confirmed Dead Man's Switch check-in **must not** cancel an emergency request, revoke already-granted permissions, or alter the beneficiary's independently configured waiting period.

Do not infer email delivery from accepted SMTP submission: `queued`, `sent_to_server`, `delivered` (if independently confirmed), `failed`, `retried`, and `dead_letter` must be distinguishable.

## 6. Durable database model and jobs

Create additive SQLite migrations (no destructive resets) for:

- `notification_settings` — owner ID, verified recipient, SMTP/reply policy, timezone, send clock and configuration status.
- `notification_outbox` — event type, owner, beneficiary when applicable, cycle ID, deterministic idempotency key, schedule time, status, attempt counters, last error and timestamps.
- `notification_attempts` — SMTP/provider result metadata without credentials or full token contents.
- `checkin_challenges` — hashed challenge, owner, cycle ID, issue/expiry/used timestamps, inbound message identity and reminder sequence.
- `checkin_recovery_codes` — independently provisioned, hashed offline single-use codes and consumed timestamp.
- `inbound_message_log` — provider UID/message-id fingerprint, processing outcome and deduplication information.

Do not put plaintext challenges, plaintext offline codes or SMTP passwords in SQLite backups. Treat backup restoration as sensitive; avoid accidentally re-sending historical notifications after restore. Existing encrypted vault entries, HomeBank snapshots, document mappings and beneficiary token hashes must not be modified.

Use an idempotent scheduler with **database uniqueness constraints**, not merely in-memory timers. Schedule by immutable `cycle_id`, final UTC expiry time, and ordinal reminder number `1..5`. Use a persistent job/worker under the existing Node.js/systemd process or a separate supervised systemd worker. After a restart, reconcile future jobs and resume failed outgoing messages without double-sending a logical event. A clock/timezone change must not manufacture extra reminders. Ensure the first five-day schedule is recalculated transactionally after every valid check-in or settings change.

## 7. Email templates — exact content and presentation

Templates must be responsive, legible on phones and desktops, have an accessible plain-text version, and use subdued Wolf's Legacy branding: a simple dark-blue/teal header, white or dark-mode-friendly content area, prominent deadline information, readable monospace code examples, and a small security footer. No tracker pixels or external images. Escape all interpolated values. Avoid beneficiary tokens, account balances and document contents in email.

### Template A — Daily Dead Man's Switch reminder (days 5 through 1)

**Subject:** `Wolf's Legacy — Check-in required: {days_remaining} day(s) before access release`

**From:** `Wolf's Legacy <{smtp_from}>`\
**Reply-To:** `{dedicated_reply_mailbox}`

**Body:**

> **Wolf's Legacy — Confirm you are active**
>
> Your Dead Man's Switch is scheduled to reach its final release deadline on **{release_at_local} (South Africa time)**.
>
> **{days_remaining} day(s) remain.** This is reminder **{reminder_number} of 5**.
>
> To reset your check-in cycle, reply to this email with exactly one line:
>
> `CONFIRM {email_challenge} <YOUR-NEXT-UNUSED-OFFLINE-CODE>`
>
> Find the second code in your separate Wolf's Legacy check-in recovery-code set. It is **not included in this email**.
>
> This email challenge expires in 24 hours or at the release deadline, whichever comes first. Do not forward this message or share either code.
>
> If you have already confirmed your activity, no further action is needed. You can ignore a delayed duplicate message.
>
> Wolf's Legacy — Automated security notification.

The subject can say `1 day` instead of `1 day(s)` through template pluralisation. The email must accurately describe the chosen supersession policy when newer challenges invalidate older ones.

### Template B — Successful reply acknowledgement

**Subject:** `Wolf's Legacy — Check-in confirmed`

> **Your identity check was accepted.**
>
> Confirmed at: **{confirmed_at_local}**\
> Next routine check-in due: **{next_checkin_local}**\
> Next final release deadline: **{next_release_at_local}**
>
> Your Dead Man's Switch remains enabled and a new cycle has started. Any outstanding beneficiary emergency-access requests remain separate.
>
> If you did not send this confirmation, sign in to your vault and investigate immediately.

### Template C — Unsuccessful reply (controlled)

**Subject:** `Wolf's Legacy — Check-in could not be verified`

> We received a check-in attempt, but it could not be verified.
>
> **Your Dead Man's Switch deadline has not changed.**
>
> Check that you used the newest email challenge and an unused offline code. If necessary, sign in to Wolf's Legacy using your normal credentials to complete a check-in or obtain replacement codes.
>
> For security, this email does not identify which code failed.

Limit this template to avoid flood/abuse and prevent reflecting responses to arbitrary forged addresses.

### Template D — Beneficiary emergency-access request

**Subject:** `Wolf's Legacy — Emergency access requested`

> A registered beneficiary, **{beneficiary_name}**, requested emergency access at **{requested_at_local}**.
>
> Waiting period: **{waiting_days} days**\
> Earliest release time under the existing rules: **{eligible_at_local}**
>
> If this request is unexpected, sign in to Wolf's Legacy to review or deny it. Do not reply with access tokens or account credentials.

### Template E — Dead Man's Switch released

**Subject:** `Wolf's Legacy — Automatic beneficiary access activated`

> The configured Dead Man's Switch release deadline passed, and beneficiary access was granted at **{granted_at_local}** under the vault's current policy.
>
> A subsequent email reply does not automatically revoke already-granted access. Review the relevant records securely if you believe this was unexpected.

### Template F — Manual/automatic grant, revocation, denial

Use concise variants with event type, beneficiary name, timestamp and whether access is currently granted. State facts as recorded by the database, never promised email delivery or unverified future events.

### Template G — Test email and transport health

**Subject:** `Wolf's Legacy — Email configuration test`

> This confirms that Wolf's Legacy handed a test message to your configured SMTP provider at **{timestamp_local}**. It does not establish that future delivery is guaranteed.

## 8. Operational configuration — Fedora and systemd

Provide `.env.example` placeholders **without real secrets**, including:

```dotenv
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM=
CHECKIN_REPLY_MAILBOX=
CHECKIN_IMAP_HOST=
CHECKIN_IMAP_PORT=993
CHECKIN_IMAP_USERNAME=
CHECKIN_IMAP_PASSWORD=
NOTIFICATION_TIMEZONE=Africa/Johannesburg
NOTIFICATION_REMINDER_DAYS=5
```

Support STARTTLS verification for port 587 or implicit TLS for port 465. Require a verified owner address for the check-in feature. Protect `.env` and saved recovery-code material using Linux file permissions, never expose services beyond the intended network without TLS and access controls, and ensure log output redacts addresses and credentials where appropriate. Configure and document the `wolfs-legacy.service` environment, working directory and restart behavior; port `4444` remains unchanged.

## 9. Testing and acceptance criteria

1. **Five reminders:** For 30-day interval + 7-day grace, reminders are on days 32–36, one per day and not on day 31 or twice on any reminder day; final release deadline is day 37.
2. **Reply success:** Correct email challenge **plus** unused independently stored offline code yields exactly one check-in and a new 30+7-day cycle; reminders for old cycle stop immediately.
3. **Factor isolation:** Challenge alone, `CONFIRM` alone, forged sender, forwarded email, expired challenge, reused offline code, wrong owner or wrong cycle **never** reset the timer.
4. **Race protection:** Concurrent/repeated email processing cannot consume a code twice or grant multiple check-ins.
5. **Date boundary:** Correct local date/time and DST-safe UTC persistence; no early release; server restarts do not duplicate reminders.
6. **SMTP failure:** Retries and permanent failures are logged, visible in operational records and never treated as successful check-ins.
7. **IMAP failure:** Incoming mailbox outage does not manufacture confirmations; watchdog reports degraded state. Recovery processes late messages only if still valid by policy.
8. **Access-state compatibility:** Beneficiary emergency requests, grants and revocations continue with existing rules; Dead Man's Switch reply **never** cancels a separate emergency request.
9. **Already released:** A late reply cannot silently revoke released beneficiary access; any manual action remains separate.
10. **Content privacy:** No access token, email credential, account details, uploaded files or plaintext offline code appears in outgoing notification content or routine logs.
11. **Migration and backup:** Existing SQLite data and beneficiary tokens remain intact; schema upgrade and rollback/documented restore tested.
12. **End-to-end:** Send a real test message, receive a real reply through the configured inbound provider, process valid two-factor check-in, verify timestamps, and inspect mailbox and audit logs.
13. **Security:** Threat-model mailbox compromise, code theft, sender spoofing, webhook replay, malicious MIME attachments, log injection and email flood.

## 10. Handoff and sequencing

1. Finish and commit the developer's present work.
2. Branch from the approved head to `feature/email-notifications-reply-2fa`.
3. Produce audit and threat-model reports first.
4. Implement schema migration, event outbox, transport adapters, reply parser and verified two-factor check-in.
5. Implement exact five-day scheduler and templates; add comprehensive tests.
6. Document setup, SMTP/IMAP provider configuration, first-time provisioning of independent offline check-in codes, key rotation, backups, recovery and safe rollback.
7. Provide a pull request with a test report, deployment notes and evidence of a real end-to-end email reply.

**Definition of done:** Wolf's Legacy sends exactly one reminder per day on the five days before final expiry, supports verified reply-with-code two-factor check-ins, resets the next cycle only on successful verification, and sends/logs key beneficiary and release notifications reliably. No code is to be merged or deployed before review and acceptance testing.
