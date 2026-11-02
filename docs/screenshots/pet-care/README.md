# Pet Care browser acceptance

These captures and checks use invented records served by a temporary local fixture. No running vault, real owner records, real recipients, credentials or live database were accessed.

| Engine | Viewport | Passed checks |
| --- | --- | --- |
| Chromium 138.0.7204.15 | 390px | 24 |
| Chromium 138.0.7204.15 | 820px | 24 |
| Chromium 138.0.7204.15 | 1440px | 22 |
| WebKitGTK 2.52.4 | 390px | 24 |

The workflows verify the dashboard card and count, sidebar navigation, empty state, every one of the 14 pet fields, native date and telephone input types, mobile input sizes, existing managed document picker, creating and editing through the entry API, escaped text, and all pet details in the beneficiary's read-only view. Each major view is checked for horizontal document overflow. Phone and tablet workflows also use the mobile navigation drawer.

The API is a synthetic browser fixture. These checks verify frontend rendering and payloads; the server integration tests cover persistence and access control. These are Linux browser engines, not physical iOS or Android devices, and do not verify native software keyboards or picker sheets on a device.

- [Phone owner view](pet-care-owner-390.png)
- [Tablet edit form](pet-care-form-820.png)
- [Desktop owner view](pet-care-owner-1440.png)
- [Phone beneficiary view](pet-care-beneficiary-390.png)
- [Machine-readable results](report.json)

Run from the repository root with Playwright installed outside production dependencies:

```sh
PLAYWRIGHT_PACKAGE_PATH=/absolute/path/to/playwright node scripts/test-pet-care-browsers.js
```

Results default to `/tmp/wolfs-vault-pet-care-browser-results`; set `PET_BROWSER_OUTPUT_DIR` to change it. The host WebKitGTK runner requires the existing PyGObject/GTK3/WebKit2 4.1 bindings. Set `PET_TEST_SYSTEM_WEBKIT=0` to run only Chromium.
