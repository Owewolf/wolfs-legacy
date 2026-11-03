# Production hosting and shared local frontend

The hosted application and local frontend share one production API, SQLite
database and managed-document store. Production is `https://wolfspack.co.za`.
Local frontend development is described in [local-frontend.md](local-frontend.md).
Automated tests use disposable synthetic data.

## Release branch

Use `main` as the single push and deployment branch. It includes the previously
deployed feature history together with commits `2df4e5d` and `939a7b3`. Keep
beneficiary creation on the protected Final Wishes helper and retain the streaming
frontend proxy when reconciling older changes.

On a host with SSH and a Git checkout, pull `origin/main` before restarting the
API. This hosting account has neither SSH access nor a remote Git checkout, so
deploy the verified runtime files from that same revision using FTPS. Record their
checksums and Git revision in `apps/wolfs-vault/runtime-manifest.json`, then touch
the Passenger application's `tmp/restart.txt` and verify health and API behavior.
Preserve the live database, matching secrets, private `.env` and storage paths.

## Owner-controlled registration: 3 November 2026, verified at 11:05 SAST

Application revision `02d0c63d782720f5b53b2e7c20f5ee7cc4cf592d` was pushed to
`main` and published through verified FTPS after explicit release authorization.
All 69 runtime files matched their checksums, and the restarted Passenger
backend passed its health check before frontend publication.

The missing approval settings were added to the private local and production
environments. The approving owner is existing account ID `2`, whose enrolled SMS
number was verified against the requested destination. The application origin
is `https://wolfspack.co.za`, and `AUTH_SMS_REQUIRED=true` remains enabled.
Clickatell settings, OTP/JWT/encryption secrets and unrelated configuration were
preserved. No private phone number or environment file was committed.

Before migration, a host-side SQLite online backup included uncheckpointed WAL
writes and passed integrity and foreign-key checks. The private rollback set
also preserves the previous 67 runtime files, manifest, environment and matching
`data/.secrets`. Starting a disposable copy of that production backup on port
4444 preserved all 32 existing tables, both accounts and their credentials,
SMS enrollment, vault records, documents and beneficiary data.

The release passed 394 JavaScript and 17 Python tests with no failures or skips,
including six Firefox workflow tests. Live verification rejected unapproved
registration and tampered invitations with 403, rejected anonymous owner
administration with 401, and confirmed private invitation metadata is POST-only
and not cached. A registration request using the existing owner's contact
details returned the neutral 202 response without creating an application or
sending a notification. Both the hosted site and local frontend serve the
verified application, and the local proxy also rejects unapproved registration.

Post-deployment SQLite verification preserved both existing accounts as active
with authentication version zero. Protected account, vault, document and
beneficiary records matched the pre-release backup; only operational notification
health changed while the existing background worker ran. Secrets remained
unchanged, the owner configuration and real Clickatell transport validated, and
no live SMS was sent during release verification. See
[registration-approval.md](registration-approval.md) for the approval workflow
and local acceptance report.

## Required SMS authentication: 2 November 2026, verified at 20:47 SAST

Runtime `8f1a1034d7b55ab10ae884b95f87868875655466` requires a verified mobile
number at registration and SMS verification at sign-in. Production has
`AUTH_SMS_REQUIRED=true`, a real Clickatell transport and simulation disabled.
The existing saved Personal Identity mobile resolves to the same number used in
the accepted provider setup check. First successful SMS verification enrolls
that number for future logins and issues one-time recovery codes.

The private provider key passed the official read-only balance check with
positive credit, and Clickatell accepted one setup notice to the saved owner
mobile. Provider acceptance is distinct from handset delivery; the owner's next
sign-in completes the real OTP verification. Existing OTP secrets and unrelated
production configuration were preserved.

All 67 runtime file checksums were verified, and the API restarted successfully.
Both frontends reject older password-only sessions and registration without a
mobile number. Browser checks at 390 and 1,440 pixels passed, as did 365
JavaScript and 17 Python tests, including concurrent OTP/recovery replay checks
and full registration, verification and recovery-code browser flows. See
[sms-otp-2fa.md](sms-otp-2fa.md) for configuration and saved-number behavior.

## Permanent Final Wishes deletion: 2 November 2026

