# Local frontend with the shared production backend

Run from the checkout:

```sh
npm run dev:frontend
```

Open **http://127.0.0.1:5173**. This serves the local `public/` files and forwards every `/api` request to **https://wolfspack.co.za**. Both frontends use the same production data. Saving, uploading, deleting and checking in from the local frontend perform real operations on that backend. Sign in normally; each browser origin keeps its own sign-in token.

The frontend server does not read `.env`, initialize SQLite, import the application server or run HomeBank, email or expiry workers. Keep one production backend running. Existing `npm run dev` still starts the complete local backend and is separate from this shared-backend workflow.

Optional settings are explicit process environment variables:

```sh
DEV_FRONTEND_PORT=5174 DEV_API_TARGET=https://wolfspack.co.za npm run dev:frontend
```

`DEV_FRONTEND_HOST` defaults to `127.0.0.1`; change it only when intentionally exposing the local frontend to your network. `DEV_API_TARGET` accepts one HTTPS origin, without a path, username or password. HTTPS certificate verification remains enabled. HTTP is accepted only for loopback fixture servers. API bodies and responses stream through the proxy, including uploads, recordings, downloads, authorization, range headers and upstream status codes. API redirects are returned to the browser rather than followed by the proxy.

The frontend-only script uses Node built-ins and needs no installed npm dependencies. It does not transfer the local HomeBank file: production still needs its configured source copy and forwarding arrangement.

Synthetic checks:

```sh
node --test tests/dev-frontend.test.js
```

The certificate-rejection check uses OpenSSL to generate a temporary self-signed fixture certificate when OpenSSL is available. No production API or database is contacted.

## Trusted local sign-in

The frontend can use a separately authorized local gateway to keep the live production backend while allowing existing users to sign in from this computer with their password, without an SMS challenge. The public production website retains its normal SMS requirement. Existing password checks and registration approval still apply.

The optional gateway configuration lives at `~/.config/wolfs-legacy/local-auth.json`, outside the checkout and public files. Its parent directory must belong to the frontend process user and have mode `0700`; the regular, non-symlink file must belong to that user and have mode `0600`. Configure the matching gateway privately on the production backend before enabling this file:

```json
{
  "enabled": true,
  "api_origin": "https://wolfspack.co.za",
  "gateway_id": "<32 random hexadecimal characters>",
  "secret": "<64 random hexadecimal characters>"
}
```

The example values are placeholders. Both sides must use the same privately generated gateway ID and secret. The backend explicitly enables this gateway with `AUTH_LOCAL_GATEWAY_ENABLED=true`, the matching `AUTH_LOCAL_GATEWAY_ID` and a random 64-hex-character `AUTH_LOCAL_GATEWAY_SECRET`; keep `AUTH_SMS_REQUIRED=true`. The secret stays in private server configuration, the local file and process memory. Request proofs go only to the exact configured, certificate-verified HTTPS API origin. An absent file keeps the normal proxy behavior; `{"enabled":false}` disables local gateway signing. A malformed, insecurely permissioned or mismatched configuration prevents startup with a generic configuration error. Restart the frontend after changing this file.

Gateway signing requires a direct socket connection from loopback or an address assigned to this computer. The additional request authority must be `localhost`, a loopback/own-interface address, this machine’s hostname, or its `.local` name (for example, `asus.local`). Browser Origin and Referer must match the local frontend when present, and cross-site requests are rejected. Other computers on the LAN use the normal SMS flow. Forwarded headers never establish local eligibility; inbound gateway proof headers are stripped from every request.

Uploads and downloads continue to stream without buffering, and local and public frontends continue to read and change the same production data. The gateway configuration does not require `.env` to be loaded by the frontend-only process.

Local sessions are labelled `local_gateway`, not SMS-verified, and each protected request requires a fresh machine proof. Copying their bearer token directly to the public site does not authorize it. Account blocking, password checks, session revocation, owner identity checks and new-account mobile activation remain enforced. Owner management uses the authenticated account and a server-verified local gateway when accessed from this computer. SMS enrollment and saved mobile numbers are retained.

The server stores short-lived consumed nonces in `local_auth_gateway_nonces`, preventing replay across web processes. Disabling the backend gateway or rotating its ID/secret blocks its local sessions; normal public SMS sessions remain valid. Retain pre-change snapshots locally only and remove any temporary hosting snapshot after verified download.

Local activation was verified on **3 November 2026 at 14:54:42 SAST** using runtime commit `50bd5ee`. The owner approved Fedora's administrator prompt, and `wolfs-legacy.service` restarted successfully at 14:53:50 SAST. Port 4444 and `asus.local:4444` now use the trusted password-only local sign-in path with the same live production data. Public-site `AUTH_SMS_REQUIRED=true` remains enabled. Requests with invalid credentials were rejected, forged browser proof headers were replaced, and foreign browser origins were rejected; verification sent no SMS and created no accounts. A real synthetic HTTPS proxy/authentication integration verified successful password-only login, protected access, rejection of its token directly on the public API, and unchanged ordinary SMS login. The full suite passed **455 Node tests and 17 Python tests**, with no failures or skips. No user's password was requested for verification.

Production integrity, existing accounts/enrollment, protected records and existing keys were verified unchanged. Fresh recovery snapshots, keys and managed-file copies are retained locally only; temporary hosting snapshots, helper scripts and upload artifacts were removed. Gateway credentials remain outside Git and public assets.

## Keep the production HomeBank source current

The standalone Python forwarder sends a validated copy of the local HomeBank file over certificate-verified FTPS. It does not start the app or read its database. Keep its configuration in a private `0600` file, for example `.env.homebank-sync` (ignored by Git):

```dotenv
FTP_HOST=dahost12.vpslocal.co.za
FTP_PORT=21
FTP_USERNAME=your-dedicated-ftp-login
FTP_PASSWORD="your-ftp-password"
LOCAL_DIRECTORY=/absolute/local/homebank-folder
SELECTED_FILE=
REMOTE_DIRECTORY=/absolute/private/production/homebank-folder
REMOTE_FILENAME=current.xhb
# Optional absolute path; default is the config filename with .state appended.
STATE_FILE=
```

Use the certificate-valid server hostname, even when the website uses another domain. The remote directory must already exist outside the web root. The production HomeBank connection should select that directory and `current.xhb`. Configuration values are literal, with optional matching outer quotes; there is no shell expansion. Set `SELECTED_FILE` to one `.xhb` basename or leave it empty to select the newest regular, visible `.xhb` file in `LOCAL_DIRECTORY`. Symlink source files are skipped. The script rejects files over 50 MiB and validates them using the existing HomeBank parser.

Run once:

```sh
python3 scripts/sync-homebank-source.py --config /absolute/private/.env.homebank-sync
```

Both FTP control and data connections use TLS with certificate verification. The script uploads to its own hidden, unique `.uploading` file, checks that the local source has not changed, then renames the remote copy to `current.xhb`. A failure cleans only its own temporary upload and preserves the current remote source. It never deletes or changes local originals. The server must support replacing the destination through rename; the script will not delete the existing source to work around a refused rename.

Successful source hashes and filenames are saved atomically in a private `0600` state file. Unchanged sources skip FTP; add `--force` to resend a validated source. Output contains only statuses such as `homebank_sync: uploaded`, `unchanged`, `source_changed` or `transfer_failed`. Failed or changing transfers can be retried by a one-minute user timer. Production performs its normal sync after the complete copy is published. A local computer that is asleep or offline cannot forward newly saved files.

Synthetic forwarder checks use fake FTP transports:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_homebank_source_sync.py
```
