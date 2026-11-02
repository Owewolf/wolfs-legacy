# SMS verification for account creation and sign-in

With `AUTH_SMS_REQUIRED=true`, creating an account requires a mobile number and
successful SMS verification. A password alone never creates a signed-in session.
Every later sign-in verifies the password and sends a code to the saved
authentication number. Owners cannot disable SMS authentication in this mode.

## Saved numbers and first verification

The account's saved authentication number takes precedence. For an existing
account without an enrolled number, the server uses the owner's single distinct
valid `mobile_phone` from Personal Identity. Contacts and beneficiaries never
supply the owner's sign-in number. The first successful code verification saves
and enrolls that number for future logins. Later profile edits do not silently
replace the enrolled authentication number.

Numbers accept international `+`/`00` format and local South African format with
`SMS_DEFAULT_COUNTRY_CODE=27`. Missing or ambiguous legacy numbers require a
password-verified mobile setup step. Its five-minute setup token authorizes only
that step and cannot access the vault or replace an enrolled number.

## Account and sign-in flow

1. Registration submits name, email, password and mobile number to
   `POST /api/auth/register`. The response contains an SMS challenge, never a JWT.
2. Sign-in submits email and password to `POST /api/auth/login`. Required accounts
   receive the same challenge using their saved number. Missing numbers use
   `POST /api/auth/login/phone` with a scoped setup token and the chosen number.
3. The client submits the code to `POST /api/auth/login/challenge/verify`.
   Successful verification issues the session JWT. Initial enrollment also
   returns ten one-time recovery codes, displayed until the owner confirms saving
   them. Setup tokens and recovery codes stay in browser memory.
4. Future logins use the enrolled number. Authenticated phone changes require
   the existing password and verification of the new phone.

If registration creates the account but SMS submission fails, the response
directs the owner to sign in and request a new code. No session is issued and the
unverified account remains recoverable. Provider failures never allow a
password-only fallback. Older password-only sessions are redirected to sign in.

## Security controls

Codes are six cryptographically random digits, expire after five minutes and
are stored as keyed hashes using `OTP_HASH_KEY`. Verification is single use,
limited to five failed attempts, with a 60-second resend cooldown and per-user/IP
throttling. Immediate SQLite transactions prevent simultaneous processes from
reusing a code or recovery code. Challenges are bound to the current saved phone;
changing that phone invalidates the old challenge.

One-time recovery codes remain available for an enrolled account. Codes and API
credentials never enter logs. Production rejects simulated SMS transport. The
provider requires explicit per-message acceptance and a matching recipient;
HTTP success alone is insufficient. Requests have a ten-second deadline and do
not follow redirects.

## Configuration

Configure the production application's private `.env`, never Git:

```dotenv
AUTH_SMS_REQUIRED=true
SMS_DEFAULT_COUNTRY_CODE=27
SMS_PROVIDER=clickatell
COLLECTOR_SMS_ENABLED=true
COLLECTOR_SMS_SIMULATE=false
COLLECTOR_SMS_ENDPOINT=https://platform.clickatell.com/v1/message
CLICKATELL_API_KEY=your-private-integration-key
OTP_HASH_KEY=auto
```

Keep the existing generated production OTP secret in `data/.secrets` when using
`auto`. Explicitly disabling the transport overrides provider aliases. Simulation
is available only outside production for disposable tests. Legacy deployments
may explicitly leave required authentication disabled; their responses identify
that optional mode with `sms_required: false`.

The [official Clickatell One API reference](https://help.clickatell.com/developers-api-reference/reference/one-api)
defines message submission and the read-only `GET /v1/balance` credential check.
Provider acceptance confirms submission; delivery to the handset is a separate
event.

## Verification

Synthetic tests cover required registration/login, saved-number precedence,
missing and ambiguous numbers, initial verification, phone changes, transport
failure, old-session rejection, setup-token scoping, production simulation,
concurrent replay, recovery codes and the complete browser flow. Fixtures use
in-memory or temporary databases and simulated transports.
