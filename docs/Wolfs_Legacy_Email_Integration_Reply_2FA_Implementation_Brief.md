# Wolf's Legacy — Complete Email Integration, Five-Day Reminders and Simple Email Check-In

**Status:** Updated to the owner's 28 October 2026 instruction: verify the notification email once, then confirm reminders with one **Confirm I’m here** button and send the prepared reply. Offline codes and reply 2FA are removed. This instruction supersedes the original two-code protocol. See [test evidence](email-test-report.md), [baseline audit](email-baseline-audit.md), [threat model](email-threat-model.md) and [operations](email-operations.md).
**Repository:** `Owewolf/wolfs-legacy`\
**Starting branch:** current approved development head\
**Suggested new branch:** `feature/email-notifications-reply-2fa`\
**Deployment:** Fedora / Ultramarine, Node.js, systemd (`wolfs-legacy.service`), port `4444`\
**Database:** SQLite\
**Timezone for scheduling and email presentation:** `Africa/Johannesburg`\
**Scope:** Backend notification services, simple verified-email confirmation, secure email transport, durable event processing, email template content, logging, tests and deployment documentation.

## 1. Objective and non-negotiable schedule

Build a complete, reliable two-way email system for Wolf's Legacy. The owner receives automated notifications for beneficiary access events and Dead Man's Switch events, and can confirm continued activity **by selecting Confirm I’m here in the reminder and sending the prepared email**. A successful authenticated reply resets the check-in clock; it does **not** disable the Dead Man's Switch, and it does **not** cancel independent beneficiary emergency requests.

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
- Configure SPF/DKIM/DMARC for the outgoing domain and review inbound email authentication results where available. Sender headers alone are insufficient; the owner-bound single-use email confirmation is required.
- Mail transport failure must never silently be treated as an accepted check-in. Do not emit raw secrets, raw MIME email, tokens or personally sensitive content to logs.
- SMTP and IMAP credentials are **not** `HOMEBANK_OWNER_EMAIL`; HomeBank's owner email is a separate feature-specific setting.

## 4. Simple verified-email confirmation (owner-approved workflow)

The owner rejected the two-code workflow as too complicated. The chosen workflow is:

1. While signed in, verify the owner's notification email **once**. Verification automatically enables email check-ins. Changing the recipient requires verification of the new address; routine reminders do not require another verification or vault sign-in.
2. Each reminder has one prominent **Confirm I’m here** button. It opens the owner's email app with the destination, subject and confirmation text already filled in.
3. The owner presses **Send**. No offline code, second factor, code copying or code typing is required. Opening the reminder or scanning its button is not a check-in; receiving and validating the sent confirmation is.

The button uses a `mailto:` action, not an HTTP link that changes state. Its prepared message has the subject `Wolf's Legacy check-in confirmation` and contains one opaque, high-entropy single-use email confirmation. The owner does not manage this token. Plain-text email includes the same prepared-mail action.

### Validation and state transition

- Bind each confirmation to the verified owner, immutable current cycle, purpose and reminder. Store only its digest and nonsecret derivation ID; never plaintext in SQLite.
- Require the verified originating address, expected reply mailbox, unique incoming message identity and a valid unused protocol-2 confirmation. Do not accept `CONFIRM` alone, an automatic/vacation reply, a forwarded message or quoted confirmation text.
- Normal direct replies must match the reminder's thread. A button-prepared new message may omit thread headers only when its exact fixed subject, verified sender, reply mailbox and bound confirmation all match. Review trustworthy receiver authentication results when available.
- Accept bounded plain-text or safely converted HTML-only responses; ignore signatures and quoted content. Multiple conflicting confirmation lines fail closed. Never execute HTML or attachments.
- Confirmation expires within 24 hours and never after final release. A newer reminder supersedes an older reminder's button. Reject a disabled, superseded, expired or released cycle. A late reply never reverses a release.
- In one SQLite transaction, consume the confirmation once, set `last_check_in` to verification time in UTC, create the next configured cycle, cancel old reminder jobs/challenges, append audit and queue acknowledgement. Enforce database uniqueness and race protection.
- A successful email changes only the check-in cycle. It leaves the switch enabled, grants no vault access, revokes no existing grant, and does not cancel or delay an independent beneficiary emergency request.
- A failure changes no deadline or permission. Persist a sanitized outcome, rate-limit attempts and controlled owner warnings, and disclose no sensitive token information.

This is email-based check-in, **not two-factor authentication**. The owner's mailbox is the authorization factor for resetting this timer. No HTTP GET, mailbox display, button prefetch or delivery status may reset it.

### Upgrade

Preserve existing verified addresses and owner settings. Add a confirmation protocol marker; revoke outstanding legacy two-code challenges and unused legacy offline-code batches without deleting their history. Never reinterpret an older two-code challenge as a new simple confirmation. Stop exposing code-batch provisioning and remove its UI. Preserve encrypted vault entries, source snapshots, document mappings and beneficiary tokens.

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
- `checkin_recovery_codes` — retained only for historical compatibility; unused legacy rows are revoked and no new batches are issued.
- `inbound_message_log` — provider UID/message-id fingerprint, processing outcome and deduplication information.