Runtime `4cbb7dcfa1da2edd064688985f40feff7a71e92b` adds owner-confirmed permanent
deletion to active and archived wish cards. Cached Archive requests cannot trigger
deletion. Verification passed 342 JavaScript and 17 Python tests.

The requested reset completed at 20:24 SAST: all four existing wishes, including
one archived wish, were permanently removed, with their saved revisions and one
exclusive managed attachment. Beneficiaries were empty. The login, 38 other vault
records, their document links and 23 other managed files were preserved.

After an API restart, none of those wishes returned. A beneficiary added after
the reset received a fresh private draft; that new activity was retained. Browser
checks at 390 and 1,440 pixels verified both frontends, deletion cancellation and
the ready Add Beneficiary form.

## Main release: 2 November 2026, verified at 20:01 SAST

Runtime revision `2c5d2e574e0d72d09a41c2c350b805a726dc49b1` includes both required
commits and the full earlier production history. Twelve changed runtime files
were deployed with FTPS; all 66 runtime file checksums were verified. Passenger
restarted successfully, and the local frontend service was also restarted to load
the streaming proxy.

The current beneficiary, Final Wishes and vault summary API responses matched
their pre-update fingerprints through both frontends. Browser checks at 390 and
1,440 pixels verified wishes, beneficiary editing and phone inputs without API
errors, JavaScript errors or horizontal overflow. The background cron job
completed successfully after deployment. The synthetic suite passed 330
JavaScript and 17 Python tests with application-database access blocked.

The integrated SMS enrollment flow returns an upgraded MFA session, and recovery
codes remain visible until the owner confirms saving them. Existing production
transport configuration was retained. All pushes for this release targeted `main`.

## Initial production cutover: 2 November 2026

Production is live, running application revision `b1f333c018ac`. The original
local backend was stopped before transferring its consistent database. The local
frontend was activated at 15:10 SAST and now uses the production API. Existing
account credentials continue to work on either site.

Migration verification authenticated 94 encrypted values, matched every table
and secret fingerprint, and verified all 24 managed documents by checksum. The
preserved data includes one owner, 38 ordinary vault entries, three beneficiaries
and their three protected Final Wishes drafts. Each draft retains its beneficiary
name as the title, its recipient and the Beneficiary Instructions category.

Live checks confirmed identical API data through both frontends, matching
attachment downloads, and successful HomeBank sync with all seven Wolf's Garage
vehicles in Vehicles. Browser checks at 390 and 1,440 pixels confirmed the vehicle
and Final Wishes cards render without horizontal overflow or JavaScript errors.
The synthetic suite passed 317 JavaScript and 17 Python tests.

The locked production cron job has completed successfully. IMAP polling is ready;
the existing SMTP, reply and recipient-verification settings were preserved.
No new test email was sent. Initial account usage was approximately 137 MiB on
disk, within the 2 GB package.

## Installed local services

The existing local address, `http://asus.local:4444`, serves frontend assets and
proxies `/api` to production. The system service `wolfs-legacy.service` uses
`/etc/systemd/system/wolfs-legacy.service.d/production-frontend.conf` to replace
its startup command with `scripts/dev-frontend.js` and clear its old environment
file. The old local database remains inactive; the frontend does not open it.
The local frontend requires a connection to production for API operations.

The enabled user timer `wolfs-vault-homebank-sync.timer` runs the one-shot
`wolfs-vault-homebank-sync.service` about once per minute. Its private configuration
is `.env.homebank-sync`; transfers and unchanged-source checks have succeeded.
Inspect it using `systemctl --user status wolfs-vault-homebank-sync.timer` and
`journalctl --user -u wolfs-vault-homebank-sync.service`. The user's enabled linger
setting allows the timer to run without an interactive login while the machine
is awake.

## Hosting layout

- DirectAdmin: `https://dahost12.vpslocal.co.za:2222`.
- Application root: `/home/pdfbsmxu/apps/wolfs-vault/app`.
- Startup file: `server/index.js`, production mode.
- SQLite and matching generated secrets: application `data/` directory.
- Private managed files: `/home/pdfbsmxu/apps/wolfs-vault/storage/documents`.
- Private HomeBank source: `/home/pdfbsmxu/apps/wolfs-vault/storage/homebank/current.xhb`.
- Runtime configuration: application `.env`; credentials never belong in Git.
- Node executable: `/opt/alt/alt-nodejs26/root/usr/bin/node`.

