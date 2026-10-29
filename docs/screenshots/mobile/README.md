# Mobile browser validation

Verified on 29 October 2026. Every record, token, document and recording in these screenshots is synthetic. The browser fixture serves the real frontend on an ephemeral loopback port and replaces API responses. It never connects to the running vault or its database.

## Results

| Check | Result |
| --- | --- |
| Chromium 138 and system WebKitGTK 2.52 | Ten screens at 320, 360, 390, 412, 768, 820, 1024, 1280 and 1440 CSS pixels; 180 screenshots; no document overflow |
| Desktop at 1280 and 1440 CSS pixels | All 40 screenshot pairs are byte-identical to the pre-change frontend in the default dark theme |
| Final dark and light themes | Both engines rerun at 390 and 820 CSS pixels after the final compact layout refinements; 80 additional screenshots; native WebKit selects visually checked for readable text |
| Firefox at 390 and 820 CSS pixels | 55 browser workflow checks per width, included in `npm test` |
| Chromium and WebKit workflows | The same final 55 checks in both themes; Chromium also checks an open drawer resizing to desktop and back |
| Landscape at 820 × 390 CSS pixels | Both engines pass all ten screens and the final workflows at the actual reduced height; 20 screenshots |

The workflow checks cover navigation focus, inert background content, Escape, backdrop taps, browser Back, search history, back/forward-cache restoration, entry saving, private draft defaults, native file selection into the managed copy queue, beneficiary dialogs, HomeBank tables, email state, exports, protected recipient checklists, private blob URLs, PDF Open/Save actions, inline video controls and cleanup on navigation. Reduced visual viewport variables are simulated to verify that dialogs, action buttons and feedback remain reachable.

[Full matrix and desktop hashes](browser-matrix.json), [final dark theme checks](final-dark-workflows.json), [final light theme checks](final-light-workflows.json) and [landscape checks](final-landscape.json) contain the detailed results. The full matrix preceded the final compact-only native color-scheme and back/forward-cache refinements; the focused reports exercise those final changes.

These are real browser engine checks on Linux, rather than physical iOS or Android device tests. Native picker sheets, actual on-screen keyboards, notches and media decoding still need a device check. The synthetic media verifies private preview elements and inline controls, not codec support. Firefox uses an exact-width same-origin frame because its desktop window enforces a 500px minimum width. WebKit screenshots may use the host display's pixel scale; matrix widths are CSS pixels.

## Selected screenshots

| View | Before | After |
| --- | --- | --- |
| Phone dashboard | [390px](before-dashboard-390.png) | [390px](after-dashboard-390.png) |
| Final Wishes | [390px](before-final-wishes-390.png) | [WebKit dark](after-webkit-final-wishes-390-dark.png), [WebKit light](after-webkit-final-wishes-390-light.png) |

[Phone navigation](after-navigation-390.png), [letter editor](after-letter-editor-390.png), [beneficiary dialog](after-beneficiary-dialog-390.png), [export options](after-export-390.png), [HomeBank](after-webkit-homebank-390.png), [recipient view](after-webkit-recipient-390.png), [recording preview](after-webkit-recording-390.png), [tablet dashboard](after-tablet-dashboard-820.png) and [unchanged desktop Final Wishes](desktop-final-wishes-1440.png).

Landscape examples: [820 × 390 navigation](after-landscape-navigation-820x390.png) and [scrollable beneficiary dialog](after-landscape-beneficiary-dialog-820x390.png).

## Run the checks

The primary suite uses the existing system Firefox and needs no new application dependencies:

```sh
node --test tests/mobile-ui.test.js
npm test
```

The optional matrix can use a Playwright package installed outside this repository:

```sh
PLAYWRIGHT_PACKAGE_PATH=/absolute/path/to/playwright \
BROWSER_TEST_ENGINES=chromium,system-webkit \
node scripts/test-mobile-browsers.js
```

`system-webkit` uses host Python GI bindings for GTK 3 and WebKit2 4.1, with offscreen rendering. It can run by itself without Playwright. A Playwright WebKit installation can instead be selected with `BROWSER_TEST_ENGINES=chromium,webkit`.

Set `BROWSER_TEST_WIDTHS=390,820`, `BROWSER_TEST_THEME=light`, or `BROWSER_TEST_OUTPUT_DIR=/tmp/mobile-results` for a focused run. Use `BROWSER_TEST_WIDTHS=820 BROWSER_TEST_HEIGHT=390` for landscape. To compare a baseline, capture its `public` folder with `BROWSER_TEST_PUBLIC_ROOT=/path/to/baseline/public BROWSER_TEST_PHASE=baseline`, then run the changed frontend with `BROWSER_TEST_REFERENCE_DIR=/path/to/baseline-results`. Use the same engines, theme and viewport widths for both runs. Screenshots and reports default to `/tmp/wolfs-legacy-mobile-browser-results`.
