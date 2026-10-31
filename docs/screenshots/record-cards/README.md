# Record card browser evidence

All records are synthetic. These captures do not read the configured vault,
HomeBank files, or personal documents. Example names, providers and values are
fully invented in-memory test data, separate from the supplied private design
references.

| View | Before | After |
| --- | --- | --- |
| Desktop 1440px | [Before](baseline-chromium-retirement-reference-dark-1440.png) | [After](after-chromium-retirement-reference-dark-1440.png) |
| Tablet 820px | [Before](baseline-chromium-retirement-reference-dark-820.png) | [After](after-chromium-retirement-reference-dark-820.png) |
| Phone 390px | [Before](baseline-chromium-retirement-reference-dark-390.png) | [After](after-chromium-retirement-reference-dark-390.png) |
| Narrow phone 320px | [Before](baseline-chromium-retirement-reference-dark-320.png) | [After](after-chromium-retirement-reference-dark-320.png) |

The directory also includes light-theme captures, long populated records,
enlarged text, 200% zoom reflow, and WebKit evidence. Baseline captures were made
from an isolated copy of `public/` before the code changes.

- [Chromium acceptance report](after-report.json)
- [WebKit acceptance report](system-webkit-report.json)
- [Baseline capture report](baseline-report.json)
- [Design QA](../../../design-qa.md)

The supplied reference images, brief and combined visual comparisons contain
personal account details and are kept locally, outside Git.

Re-run with an installed external Playwright package (not a production dependency):

```sh
PLAYWRIGHT_PACKAGE_PATH=/absolute/path/to/playwright \
RECORD_CARDS_OUTPUT_DIR=docs/screenshots/record-cards \
RECORD_CARDS_TEST_SYSTEM_WEBKIT=1 \
node scripts/test-record-cards-browsers.js
```

The optional WebKit runner requires the host's existing PyGObject, GTK 3 and
WebKit2 4.1 bindings. Set `RECORD_CARDS_TEST_SYSTEM_WEBKIT=0` for Chromium only.
Browser-chrome zoom, physical devices and screen-reader applications were not
tested; reports distinguish those from engine-based reflow and semantic checks.