The account has a 2 GB disk allowance. Start with one owner. The configured
Final Wishes upload budget is 1,024 MiB, leaving room for application data and
growth; ordinary vault uploads also consume the hosting allowance. Review disk
usage before adding users or large recordings.

SSH is disabled for this account. Deployment uses explicit FTPS on port 21 with
certificate verification against `dahost12.vpslocal.co.za`, including encrypted
data connections, plus the authenticated HTTPS DirectAdmin APIs. The private
local `.env.deploy` file holds operator credentials and is ignored by Git.

## Runtime compatibility

The provisioned host runs Node 26.13.0, ABI 147, and GLIBC 2.28. The downloaded
better-sqlite3 12.8.0 binary requires GLIBC 2.29 and cannot load on this host.
A compatible binary was compiled from that same package version in an isolated
AlmaLinux 8 container using the exact Node headers, with static C++/GCC runtimes.
Its required GLIBC version is at most 2.28; the actual host passed an in-memory
SQLite query with it.

The approved binary's SHA-256 is
`1a9ec6e268edaf93548821f305e987c331cb5538e839d9af6a24c96d95d5def4`.
The binary and build provenance are stored privately under the hosting account's
`apps/wolfs-vault/packages/native` and the operator's local deployment cache.
They are not tracked in Git. A later dependency installation can replace this
binary: reapply and verify the matching artifact after installation, and repeat
the native in-memory test before starting the application. A new Node ABI or
package version requires a new compatible build and validation.

Python 3.6.8 on the host successfully ran the existing HomeBank parser against a
synthetic fixture. `/usr/bin/flock` and the Node runtime also run from account
cron. No separate Python web application is needed for the parser subprocess.

## Background work and reverse proxy

Passenger web processes use `BACKGROUND_JOBS_ENABLED=false`. This disables their
startup release check, hourly release timer, HomeBank watcher and mail-worker
construction/recovery. The default remains enabled for standalone deployments.
This flag does not disable API operations or change release policies.

One account cron job runs every minute, using an external lock:

```sh
/usr/bin/flock -n /home/pdfbsmxu/apps/wolfs-vault/background-jobs.lock /opt/alt/alt-nodejs26/root/usr/bin/node /home/pdfbsmxu/apps/wolfs-vault/app/scripts/run-background-jobs.js >> /home/pdfbsmxu/apps/wolfs-vault/background-jobs.log 2>&1
```

The runner loads the application `.env` from its absolute release path, checks
due releases, syncs configured HomeBank connections, recovers interrupted mail
work, awaits one mail tick and closes resources. Cron therefore works while
Passenger sleeps. Do not run this job without its lock or start another mail
worker against the same database. Inspect/rotate its private log as needed.

The verified hosting proxy reaches Node over loopback and appends the real
client address to `X-Forwarded-For`; production uses `TRUST_PROXY=loopback`.
Direct standalone deployments leave `TRUST_PROXY` empty. Do not trust all
forwarded hops. Domain HTTPS uses the account's automated certificate service.

## Cutover and future releases

Prepare dependencies using a harmless temporary startup file before supplying
live data. Starting the real application opens/migrates SQLite and initializes
beneficiary wishes. A background job can immediately process an overdue release;
disabling email transport alone does not pause that policy.

At cutover, stop the old local backend and all of its workers. Transfer the
consistent current database, matching keys, notification secret and managed files
privately. Preserve account IDs, beneficiaries, grants, wishes, document links,
mail state and saved HomeBank institution allocations. Update the saved encrypted
HomeBank connection to the production directory and `current.xhb`, preserving
its other settings. Verify file checksums, decryption, SQLite integrity and
foreign keys before selecting `server/index.js` as the Passenger startup file.
Do not apply restore quarantine during a current-state migration.

The local service then serves frontend assets and proxies API traffic to
production, with no local database or mail worker. A separate local user timer
forwards completed HomeBank source saves using the FTPS helper. An offline local
computer cannot forward newly saved files; production retains its last validated
source until the next successful transfer.

Future code deployments preserve production `data/`, private `.env`, uploads and
source files. Install dependencies for the target host, verify the native binding,
run synthetic checks, then restart the web process. Keep one authoritative
database throughout; do not synchronize SQLite files between computers or replace
current production data with an older local copy.
