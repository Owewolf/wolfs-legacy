# HomeBank classification and form acceptance

All records, institutions, amounts and account identifiers in these captures are invented. The optional runner serves the real frontend from a temporary loopback server and replaces API calls with synthetic responses. It never opens the running vault, its database, or the configured HomeBank file.

The checked-in [report](report.json) records 139 successful checks: Chromium at 390px (35), 820px (35), and 1440px (34), plus system WebKit at 390px (35). All views fit their viewport and Chromium emitted no unhandled browser errors.

The workflows verify separate source vehicle valuation and owner loan details; read-only checking type, provider and group; retirement annuity classification with editable underlying investment and beneficiary; redirecting an obsolete bank edit URL to the current retirement form; preserving an open owner draft when polling discovers a changed category; retaining undisplayed owner fields on save; and landing in the category returned by the save response. Server classification and field mapping are tested separately by the Node suites; the browser fixture emulates that API contract.

| Capture | Viewport | Purpose |
| --- | --- | --- |
| [Vehicle form](vehicle-form-390.png) | 390px | Source current value and separate owner loan fields |
| [Classification notice](classification-change-390.png) | 390px | Open bank draft preserved after source becomes retirement |
| [Retirement form on tablet](retirement-form-820.png) | 820px | Annuity, source group/provider and underlying investment |
| [Retirement form on desktop](retirement-form-1440.png) | 1440px | Existing desktop layout with correctly allocated fields |

Transient success toasts are dismissed and the page is scrolled to the top for captures. These are Linux browser engines, not physical iOS or Android device tests. Native keyboards and device-specific browser chrome remain untested.

To reproduce with an independently installed Playwright package and the host's existing GTK/WebKit bindings:

```sh
PLAYWRIGHT_PACKAGE_PATH=/path/to/node_modules/playwright \
  node scripts/test-homebank-alignment-browsers.js
```

Results default to `/tmp/wolfs-vault-homebank-alignment-browser-results`. Set `HOMEBANK_ALIGNMENT_BROWSER_OUTPUT_DIR` to change that path, or `HOMEBANK_ALIGNMENT_TEST_SYSTEM_WEBKIT=0` to omit the optional system WebKit run. No production dependencies are added.
