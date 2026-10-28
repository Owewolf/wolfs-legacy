# Wolf's Legacy email operations

This guide covers Fedora/Ultramarine deployment on port **4444** and the two-code reply protocol. Read the [baseline audit](email-baseline-audit.md), [threat model](email-threat-model.md) and [implementation brief](Wolfs_Legacy_Email_Integration_Reply_2FA_Implementation_Brief.md) with the code review. Do not merge or deploy this feature until review and acceptance testing pass. The commands below are an operator runbook, not a record of deployment.

## Configuration and provider setup

Start with `.env.example`; keep `NOTIFICATIONS_ENABLED=false` while preparing the installation or restoring data. The global switch stops email transport, not the existing Dead Man's Switch release policy. It is not a way to postpone access release. The authenticated owner must use the normal check-in control if needed during a transport outage.

Configure these server-only values in the service `.env`:

| Setting | Purpose |
| --- | --- |
| `NOTIFICATIONS_ENABLED` | Global transport kill switch; opt in only after review and provider configuration. |
| `NOTIFICATION_SECRET` | Independent random 32-byte secret encoded as 64 hexadecimal characters. Generate once with `openssl rand -hex 32`; keep in `.env`/a secret store outside SQLite. Do not paste it into tickets, terminal transcripts or Git. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Provider's certificate-valid SMTP hostname; use `587`/`false` for mandatory STARTTLS or `465`/`true` for implicit TLS. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Dedicated authenticated provider credentials, preferably a restricted application password. |
| `SMTP_FROM` | Provider-authorized sender mailbox, using your own domain or an address issued by your provider. |
| `CHECKIN_REPLY_MAILBOX` | Dedicated inbound reply address used as `Reply-To`; do not share it with unrelated automation. |
| `CHECKIN_IMAP_HOST`, `CHECKIN_IMAP_PORT` | Certificate-valid IMAP hostname and implicit-TLS port, normally `993`. |
| `CHECKIN_IMAP_USERNAME`, `CHECKIN_IMAP_PASSWORD`, `CHECKIN_IMAP_MAILBOX` | Dedicated read-only reply-mailbox credentials and mailbox, normally `INBOX`. The worker does not mark messages read, delete or move them. |
| `CHECKIN_TRUSTED_AUTHSERV_IDS` | Comma-separated receiver `Authentication-Results` identifiers. Confirm the provider strips spoofed headers for these identifiers before trusting them. Do not copy an arbitrary incoming header value into this setting. |
| `NOTIFICATION_TIMEZONE` | Must be `Africa/Johannesburg`; other values are rejected in this implementation. Persisted deadlines remain UTC. |
| `NOTIFICATION_REMINDER_DAYS` | Exactly `5`; the protocol does not support a longer daily reminder campaign. |
| `EMAIL_MAX_MESSAGE_BYTES`, `EMAIL_MAX_MESSAGES_PER_POLL` | Bound inbound MIME size and each polling batch. Defaults: 65,536 bytes and 50 messages. Attachments are not opened or executed. |
| `NOTIFICATION_ALERT_COMMAND` | Optional absolute path to a fixed executable receiving sanitized operational status, without a shell. Arrange an independent channel such as a local monitor/pager, not the same SMTP account. Leave blank if unavailable and monitor persistent health manually. |

`HOMEBANK_OWNER_EMAIL` identifies the read-only HomeBank owner. It is neither a mail login nor proof of ownership of a notification address. Recipient verification is stored per authenticated vault owner; never enable replies by editing a database `verified_at` field.

