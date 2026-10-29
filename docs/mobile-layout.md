# iOS and Android browser layout

The mobile layout adapts the existing Wolf's Legacy browser app for phone and tablet screens on the same local network. It uses the same URL, accounts, beneficiary tokens and APIs. It does not require installing a native app or publishing personal information to another service.

## Scope

At widths up to 1024 CSS pixels, a compact header and searchable navigation drawer replace the long sidebar above the content. Forms use readable text and touch-sized controls; cards/actions wrap within the viewport. Larger screens retain the existing desktop layout and original stylesheets. This is responsive layout rather than user-agent detection, so rotating a device or resizing a window remains predictable.

The drawer supports focus trapping, inert background content, Escape, backdrop taps, browser Back and back/forward-cache restoration. Native field colors follow the selected light/dark theme. Safe-area insets protect headers, the drawer and dialogs around notches/home indicators. Visual viewport sizing keeps dialogs and error messages within the visible area when a browser reduces it for a keyboard.

Final Wishes editors, recipient controls, beneficiary cards, HomeBank balances/tables, account settings, notifications and the beneficiary portal have compact layouts. Wide tables scroll inside their own regions. No global horizontal clipping hides data. File selection still uses the existing native picker and managed-copy flow.

Videos have native inline controls and no autoplay; PDF previews offer explicit browser Open/Save actions on mobile. Export options wait for a fresh tap to open or save a protected blob, avoiding delayed popup blocking. Download URL cleanup allows the browser to finish handing the file to its download/viewer process. These changes add no public file URLs, remote assets or offline cache of personal content.

## Desktop preservation and verification

The desktop stylesheets remain unchanged. The new styles apply only at widths up to 1024px, apart from hiding the new compact-only controls before initialization. Before/after screenshots in Chromium and WebKit at 1280px and 1440px are byte-identical for all ten captured screens: **40 identical pairs**.

The optional full browser matrix checks ten screens at 320, 360, 390, 412, 768, 820, 1024, 1280 and 1440 CSS pixels in Chromium and WebKit. It verifies viewport fit and readable field sizing, with additional dark/light and compact landscape runs. The primary `npm test` suite includes exact-width Firefox phone/tablet workflows alongside the existing email, permissions, documents and HomeBank tests.

The final full suite passes **198 Node tests and 4 Python tests**. Each Firefox compact workflow performs 55 checks, with the same workflows also exercised in Chromium and WebKit.

See the [browser report and synthetic screenshots](screenshots/mobile/README.md) for measured results, reproducing the matrix, and what remains a physical-device check. Native picker sheets, real software keyboards, notch behavior and particular media codecs are not established solely by desktop engine tests. Existing upload formats and server validation remain unchanged; this update does not introduce HEIC conversion or media transcoding.

Compatibility decisions follow [WebKit safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/), [WebKit inline-video behavior](https://webkit.org/blog/6784/new-video-policies-for-ios/), [dynamic viewport support](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/) and [Chrome's keyboard/visual viewport behavior](https://developer.chrome.com/blog/viewport-resize-behavior/).

## Deployment

Only public frontend assets, browser tests and documentation change. No backend, application dependency, database, permissions, release rules, email worker, network binding or firewall setting changes are required. Static assets can be applied to the existing service without restarting it; existing clients should refresh to load the updated layout. Preserve the previous source revision for rollback and verify the public assets and `/health` after cutover.

The [29 October deployment record](mobile-deployment.md) records the applied revision, live checks and rollback source archive.
