# Universal record card deployment

Verified on **31 October 2026 at 12:37:48 SAST (UTC+02:00)**.

| Item | Verified result |
| --- | --- |
| Application | `http://asus.local:4444` |
| Runtime revision | `8ec155a8aea18c30afe175364fd40f3cb4d30c55` |
| Previous source revision | `4088ca2c89c632f1036d2da198e95762c0382ce3` |
| Branch | `feature/universal-record-cards` |
| Service | `wolfs-legacy.service`, active/running, PID `2005` unchanged |
| Health | `/health` returns `ok` over loopback and `asus.local` |
| Assets | HTML, app/legacy JavaScript, shared card CSS and icon sprite match the committed source byte for byte on both origins |
| SVG | Served as `image/svg+xml`; icons render in the live browser check |
| Unauthenticated vault endpoint | `/api/vault/entries` rejects requests with HTTP 401 |

This frontend update is served directly from the existing checkout by Express
static middleware. No service restart was needed. No backend, dependency,
migration, database, private configuration, key, HomeBank or notification-worker
change was performed. Existing clients should refresh to load the new frontend.

A fresh isolated Chromium context loaded the live login page and rendered a
browser-only invented record at 390px and 1440px using the actual served helpers,
CSS and SVG sprite. The icons, footer controls, keyboard reveal/accessibility
name and viewport fit passed with no script errors. No authenticated session or
production record write was used. These checks supplement the isolated full
suite (238 JavaScript and 7 Python tests) and 3,932 Chromium/WebKit browser checks.

The previous public source archive and private asset/browser verification
records are retained at:

`/home/wolf/backups/wolfs-legacy/pre-record-cards-20261031T103625Z/`

This is a source-only frontend rollback archive, not a database backup. Reverting
this layout requires the previous public sources; it does not require restoring
a database. The supplied brief/reference images and combined comparisons contain
personal account details and remain local, excluded from Git. Committed browser
evidence uses fully invented example names, providers and values.

See [implementation details](wolfs-vault-cards/IMPLEMENTATION.md) and
[before/after browser evidence](screenshots/record-cards/README.md). A subsequent
documentation commit records this deployment without changing the runtime assets.
