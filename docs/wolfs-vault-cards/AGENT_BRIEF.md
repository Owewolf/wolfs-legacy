# Wolf's Vault — Universal Account Card Redesign

**Developer-agent implementation brief — web application**  
**Status:** Implemented; see `IMPLEMENTATION.md` for scope, verification, and evidence  
**Reference assets:** `approved-redesign.png` (target appearance), `original.png` (existing appearance)  
**Primary goal:** Make account information dominant and the call-to-action controls secondary, without removing any existing data or functionality.

## 1. Agent assignment

Act as the senior **web UI engineer** responsible for improving Wolf's Vault's data-entry/account cards. Examine the actual repository and identify how account/record cards are rendered before changing code. Implement a reusable, responsive **web card pattern** inspired by the accompanying approved mockup. Keep the site's existing frontend framework, routing, component conventions, and CSS/theming approach; **do not migrate frameworks or add an unnecessary UI framework** to achieve this visual change. The result must work in modern desktop, tablet, and mobile **web browsers**.

**Non-negotiable:** This is a presentation/layout refactor. Preserve backend APIs, persistence, account groupings, HomeBank integration, values, permissions, existing routes, and the current edit/document/delete behaviors. No data migration, data deletion, renamed account categories, or unrelated feature work is authorized.

**Delivery scope:** Existing Wolf's Vault **web application only**. Responsive layout for mobile web browsers is included; separate mobile-app implementation is not part of this task.

## 2. Problems in the existing UI

- Large `Edit`, `Documents (0)`, and red `Delete` controls occupy the upper-right area of each card and compete with the record name and details.
- Controls are visually more dominant than the data itself.
- Cards need a consistent visual hierarchy across record types and browser viewport sizes.
- Record details are spread across a wide space, while actions interrupt the information header.

## 3. Required card anatomy (top to bottom)

### A. Header — record identification

- Place a **small contextual icon BEFORE the account/record name**, within a softly colored circular or rounded container (approximately 36–40 px visually).
- Keep the name prominent, using a medium-bold/six-hundred weight typographic style.
- A subtle account-type chip may follow the name, as illustrated, but must not replace existing account-type data.
- Use **generic category icons** (for example, cryptocurrency, financial institution, investment), selected from a consistent icon system. Do not infer institution branding, add unlicensed logos, or assign misleading status icons.
- **Do not put `Edit`, `Documents`, or `Delete` in the header.**

### B. Body — existing account details

- Preserve **every field already displayed**, including conditional fields; never manufacture missing data.
- Use a simple label/value presentation: small muted labels, readable brighter values, consistent line-height and spacing.
- At wide widths, present detail groups in **two responsive columns** with balanced gaps. At narrow widths, use **one column** with a predictable reading order.
- Keep the existing labels and meaning, including `PROVIDER / EMPLOYER`, `HOMEBANK GROUP`, `ACCOUNT TYPE`, `UNDERLYING ACCOUNT / INVESTMENT TYPE`, and `APPROXIMATE VALUE` where present.
- Preserve the original stored currency values and numeric precision. Formatting may be locale-aware, but must not change amounts, convert currencies, or imply live balances.
- Do not hide or collapse data merely to make the cards shorter.

### C. Footer — compact actions

- Put a fine separator between the details and actions.
- Move **all three existing actions to the bottom of each individual card**.
- Footer alignment at wider browser widths: `[pencil Edit]  [file Documents (count)]` aligned left and `[trash Delete]` aligned right.
- Make controls visually compact (approximately 32–36 px visible height and concise horizontal padding), with small icons and restrained label sizes. Maintain adequately sized clickable and tap-friendly hit areas (target **44 × 44 CSS pixels** where practicable), even when the visible controls look smaller.
- `Edit` and `Documents` should be low-emphasis dark/outlined controls. `Delete` should be a **subtle red outline/text treatment**, NOT a large solid-red block.
- On small screens, allow the footer controls to wrap or reorganize cleanly while keeping `Delete` separate and avoiding overflow, tiny touch targets, or accidental taps.
- Retain the existing confirmation and authorization checks for deletion; if a confirmation is currently absent, ensure a confirmation is presented before destructive action. Never delete on the first accidental tap.
- `Documents (0)` must display the real count and open the same record's existing document management flow.

## 4. Page-level design

- Keep the dark visual theme, overall Wolf's Vault navigation, `Retirement Accounts` heading, search control, and page-level `+ Add Entry` behavior.
- Do not move `+ Add Entry` into every card. It stays a distinct page-level primary action.
- Cards use a dark slate/charcoal surface, subtle outline, modest corner radius, consistent inset padding, and gentle separation from the page background. Avoid distracting gradients or overly deep shadows.
- The account icon supplies a small accent; the **card content and values remain the visual priority**.
- The approved image shows the desired hierarchy; it is **a visual reference, not authorization to add new functionality**. For example, an optional descriptive subtitle in the mockup is not a required new field or feature.

## 5. Universal/reusable implementation

Find the existing shared card components and section-specific renderers. Prefer **one presentational card pattern with configurable data fields and actions**, rather than creating a retirement-only card or duplicating markup across sections.

