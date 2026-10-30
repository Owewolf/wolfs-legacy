# Wolf's Legacy — Complete Downloadable Icon Package

This package establishes an application-wide visual identity based on the **wolf mascot in round glasses and a green hoodie** supplied for Wolf's Legacy. The glasses have ordinary reflections and **no cannabis imagery**. The logo variants combine the mascot with a shield / vault visual language.

## What's included

- **Brand artwork:** four high-resolution mascot/crest PNGs, including a genuine transparent mascot PNG.
- **Brand app icons:** full-bleed 1024×1024 PNGs for primary, dark and light visual treatments; these have **no pre-rounded outer corners** and work for app-store masking.
- **Small-size brand symbol:** editable standalone SVG (`brand/wolf-glasses-minimal.svg`) and PNGs at 32–1024 px. Use this where the detailed mascot would be illegible.
- **Wordmarks:** two transparent raster lockups for light/dark backgrounds.
- **iOS:** 13 commonly useful app icon sizes, including 1024 px and 180 px; use your Xcode asset catalog's assigned slots.
- **Android:** legacy launcher icons at mdpi–xxxhdpi and adaptive foreground/monochrome/background files at mdpi–xxxhdpi, plus a sample adaptive icon XML. Add these to Android `res/` folders as appropriate. Android adaptive icon safe-area composition is conservative but **check on your target launchers**.
- **Web/PWA/Desktop:** 16–512 px icons, PWA maskable variants, Apple touch icon, favicon PNGs and ICO, and an example web manifest.
- **UI icons:** 41 native editable **SVG vector** icons, including the 14 sections currently defined in the upstream `public/js/sections.js`, application controls and an **optional Pet Care** icon (listed in the README but not in the inspected section definitions). Each icon has `currentColor`, heritage gold, charcoal and parchment SVG styles, plus 24/48/96 px PNG exports of the three fixed-colour styles.
- **`catalog.html`:** a browsable, offline catalogue of the entire UI icon set.
- **`previews/complete-icon-catalogue.png`:** a convenient icon contact sheet.

## Palette

| Token | Hex | Usage |
|---|---|---|
| Charcoal | `#1F2A30` | Text, navigation, surfaces |
| Deep forest | `#122821` | App icon background and premium surfaces |
| Heritage gold | `#C7A46B` | Icon strokes and highlights |
| Parchment | `#F4F0E8` | Light background and light strokes |
| Sage | `#60736B` | Secondary accents |

## Quick integrations

### React / HTML

```html
<img src="/icons/vault/bank-accounts.svg" width="24" height="24" alt="Bank Accounts" />
```

Copy the files under `ui/svg/heritage-gold/` or `ui/svg/currentColor/` into your public assets. Use `currentColor` SVGs inline or loaded with an SVG-capable component system if you want inherited stroke colour. An external `<img>` generally **does not inherit CSS `color`** from its parent.

### Android

Copy the `app/android/mipmap-*` directories and `app/android/drawable` into your Android resource directory as appropriate. The adaptive icons are XML-based; check the `res/mipmap-anydpi-v26/ic_launcher.xml` references if your app has different resource names.

### iOS

Use `app/ios/AppIcon-1024.png` as the 1024px master image; populate the AppIcon asset set with the other sizes according to Xcode's actual requested slots. Do not apply a rounded mask: iOS does that itself.

### Web manifest

`app/web/site.webmanifest` is a starter example and assumes the icons are exposed at `/icons/` on your web server; adjust the URLs to match your deployment. Make sure maskable icons provide safe margins as required by your PWA tooling.

## Asset formats and important limitations

- Brand illustrations are **raster PNGs** derived from the generated mascot artwork. They are *not* editable SVG vectors. Only the hand-built minimal wolf mark and UI/navigation icons are true SVG vector paths.
- Detailed mascot artwork may be illegible at favicon sizes; use `app/web/favicon.ico` or the minimal-wolf icon at very small sizes.
- This is a **graphic asset pack**, not a deployed code change to the Wolf's Legacy application.
- The category set is based on the public reference repository `slavhate/legacy-vault`, inspected on 29 October 2026. Feature coverage may differ from your modified Wolf's Legacy branch.
- Source reference: https://github.com/slavhate/legacy-vault . User-provided mascot artwork guided the distinctive character identity.