For SMTP port 587, `SMTP_SECURE=false` chooses STARTTLS rather than plaintext operation: the adapter must require the upgrade and certificate validation. Port 465 uses TLS immediately. Do not disable certificate validation to work around a provider configuration error. Use bounded connection/socket timeouts and keep SMTP/IMAP protocol debugging off in production. These transport choices follow the [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

For a domain you control, configure DNS using your chosen provider's exact records, not invented SPF includes or signing keys. For a provider-owned domain such as `@me.com`, the provider manages these records; inspect delivered-message results rather than attempting DNS changes:

1. Publish the provider's authorized sending hosts/includes in the domain's single SPF TXT policy; merge with an existing policy rather than adding a second `v=spf1` record. [SPF specification](https://www.rfc-editor.org/info/rfc7208/).
2. Enable provider DKIM signing and publish its selector records under `selector._domainkey`. The provider retains the signing private key; DNS contains the public-key record or provider-directed alias. Check the test message for an aligned signing domain. [DKIM specification](https://www.rfc-editor.org/info/rfc6376/).
3. Publish a DMARC policy at `_dmarc` for the sender domain, arrange reporting, and review all legitimate senders before tightening policy from monitoring to quarantine/reject. A DMARC pass requires an SPF or DKIM pass aligned with the visible author domain; it does not prove a particular human sent a message. [Current DMARC specification, RFC 9989](https://www.rfc-editor.org/info/rfc9989/).
4. Inspect a delivered test message's original headers. Confirm From, Reply-To, TLS transport, SPF/DKIM/DMARC results and that the inbound provider supplies a trustworthy authentication result. Preserve only sanitized results as acceptance evidence.

Trust only the configured receiver's authentication results from within its documented trust boundary. A forged header is not evidence of sender authentication. Both reply codes are required even when domain authentication passes. See [RFC 8601](https://www.rfc-editor.org/info/rfc8601/).

### iCloud Mail (`@me.com`)

Apple specifies authenticated SMTP on `smtp.mail.me.com:587`, TLS-protected IMAP on `imap.mail.me.com:993`, and an app-specific password for both. SMTP uses the full address; IMAP normally uses its local part, with the full address as a fallback. [Apple's iCloud Mail server settings](https://support.apple.com/en-ie/102525).

Use these illustrative placeholders in the private `.env`, replacing the mailbox names and password locally:

```dotenv
SMTP_HOST=smtp.mail.me.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=your-mailbox@me.com
SMTP_PASSWORD=
SMTP_FROM=your-mailbox@me.com
CHECKIN_REPLY_MAILBOX=your-mailbox@me.com
CHECKIN_IMAP_HOST=imap.mail.me.com
CHECKIN_IMAP_PORT=993
CHECKIN_IMAP_USERNAME=your-mailbox
CHECKIN_IMAP_PASSWORD=
CHECKIN_IMAP_MAILBOX=INBOX
NOTIFICATION_TIMEZONE=Africa/Johannesburg
NOTIFICATIONS_ENABLED=false
```

Generate an Apple app-specific password and put that same value in `SMTP_PASSWORD` and `CHECKIN_IMAP_PASSWORD`; do not use the main Apple Account password. Leave transport disabled until secrets and acceptance review are ready. Apple manages SPF/DKIM/DMARC for `me.com`; inspect the received test's results. Do not invent a trusted authentication-service identifier: establish the provider's header trust policy first. Prefer a dedicated reply mailbox or provider-routed folder so the worker does not scan unrelated incoming messages.

Blank passwords mean configuration is incomplete. Successful transport authentication or template-preview delivery alone does not establish the two-factor round trip; complete the provider acceptance exercise at the end of this guide.

## Permissions and supervised service

The canonical service is `wolfs-legacy.service`, with working directory `/home/wolf/Projects/wolfs-legacy`. Older installations may use `legacy-vault.service` and `/home/wolf/Projects/legacy-vault`; inspect the actual unit before cutover. Run only one process against a given SQLite database. Stop and disable the old service during the reviewed migration so it cannot restart alongside the new one.

Use an existing non-root account that owns the checkout's `data/` and managed-document directory and can read the configured HomeBank files. Do not recursively change ownership of the original HomeBank documents. Protect runtime files:

```bash
cd /home/wolf/Projects/wolfs-legacy
chmod 600 .env
chmod 700 data
# After the first controlled startup creates these files:
chmod 600 data/.secrets data/vault.db
```

Set ownership to the chosen service account if needed. Keep all SQLite WAL/SHM files, secret backups and independent recovery-code material private too. The service's `UMask=0077` applies to new files. On Fedora, inspect SELinux denials if access fails; grant only the needed paths rather than disabling SELinux. Keep port 4444 on the intended trusted network/VPN or behind an HTTPS reverse proxy with access controls. Do not open it broadly as part of email setup.

Render and verify the unit without changing the host service:

```bash
bash scripts/setup-systemd.sh --check
bash scripts/setup-systemd.sh > /tmp/wolfs-legacy.service
```

Review the generated unit and `systemd/wolfs-legacy.service.example`. The setup script resolves the actual absolute Node executable, including an NVM install; systemd does not load interactive shell/NVM initialization. It sets the working directory, loads `.env`, preserves port 4444, uses `Restart=on-failure` with five-second delay and restart limits, and writes sanitized logs to the journal. See the [systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

After the review and acceptance gate, install explicitly:

```bash
sudo bash scripts/setup-systemd.sh --install --user wolf --node "$(command -v node)"
```

Installation does not enable or start the service, and refuses to overwrite an existing unit. Merge reviewed changes into an existing unit manually, preserving local restrictions. Use `systemctl daemon-reload` after unit edits. Starting/enabling the reviewed deployment is a separate operator action. Ensure the final effective environment contains `PORT=4444`; values in `.env` can override unit defaults. Confirm with `curl --fail http://127.0.0.1:4444/health` after starting.

## Verify the owner and provision the independent factor

Use the authenticated owner session through the intended HTTPS/trusted-network endpoint. The owner-only API uses the same bearer authentication as other vault operations. Secret-changing operations require the owner's current password. Send JSON request bodies, not URLs or command-line arguments containing passwords or codes. Do not store bearer tokens in shell history or screenshots.

| Method and route | JSON body / result |
| --- | --- |
| `GET /api/notifications` | Sanitized configuration, remaining-code count, cycle, recent outbox results, transport health and `transport_configured` / `reply_transport_configured` flags. These flags validate configuration; they do not prove a provider connection or delivery. |
| `POST /api/notifications/verify/start` | `{ "recipient": "owner@example.com", "password": "…" }`; queues a short-lived recipient-verification code to that address. |
| `POST /api/notifications/verify/complete` | `{ "code": "…" }`; enter the code received in that inbox while still signed in as the owner. |
| `POST /api/notifications/recovery-codes` | `{ "password": "…" }`; revokes the previous unused batch and returns a fresh batch once. |
| `PUT /api/notifications/settings` | `{ "reply_enabled": true, "offline_stored_separately": true, "timezone": "Africa/Johannesburg", "reminder_clock": null, "password": "…" }`; requires recipient verification, configured SMTP/IMAP and unused offline codes. Confirm `offline_stored_separately` only after saving the batch independently of email. `null` clock follows the final deadline's local clock time; an explicit clock uses `HH:mm` consistently. Other timezones are rejected. |
| `POST /api/notifications/test` | `{ "password": "…" }`; queues a test for the verified recipient. SMTP acceptance does not prove mailbox delivery. |

Provision in this order:

1. Review provider configuration and the global switch. Once permitted for acceptance testing, enable transport and restart the supervised process so it loads the changed `.env`.
2. Start recipient verification, retrieve its code from the intended inbox, and complete verification while signed in. Confirm `verified_at` via the owner status API.
3. Generate the independent batch. Print it or save it in a separate password vault/device that is not accessible through the email account. If saving a file, use a private directory (`0700`) and file (`0600`) outside the checkout, mail sync and routine vault backups. Do not email it to yourself or store it beside the reminder in the same inbox.
4. Confirm you can recover that independent copy before enabling reply check-in, then set `offline_stored_separately: true` in the enable request. The server cannot display the plaintext batch again. Rotation invalidates old unused codes, revokes outstanding challenges and disables replies until explicitly re-enabled; securely discard the replaced copy after saving the replacement.
5. Enable reply checking for the verified owner and inspect the current cycle and five future reminder slots. Enabling transport or changing the notification clock does not count as a check-in.

## Reply behavior and schedule

For a 30-day interval and seven-day grace, final release is day 37 after the last successful check-in. Reminders are on days 32–36, exactly once on each of the five local dates. By default each uses the release deadline's Johannesburg clock time. Scheduling and templates currently support `Africa/Johannesburg` only; a different timezone is rejected so the five dates and displayed South Africa time remain consistent. A shorter remaining window schedules only upcoming dates, with no historical backfill. Event-driven acknowledgements and access/security notices are separate from these five reminders.

Reply to the **newest reminder** from the verified address, preserving its reply/thread metadata, with exactly one unquoted line:

```text
CONFIRM <EMAIL-CHALLENGE> <NEXT-UNUSED-OFFLINE-CODE>
```

The reminder includes only the first code. Newer reminder challenges supersede older ones. Each lasts at most 24 hours and never beyond the release deadline. Do not forward the message, use an automatic reply or send the second code by itself. A standard short-lived TOTP is not accepted in asynchronous email replies.

For inbound email, only a verified two-code reply changes `last_check_in`; the existing authenticated owner check-in remains available. Successful reply verification atomically consumes both codes, starts a new cycle, cancels remaining old-cycle work and queues an acknowledgement with the new routine due date and final release deadline. The Dead Man's Switch stays enabled. Independent beneficiary emergency requests and existing grants remain in effect. A late or invalid reply changes no release/access state. A reply after actual release cannot revoke access.

The read-only IMAP worker stores UID validity, UID progress and durable message fingerprints. It does not rely on read/unread flags. Restarting resumes from persisted checkpoints; a UID-validity change creates a fresh checkpoint namespace with replay checks still enforced. Mail recovered after an outage is accepted only when the challenge and cycle remain valid at processing time, irrespective of the message's `Date` header. Leave dedicated mailbox retention long enough to investigate outages and manage it separately; the application does not delete messages.

## Monitor, investigate and rotate

Inspect the authenticated notification status and `/api/audit`, plus the restricted journal:

```bash
sudo systemctl status wolfs-legacy.service
sudo journalctl -u wolfs-legacy.service --since '1 hour ago'
```

Outbox states have different meanings:

| State | Meaning / response |
| --- | --- |
| `queued` | Durable work waiting for its scheduled time. |
| `sending` | Claimed for an SMTP attempt. |
| `sent_to_server` | SMTP accepted the submission; mailbox delivery is unproven. |
| `delivered` | Independently confirmed delivery only; do not assign merely because SMTP returned success. |
| `failed`, `retried` | Failed attempt or scheduled retry; inspect sanitized reason and attempt history. |
| `dead_letter` | Retry budget exhausted or permanent failure; operator investigation required. |
| `uncertain` | A worker stopped during a send and provider acceptance cannot be proved. Do not blindly retry: inspect the provider using the stable Message-ID first. |
| `cancelled` | Work invalidated by cycle changes, supersession or restore quarantine. |

Repeated SMTP/IMAP failures persist degraded health and can invoke the alternate alert executable when configured. Monitor that channel independently. No alternate channel is assumed if none is configured. A failed email never counts as a successful check-in; the deadline and existing beneficiary rules continue.

Never enable protocol debug logging or record raw MIME while troubleshooting. Do not paste provider errors, credentials, full addresses, codes or access tokens into an issue. Use internal event/cycle/outbox IDs and fixed reason codes. For a rejected reply the owner warning intentionally does not identify which factor failed; warnings are throttled to avoid loops and flooding.

Rotate SMTP/IMAP application credentials at the provider and update `.env` with the service stopped, then restart and send a new test. If `NOTIFICATION_SECRET` must rotate, stop all workers, set the global switch false and use the standalone quarantine procedure below on the stopped database to invalidate verification attempts, challenges, offline codes and pending mail for every owner. Save the replacement secret in protected storage. After configuration review, allow transport for fresh address verification, issue and save fresh independent batches, then explicitly re-enable replies. Existing derived reminder/verification codes cannot be reconstructed with the replacement key; offline codes also require explicit revocation, which quarantine performs. Do not change `ENCRYPTION_KEY` casually: existing vault and HomeBank ciphertext requires the original key. Keep JWT/encryption-key recovery separate from mail-provider credential rotation.

## Consistent backup

The JSON application export is not a complete operational backup: it contains decrypted vault entries and does not preserve mail jobs, transport checkpoints, managed files or service secrets. A raw SQLite backup contains code hashes, not plaintext codes. Keep `NOTIFICATION_SECRET` and transport passwords in the separately protected secret backup; never add plaintext offline batches or raw reminder mail to a database snapshot.

Before upgrade or rollback, stop every process using this database, preserve its existing state, the generated `.secrets`, `.env`, managed documents, unit and exact source revision. Use a verified independent backup destination. The older `scripts/backup-managed.sh` hardcodes the prior checkout name; do not use it unchanged for this installation. This explicit copy procedure avoids that mismatch:

```bash
sudo systemctl stop wolfs-legacy.service
sudo systemctl is-active wolfs-legacy.service
# Expected: inactive (nonzero command status). Also inspect/stop any old unit.

umask 077
WL_APP=/home/wolf/Projects/wolfs-legacy
WL_BACKUP_ROOT=/mnt/offline/wolfs-legacy-snapshots
WL_SNAPSHOT="$WL_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
# Verify that WL_BACKUP_ROOT is mounted independently and has free space first.
mkdir -m 700 -- "$WL_SNAPSHOT"
cp -a -- "$WL_APP/data" "$WL_SNAPSHOT/data"
cp -a -- /srv/data/files/legacy-vault-managed-documents "$WL_SNAPSHOT/managed-documents"
git -C "$WL_APP" rev-parse HEAD > "$WL_SNAPSHOT/source-commit.txt"
sudo systemctl cat wolfs-legacy.service > "$WL_SNAPSHOT/service-effective.txt"
sqlite3 "$WL_SNAPSHOT/data/vault.db" 'PRAGMA integrity_check;'
# Expected: ok. Back up .env separately into your protected secret store.
```

Do not continue copying while an app, mail worker or SQLite writer is still running. `data/` includes `.secrets` and any WAL/SHM files; the complete stopped copy avoids WAL loss. Verify hashes/integrity, document the secret-backup reference and test a restore in isolation. Keep backups encrypted/offline with access at least as restrictive as the original vault.

## Safe restore and quarantine

Never start workers against an unreviewed restored mail database: it may contain old pending notices, revived offline codes and a release deadline already in the past. Transport quarantine does not suspend the Dead Man's Switch. Inspect restored deadline and access state before deciding when a production restart is appropriate.

1. Stop `wolfs-legacy.service` and any old/separate worker. Preserve the current production snapshot using the procedure above.
2. Restore the chosen snapshot to a **new staging directory**, keeping the original and current copies. Restore its matching vault encryption secret from protected storage. Keep the staging host disconnected from production SMTP/IMAP and its global `NOTIFICATIONS_ENABLED=false` before any startup.
3. Use the reviewed feature checkout's standalone tool on the existing staged database. The flag acknowledges that all workers are stopped; it is not an automatic process detector:

   ```bash
   node /home/wolf/Projects/wolfs-legacy/scripts/email-restore-safety.js \
     --service-stopped /absolute/staging/data/vault.db
   ```

   The tool never creates a database or loads the application. It checks integrity/schema and atomically disables replies, clears recipient verification, cancels queued/retried/sending/failed/uncertain mail, revokes unused challenges and offline codes, supersedes open cycles and records `restore_review_required` health. Sent/delivered/dead-letter history, mailbox checkpoints, deduplication records, vault ciphertext, beneficiary token hashes and existing access permissions are retained. An old pre-email database is an explicit no-op; an unsupported/partial schema fails without mutation. Keep the service stopped on failure.
4. Verify database integrity, document hashes and the preserved HomeBank/document mappings. Confirm notification settings show `reply_enabled=0`, no recipient verification, and no active pre-restore codes or pending messages. Use `node --test tests/email-restore-safety.test.js` for the tool's preservation/quarantine regression check; it uses disposable synthetic databases.
5. Review the restored switch deadline and grants with the owner. Do not erase a legitimate release or reset check-in automatically as a side effect of restoration. A deliberately restarted service may promptly process an already elapsed deadline under the normal policy.
6. Only after review, point the unit at the approved restored copy and use a private managed-document copy with correct paths/ownership. Leave transport disabled for the first inspected startup. Reverify the owner address and provision a newly saved independent batch before re-enabling email; perform the provider round trip again. Preserve all previous snapshots until acceptance is complete.

## Roll back code without destroying data

Record the pre-upgrade commit before deployment. If rollback is required, stop all workers and take a second complete snapshot of the new state. Keep its source revision for forensic/recovery use. Do not use `git reset --hard`, drop the new tables or run a reverse migration against the live vault.

Prepare a separate checkout at the recorded known-good commit and restore a **copy of the matching pre-upgrade data** and matching encryption secrets into it:

```bash
WL_PREVIOUS_COMMIT="$(cat /absolute/pre-upgrade-snapshot/source-commit.txt)"
git -C /home/wolf/Projects/wolfs-legacy worktree add \
  /home/wolf/Projects/wolfs-legacy-rollback "$WL_PREVIOUS_COMMIT"
# Copy the reviewed pre-upgrade data snapshot and restore its secret backup.
# Review paths, dependencies and unit before selecting this checkout.
```

Keep `NOTIFICATIONS_ENABLED=false` in rollback `.env`. If the snapshot has an email schema, run the **current reviewed feature checkout's** restore-quarantine script against that stopped copy before selecting it, even when the old commit lacks the script. Superseding a mail cycle does not revoke beneficiary grants. Review the older code's treatment of deadlines, preserved additive tables and data format before starting it; prefer the matching pre-upgrade snapshot over assuming the old executable understands newer state. Change the unit's `WorkingDirectory`, `ExecStart`, `EnvironmentFile` and managed-document configuration together, reload systemd, and start only the reviewed target. Leave the failed checkout and all snapshots intact. A rollback may omit post-snapshot user changes, so reconcile them with the owner before production cutover.

## Isolated real-provider acceptance server

To exercise the real reply workflow without using the production vault, run this explicit acceptance harness from the reviewed checkout:

```bash
node scripts/email-acceptance-server.js --allow-real-email
```

It binds only to **http://127.0.0.1:4445**, copies the current application into a new private temporary directory, creates an empty synthetic database and uses fresh JWT/encryption/notification secrets. It reads only mail transport settings from the private `.env`; it does not open the production database, copy its data/secrets or use the real HomeBank/document directories. Mail credentials are passed to the child process in memory. No systemd unit is installed or restarted.

Before serving enrollment, the harness authenticates to IMAP, opens the selected mailbox read-only and seeds the disposable database's checkpoint from the current UID validity and `UIDNEXT-1`. It reads no historical message bodies at this step. This allows new verification/reply messages to be processed promptly without replaying years of unrelated mail. If that preflight fails, the server does not start enrollment. Production mailbox-processing behavior is unchanged.

1. Keep the harness terminal running and open **http://127.0.0.1:4445/#register** on this computer. Create a synthetic owner identity and a new test-only password. Do not import real vault entries or use the production password.
2. Open **Settings**. Verify the real notification mailbox using the delivered verification code, generate the offline batch, save it independently of that mailbox, and enable replies with the independent-storage confirmation checked. These steps use the actual protected application routes and UI.
3. Expand the harness banner's **Send the real acceptance reminder** control. Enter the test owner's current password and submit once. The isolated test endpoint starts a real 30-day-plus-seven-day cycle whose first five-day reminder is due a few seconds later. It also creates two synthetic beneficiaries to verify that an emergency request and an existing access grant survive the email check-in.
4. Wait up to 30 seconds for normal worker polling. Open the **[ACCEPTANCE TEST]** reminder in your mailbox and reply from the verified address, preserving the mail thread, with the supplied challenge and one independently stored unused offline code. Do not paste either code into this chat, a test log or the harness banner.
5. Use **Check acceptance result** in the banner and inspect Settings/audit evidence. A successful result has exactly one accepted reply, one consumed code and an acknowledgement queued or accepted by SMTP. Observe that acknowledgement in the real mailbox and verify the new deadlines, old-cycle cancellation and unchanged synthetic beneficiary states before recording acceptance.

Every email generated by this instance has an **[ACCEPTANCE TEST]** subject and a visible plain-text/HTML notice identifying a disposable synthetic vault. This marking preserves the real challenge command and verification logic. No preview batch is sent by the harness. It stops automatically within **two hours**, before later daily reminders can run, and can be stopped earlier with Ctrl+C. The copied code and its database are retained privately for evidence inspection.

Ignored `data/email-acceptance-session.json` records the private staging path, child PID, local URL, expiry and initial mailbox checkpoint, without credentials or codes. On normal stop it records the stop time and reason. Preserve the private evidence only as long as needed; it contains the test-owner password hash, mail metadata and code hashes. Revoke or discard the disposable offline batch after acceptance and never use it for the production vault. Production enrollment remains a separate owner action.

## Acceptance evidence and current gate

Automated tests and local fake transports verify implementation behavior; they cannot prove a particular production provider delivers and receives mail. Record the reviewed commit, test command/result, operator/date, configured provider names (without secrets), exact old/new UTC timestamps and sanitized event IDs.

The real-provider gate requires all of the following:

1. A real configuration test accepted by SMTP **and observed in the owner's mailbox** with correct From/Reply-To and authentication headers.
2. Recipient verification and an independent offline batch saved outside that email account.
3. A real scheduled reminder received from the configured SMTP provider, followed by a real reply through the dedicated IMAP provider containing both valid codes on one line.
4. Durable inbound processing records, consumed hashes, one check-in, new due/release timestamps, old-cycle cancellation and the received acknowledgement; beneficiary emergency requests/grants remain unchanged.
5. Controlled invalid/replayed reply and outage/restart checks with no unintended check-in and visible sanitized health/attempt records. Never force a live production release merely to obtain test evidence; use a disposable test owner/environment.

**Real two-factor reply acceptance remains pending recipient enrollment and the reply exercise above. Real iCloud SMTP authentication and delivery of all 17 template previews have passed, with inbox receipt independently observed through read-only IMAP; see the [test report](email-test-report.md). This does not establish the remaining reply gate or authorize deployment.** Keep secret-bearing evidence out of Git.
