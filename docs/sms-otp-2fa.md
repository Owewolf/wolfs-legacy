# SMS OTP 2FA (Collector)

This repository now supports SMS OTP two-factor authentication for owner logins.

## Security controls

- Backend-only integration through a Collector-compatible HTTP API.
- Six-digit CSPRNG OTP codes.
- OTP validity: 5 minutes.
- OTP storage: keyed HMAC hash (`OTP_HASH_KEY`), never plaintext.
- Single-use verification: successful challenge is immediately consumed.
- Attempt limit: 5 failed verifications per challenge.
- Resend cooldown: 60 seconds.
- Throttling: per-user and per-IP challenge start/resend events.
- Recovery mechanism: one-time recovery codes (stored as keyed hashes, rotatable).
- JWT issuance: for 2FA-enabled accounts, JWT is only issued after successful second factor.
- Middleware enforcement: if a user has SMS 2FA enabled, protected routes reject JWTs not minted from second-factor completion.
- Audit events include action metadata only and do not include OTP values or recovery code plaintext.

## Environment configuration

Set in `.env`:

```env
COLLECTOR_SMS_ENABLED=false
COLLECTOR_SMS_SIMULATE=true
COLLECTOR_SMS_ENDPOINT=https://platform.clickatell.com/v1/message
COLLECTOR_SMS_AUTHORIZATION=
OTP_HASH_KEY=auto
```

Notes:

- Keep `COLLECTOR_SMS_SIMULATE=true` for local testing.
- Set `COLLECTOR_SMS_ENABLED=true` only after live provider credentials are configured.
- Do not commit `.env` with real credentials.

## Auth flow summary

1. `POST /api/auth/login` validates email/password.
2. If SMS 2FA is disabled, JWT is returned as before.
3. If SMS 2FA is enabled, login returns challenge metadata only.
4. Client submits OTP or recovery code to `POST /api/auth/login/challenge/verify`.
5. JWT is issued only after successful challenge verification.

## Enrollment flow summary

1. Authenticated user starts enrollment (`/2fa/enroll/start`) with phone + current password.
2. OTP is sent to the phone.
3. User verifies OTP (`/2fa/enroll/verify`).
4. Phone is enrolled, SMS 2FA is enabled, and recovery codes are returned once.

## Tests added

- `tests/sms-otp.test.js`: OTP lifecycle, attempts, resend cooldown, recovery code behavior.
- `tests/auth-2fa-routes.test.js`: route-level enforcement and challenge-based JWT issuance.
- `tests/sms-otp-migration.test.js`: migration safety and schema bootstrapping.
