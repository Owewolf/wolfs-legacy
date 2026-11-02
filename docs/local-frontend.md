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