Suggested TypeScript contract (adapt to the repository's conventions; this is illustrative, not a compulsory API):

```ts
type DetailField = {
  key: string;
  label: string;
  value: string | number | null | undefined;
};

type RecordCardProps = {
  id: string;
  title: string;
  categoryIcon?: string;
  categoryLabel?: string;
  fields: DetailField[];
  documentCount: number;
  onEdit: () => void;
  onDocuments: () => void;
  onDelete: () => void;
  canEdit?: boolean;
  canDelete?: boolean;
  isBusy?: boolean;
};
```

**Web implementation guidance:**

- Build on the site's **existing web UI framework**. If it uses React, implement reusable React components; if it uses another approach, use the equivalent established component structure. Do not introduce a new rendering framework.
- Use semantic web markup: an appropriately structured card container, readable headings and detail groups, and real `<button type="button">` elements for actions. Avoid clickable non-button elements.
- Use the application's existing CSS methodology, theme variables, and spacing tokens. Prefer **CSS Grid** for the responsive detail grid and **Flexbox** for the card header/footer. Scope styles to the component to prevent regressions.
- Use the existing icon library and ensure icons have consistent sizing and alignment. Do not add a heavyweight dependency solely for these icons.
- Separate data mapping from visual rendering. Reuse existing edit, document, and delete handlers rather than rewriting service or network operations.
- Avoid hard-coded account names, colors, balances, document counts, or labels in the reusable component. Derive them from live record data and existing display rules.
- Omit optional fields using existing display logic; never render empty label-only rows or invent placeholder values.
- Ensure actions are available without hover and fully operable via keyboard and screen reader. Provide clear focus states, accessible names, and meaningful disabled/loading states.

## 6. Responsive behavior

| Display | Header | Details | Footer |
| --- | --- | --- | --- |
| Wide desktop browser (approximately ≥ 900 px) | Icon, name, subtle chip | Two columns | Small Edit/Documents left, Delete right |
| Mid-size browser/tablet (approximately 600–899 px) | Same hierarchy, flexible wrapping | Two columns only where readable | Responsive spacing; wrap if required |
| Narrow mobile browser (approximately 320–599 px) | Icon and name with safe line wrapping | One column | Compact, accessible bottom actions; no horizontal scroll |

These are guidance thresholds, not rigid breakpoints; follow the website's existing breakpoint system. Cards must accommodate long account names, large ZAR values, browser zoom (including 200%), text resizing, and narrow viewports without clipping or horizontal scrolling.

## 7. Reference content and data integrity checks

The supplied screenshot contains three examples. Preserve each record's actual values; never use the screenshot to seed, overwrite, or recalculate the database:

- **Luno Crypto:** Provider `Wolf's Estate`; HomeBank group `Retirement Annuity`; account type `Annuity`; underlying type `Cryptocurrency`; approximate value `ZAR 17618.54`.
- **Investec CCM:** Provider `Citadel`; HomeBank group `Retirement Annuity`; account type `Annuity`; approximate value `ZAR 661491.98`.
- **Citadel:** Provider `Citadel`; HomeBank group `Retirement Annuity`; account type `Annuity`; underlying type `Other`; approximate value `ZAR 11892970.98`.

The screenshot examples are **visual/test references only**, not instructions to modify persisted data.

## 8. Execution sequence for the development agent

1. **Inspect:** Identify existing web card components, their uses across sections, styling tokens, actions/permissions, and responsive breakpoints. Note architectural constraints.
2. **Implement:** Introduce/rework a reusable card layout with the header icon, detail grid, subtle divider, and compact footer actions. Keep existing handlers and route bindings intact.
3. **Integrate:** Apply the new visual pattern to the Retirement Accounts list first; use it for other comparable account/record cards through the shared component where schemas and behaviors permit. Record any exceptions rather than silently altering data schemas.
4. **Verify:** Test view, edit, documents, delete confirmation, keyboard/screen reader access, and responsive browser layouts at desktop, tablet, and phone widths. Check loading, empty, permission-restricted, and error states.
5. **Document:** Produce a before/after summary, changed-file list, browser screenshots at phone/tablet/desktop widths, test results, and unresolved issues. Update existing project design/agent documentation if appropriate.

Do not make unrelated navigation, account model, HomeBank synchronization, or server changes as part of this task.

## 9. Acceptance criteria — all must pass

- [ ] A small, contextually suitable icon is placed before every rendered card title.
- [ ] Account/record name and information visually dominate, not action buttons.
- [ ] `Edit`, `Documents (count)`, and `Delete` appear **only in the footer** of each applicable card.
- [ ] Buttons are smaller than the originals; Delete is restrained and never a large solid-red call to action.
- [ ] Document counts, target record IDs, and all existing handler behavior remain correct.
- [ ] All previously visible information is still present, correctly labeled and unmodified.
- [ ] Each card maintains a clear visual boundary and balanced spacing.
- [ ] Desktop/tablet browser layouts are efficient; narrow mobile browser viewports have no clipped fields/actions or horizontal scrolling.
- [ ] Touch targets, focus visibility, keyboard operation, contrast, and accessible names are verified.
- [ ] Existing delete permissions and confirmations are respected.
- [ ] The styling is reusable for equivalent cards across Wolf's Vault without copy-pasted section-specific styling.
- [ ] No migrations, API changes, HomeBank sync changes, unintended deletions, or numerical data changes occur.

## 10. Definition of done and deliverables

Submit the code changes plus:

- A concise change log with implementation files and any reusable components introduced.
- Before/after screenshots for desktop and narrow-browser layouts (tablet width recommended).
- A test checklist with pass/fail notes for the acceptance criteria.
- A clear note of any remaining browser-specific limitations or exceptions.

**Final design rule:** **The record is the focus. Actions belong at the bottom of the record, appear small and consistent, and should never visually overpower the data.**
