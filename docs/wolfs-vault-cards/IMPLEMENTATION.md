# Universal record cards — implementation

Implemented on 31 October 2026 in the existing plain JavaScript web application.
All vault record sections use the same presentational renderer; the design is
also shared by search previews, authorised beneficiary records, beneficiary
management, and Final Wishes personal-content lists, timelines, and detail views.

Secure Notes was retired from navigation, dashboard and new-entry routes on
31 October 2026, leaving 14 active sections. Its schema and API compatibility
remain for older records, exports and backups. The original 15-section browser
verification below records the redesign before that retirement.

Records now have a contextual category icon before the title, an optional existing
type chip, a readable detail grid, and compact actions below the information.
Edit and Documents remain left aligned; Delete/Remove/Archive stay separate on
the right and use restrained outlined controls. The visible action outline is
36px high at the normal font size, within a button at least 44px high. Narrow
footers wrap without overlapping targets. Details switch to one column at 600px.

## Files

| File | Change |
| --- | --- |
| `public/js/app.js` | Shared `RecordCards` presentation and field mapping; owner, search, beneficiary views; keyboard sensitive-field toggles; existing delete confirmation plus busy/disabled state during deletion. |
| `public/js/legacy.js` | Shared card headers and footer actions for personal-content records, retaining status, release, review and recipient workflows. |
| `public/css/record-cards.css` | Scoped theme-aware card styles, responsive grids and footers, 44px targets and visible focus. |
| `public/index.html` | Loads the shared stylesheet after existing mobile styles. |
| `public/icons/record-icons.svg` | Small local subset of Bootstrap Icons 1.13.1; no runtime dependency or external icon requests. |
| `public/icons/LICENSE-bootstrap-icons.txt` | Upstream MIT licence. |
| `tests/helpers/mobile-browser-fixture.js` | Correct SVG MIME type so browser fixtures exercise real external icons. |
| `scripts/test-record-cards-browsers.js` | Repeatable synthetic browser acceptance and screenshot capture. |

## Validation

- Full `npm test`: **238 JavaScript tests and 7 Python tests passed**.
- Focused Firefox UI checks passed for mobile owner/beneficiary workflows at
  390px and 820px and protected Final Wishes authoring/release/review flows.
- Chromium: **3,871 assertions**, all 15 sections, dark/light themes, 320, 390,
  820, 1122 and 1440px, plus text enlargement and zoom reflow scenarios.
- System WebKitGTK: **61 assertions** at 390px, including all 15 sections and
  real title/action SVG rendering. Total new browser assertions: **3,932**.
- No uncaught JavaScript errors in the captured Chromium matrix. SVG responses
  and actual rendered icon geometry are checked, not just icon markup.
- Source/screenshot visual comparison: [design QA](../../design-qa.md).

## Acceptance checklist

| Requirement | Result |
| --- | --- |
| Contextual icon before record title; data is prominent | Pass; shared headers across record types. |
| Owner Edit, Documents and Delete only in each record footer | Pass; all 15 section schemas checked. |
| Compact controls and restrained destructive action | Pass; rendered targets at least 44px; visible outlines are smaller. |
| Existing labels, conditional data, notes, values and precision retained | Pass; all schema fields checked against in-memory source data. |
| Real document counts and correct record/form IDs | Pass; zero/nonzero counts and existing document-panel route checked. |
| Responsive detail columns and long-content wrapping | Pass at all tested widths, both themes. |
| Keyboard operation, visible focus and accessible names/states | Pass in browser checks; sensitive values support Enter, Space and pointer, and the revealed value is included in the accessible name. |
| Delete confirmation and error/busy states | Pass; cancellation sends no request; failure keeps the record; pending deletion disables repeat actions. |
| Beneficiary access remains read-only | Pass; authorised data retained without owner controls. |
| Reusable styling, existing framework and existing handlers | Pass; one presentation helper and scoped stylesheet. |
| Data/schema/API/HomeBank integrity | No server, migration, service, account model or stored-data edits. Existing tests pass. |

## Existing view differences retained

Search keeps its existing first-four-field, 80-character previews and opens the
same edit route through an explicit footer button. It does not gain delete or
document management actions. Sensitive previews now use the existing reveal
interaction with keyboard support. Authorised beneficiary values remain fully
readable, and beneficiary document download handlers and target IDs are retained.

Personal-content records keep their own release/review metadata and existing
Open, Archive, release and recipient controls. Their data does not become an
account schema. Review, attachment, and related-record controls remain within
their relevant content sections; Edit and Archive are in the record footer.

Dashboard category tiles, forms, settings/status panels and the HomeBank ledger
are distinct navigation or operational interfaces. Their established structure
and page actions remain in place. All ordinary vault entry cards, including
Final Wishes arrangements and Pet Care, receive the redesign automatically.

The existing desktop sidebar, mobile navigation, page heading and Add Entry
behaviour are retained. Flat surfaces and softer category accents follow the
brief and existing theme; the optional mockup subtitle and decorative gradients
were not added.

## Evidence and limits

[Before/after screenshots and reports](../screenshots/record-cards/README.md)
use fully invented names, providers and values in an isolated frontend fixture.
They are separate from the supplied private references and never seed a vault
database. The supplied reference images and brief remain local and excluded
from Git because they contain personal account information.

Browser zoom is covered by a 720px CSS viewport at 2x density as the reflow
equivalent of 1440px at 200%, plus separately doubled text. Browser-chrome zoom,
physical phones, native Safari, and actual screen-reader applications were not
run. Roles, accessible names/states, focus, and keyboard behaviour were checked
in real browser engines. No remaining known layout or workflow issue was found.

The update is live on the existing service; see [deployment verification](../record-cards-deployment.md).
