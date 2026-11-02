# Email integration baseline audit

Inspected branch `feature/homebank-managed-documents` at `dc93941` before implementation; implementation branch: `feature/email-notifications-reply-2fa`. Scope includes current HomeBank and managed-document extensions, not only upstream.

| Transition | Current authority and behavior | Restart / idempotency observations |
| --- | --- | --- |
| Register | `routes/auth.js` creates an inactive switch and user check-in timestamp. | Persistent SQLite state; no email. |
| Enable or save active switch configuration | `routes/deadswitch.js` resets last check-in and clears triggered state. Disabling only changes settings. | Two separate writes, no atomic cycle identifier. Existing beneficiary grants and emergency requests remain unchanged. |
| Signed-in check-in | Updates last check-in and clears triggered state even after release or when disabled. | Does not revoke granted access, cancel emergency requests or change the enabled flag. No durable cycle or email. |
| Final release | `index.js` runs hourly and on startup; interval plus grace after last check-in grants all currently ungranted beneficiaries and marks switch triggered in one transaction. | Persistent triggered flag prevents another global release until owner resets it. Deadline parsing mixes SQLite zone-free timestamps and host-local `setDate`; this feature must make UTC interpretation explicit. |
| Beneficiary registration / removal | Creates token hash and two-year expiry, or deletes beneficiary. | No notification. Removal eliminates access via that token. |
| Manual grant | Sets access and timestamp; does not clear emergency request. | Repeated calls rewrite timestamp and audit even without transition. |
| Manual revoke | Clears access, grant timestamp and emergency request/time. | Does not clear switch triggered flag; a subsequent beneficiary access call can grant again under that rule. Preserve this policy. |
| Emergency request | Valid, unexpired token required; records request/time only if neither requested nor granted. | Repeats return existing state; waiting period survives restart. |
| Emergency denial | Clears request/time only. | Does not revoke existing access; repeated calls are no-ops except audit. |
| Beneficiary access | Re-reads inside transaction, grants when emergency waiting interval elapsed, otherwise if switch triggered. | Automatic emergency grant happens on `/access`, not on repeated `/emergency-access`. Existing grants win; token expiry still gates access. |
| Token rotation / expiry | Owner rotation replaces hash and extends expiry; expired tokens cannot request or access. | Rotation does not change access flags or waiting interval. |
| Application backup/restore | `routes/vault.js` exports visible vault entries, beneficiary metadata and switch configuration; restore imports entries only. | Notification state does not exist; avoid adding credentials, plaintext codes or job replay to this format. |

There are no SMTP/IMAP clients, inbound handlers, mail workers, notification tables, delivery callbacks or mail dependencies. Existing timers are the hourly switch check and HomeBank watcher. `users.totp_*` columns exist but there is no implemented TOTP login/check-in flow; asynchronous replies must not accept TOTP. `HOMEBANK_OWNER_EMAIL` scopes HomeBank only and must not configure mail credentials or notification recipients.

Database changes must be additive. Do not rewrite existing vault ciphertext, document associations, HomeBank snapshots or beneficiary token hashes for this feature. Use durable unique cycle/reminder/event keys, atomic transition/outbox writes and inbound deduplication. Signed-in check-in/activation retains its existing reset policy; email check-in additionally rejects disabled, superseded, expired and already released cycles. Neither route cancels independent emergency requests or revokes grants.

SMTP acceptance cannot prove mailbox delivery. A crash after SMTP acceptance and before local commit leaves an unavoidable uncertain delivery boundary; document it explicitly, reuse stable Message-IDs and avoid claiming exactly-once network delivery.
