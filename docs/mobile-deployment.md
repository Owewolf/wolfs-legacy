# Mobile layout deployment — 29 October 2026

Applied the responsive frontend at **12:37 SAST** to the existing local-network service.

| Item | Verified result |
| --- | --- |
| Runtime revision | `edf23cbfcd3c24656bfc57bff2992ce34555796f` |
| Previous revision | `8a8be54377ef3deb867a85ec33a941e700f16000` |
| Local URL | `http://asus.local:4444` |
| Wi-Fi hostname advertisement | Avahi resolves `asus.local` to `192.168.31.96` on `wlo1` |
| Service | `wolfs-legacy.service` remains active; PID `774232` unchanged |
| Health | `/health` returns `ok` through loopback and the hostname; uptime did not reset |
| Frontend assets | HTML, three JavaScript assets and four CSS assets match the deployed source byte for byte |
| Live checkout | Clean, detached at the runtime revision |

No service restart, backend or dependency update, migration, database restore, environment change or firewall change was performed. Existing clients need to refresh to load the new frontend. The running app remains on the runtime revision above; subsequent deployment documentation commits do not change its assets.

The pre-update public source archive and private verification record are in `/home/wolf/backups/wolfs-legacy/pre-mobile-20261029T103715Z/` (directory mode `0700`, files `0600`). The record contains the before/after health results, process ID and asset hashes. It contains no database backup. For a frontend rollback, restore the previous source revision after confirming the live checkout is clean; do not restore an older database for this layout change.

Validation before deployment: **198 Node tests and 4 Python tests pass**. Chromium and WebKit cover ten screens at nine widths, with final dark/light and landscape workflows; Firefox covers the phone and tablet workflows. All 40 desktop before/after screenshot pairs at 1280px and 1440px are identical. Tests and screenshots use synthetic records. Physical iOS/Android picker sheets, software keyboards, safe areas and media codec decoding still require device testing.

See [layout scope](mobile-layout.md), [browser evidence](screenshots/mobile/README.md) and [PR #3](https://github.com/Owewolf/wolfs-legacy/pull/3).