Do not put plaintext email confirmations or SMTP passwords in SQLite backups. Treat backup restoration as sensitive; avoid accidentally re-sending historical notifications after restore. Existing encrypted vault entries, HomeBank snapshots, document mappings and beneficiary token hashes must not be modified.

Use an idempotent scheduler with **database uniqueness constraints**, not merely in-memory timers. Schedule by immutable `cycle_id`, final UTC expiry time, and ordinal reminder number `1..5`. Use a persistent job/worker under the existing Node.js/systemd process or a separate supervised systemd worker. After a restart, reconcile future jobs and resume failed outgoing messages without double-sending a logical event. A clock/timezone change must not manufacture extra reminders. Ensure the first five-day schedule is recalculated transactionally after every valid check-in or settings change.

## 7. Email templates — exact content and presentation

Templates must be responsive, legible on phones and desktops, have an accessible plain-text version, and use subdued Wolf's Legacy branding: a simple dark-blue/teal header, white or dark-mode-friendly content area, prominent deadline information, readable monospace code examples, and a small security footer. No tracker pixels or external images. Escape all interpolated values. Avoid beneficiary tokens, account balances and document contents in email.

### Template A — Daily reminder (days 5 through 1)

**Subject:** `Wolf's Legacy — Check-in required: {days_remaining} day(s) before access release`

**From:** `Wolf's Legacy <{smtp_from}>`
**Reply-To:** `{dedicated_reply_mailbox}`

The reminder prominently shows the final South Africa release deadline, days remaining, reminder number of five and the consequences of no check-in. Its sole primary action is **Confirm I’m here**, opening a prepared confirmation email. State **Send the prepared email to confirm. No code entry or vault sign-in is needed.** Include the expiry time, newest-reminder supersession policy and a concise automated-security footer. The plain-text variant includes an equivalent mailto action. No offline-code placeholder or manual CONFIRM instructions are shown.

### Template B — Successful reply acknowledgement

**Subject:** `Wolf's Legacy — Check-in confirmed`

> **Your check-in was accepted.**
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
> Use Confirm I’m here in the newest reminder and send the prepared email from your verified address. You can also sign in to complete a check-in.
>
> The deadline remains unchanged until a valid confirmation is received.

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
2. **Reply success:** A valid button-prepared confirmation from the verified owner yields exactly one check-in and a new 30+7-day cycle; reminders for old cycle stop immediately.
3. **Confirmation isolation:** `CONFIRM` alone, forged sender, forwarded/quoted/automatic email, expired or reused confirmation, wrong owner or wrong cycle **never** reset the timer.
4. **Race protection:** Concurrent/repeated email processing cannot consume a confirmation twice or grant multiple check-ins.
5. **Date boundary:** Correct local date/time and DST-safe UTC persistence; no early release; server restarts do not duplicate reminders.
6. **SMTP failure:** Retries and permanent failures are logged, visible in operational records and never treated as successful check-ins.
7. **IMAP failure:** Incoming mailbox outage does not manufacture confirmations; watchdog reports degraded state. Recovery processes late messages only if still valid by policy.
8. **Access-state compatibility:** Beneficiary emergency requests, grants and revocations continue with existing rules; Dead Man's Switch reply **never** cancels a separate emergency request.
9. **Already released:** A late reply cannot silently revoke released beneficiary access; any manual action remains separate.
10. **Content privacy:** No access token, email credential, account details, uploaded files or plaintext legacy offline code appears in outgoing notification content or routine logs.
11. **Migration and backup:** Existing SQLite data and beneficiary tokens remain intact; schema upgrade and rollback/documented restore tested.
12. **End-to-end:** Send a real test message, receive a real reply through the configured inbound provider, process a valid simple email check-in, verify timestamps, and inspect mailbox and audit logs.
13. **Security:** Threat-model mailbox compromise, confirmation theft, sender spoofing, webhook replay, malicious MIME attachments, log injection and email flood.

## 10. Handoff and sequencing

1. Finish and commit the developer's present work.
2. Branch from the approved head to `feature/email-notifications-reply-2fa`.
3. Produce audit and threat-model reports first.
4. Implement schema migration, event outbox, transport adapters, prepared-reply button and verified-email check-in.
5. Implement exact five-day scheduler and templates; add comprehensive tests.
6. Document setup, SMTP/IMAP provider configuration, one-time owner email verification, key rotation, backups, recovery and safe rollback.
7. Provide a pull request with a test report, deployment notes and evidence of a real end-to-end email reply.

**Definition of done:** Wolf's Legacy sends exactly one reminder per day on the five days before final expiry, supports one-time owner email verification and the Confirm I’m here prepared-reply workflow, resets the next cycle only on successful verification, and sends/logs key beneficiary and release notifications reliably. No code is to be merged or deployed before review and acceptance testing.
