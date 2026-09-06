---
version: "alpha"
name: "Eidolon Atlas"
description: "A warm, private personal archive with editorial typography and quiet, structured workspace interactions."
colors:
  primary: "#282b27"
  on-primary: "#fcf9f2"
  secondary: "#666a61"
  tertiary: "#9b583b"
  tertiary-dark: "#783d29"
  tertiary-container: "#ead2c2"
  positive: "#667763"
  positive-container: "#dbe3d4"
  danger: "#a34035"
  neutral: "#f4efe5"
  neutral-deep: "#e9dfcf"
  surface: "#fcf9f2"
  outline: "rgba(58, 56, 47, .14)"
  outline-strong: "rgba(58, 56, 47, .24)"
typography:
  display-lg:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "3.5rem"
    fontWeight: "500"
    lineHeight: "1"
    letterSpacing: "-0.045em"
  display-md:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "2rem"
    fontWeight: "500"
    lineHeight: "1.05"
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "1.08rem"
    fontWeight: "600"
    lineHeight: "1.25"
    letterSpacing: "-0.015em"
  body-md:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.84rem"
    fontWeight: "400"
    lineHeight: "1.55"
  body-sm:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.77rem"
    fontWeight: "400"
    lineHeight: "1.55"
  label-caps:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.7rem"
    fontWeight: "760"
    lineHeight: "1.2"
    letterSpacing: "0.13em"
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8rem"
    fontWeight: "700"
    lineHeight: "1.3"
rounded:
  sm: "8px"
  control: "10px"
  md: "14px"
  lg: "24px"
  feature: "30px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  page: "clamp(1rem, 4vw, 3.2rem)"
components:
  page:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
  sidebar:
    backgroundColor: "rgba(237,229,216,.76)"
    width: "248px"
  sidebar-copy:
    textColor: "{colors.secondary}"
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.62rem 0.95rem"
    height: "39px"
  button-primary-hover:
    backgroundColor: "{colors.tertiary-dark}"
  button-secondary:
    backgroundColor: "rgba(255,255,255,.5)"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.62rem 0.95rem"
    height: "39px"
  button-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
  card:
    backgroundColor: "rgba(252,249,242,.66)"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: "1.15rem"
  card-accent:
    backgroundColor: "{colors.tertiary-container}"
    textColor: "{colors.tertiary-dark}"
    rounded: "{rounded.control}"
  filter-chip-active:
    backgroundColor: "{colors.positive}"
    textColor: "{colors.on-primary}"
    rounded: "20px"
  callout-positive:
    backgroundColor: "rgba(219,227,212,.45)"
    rounded: "11px"
  positive-text:
    textColor: "{colors.positive}"
  input:
    backgroundColor: "rgba(255,255,255,.52)"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.control}"
    padding: "0.76rem 0.82rem"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "20px"
  outline:
    backgroundColor: "{colors.outline}"
  outline-strong:
    backgroundColor: "{colors.outline-strong}"
  status-warning:
    backgroundColor: "{colors.tertiary-container}"
    textColor: "{colors.tertiary-dark}"
  status-positive:
    backgroundColor: "{colors.positive-container}"
  status-danger:
    backgroundColor: "rgba(163,64,53,.09)"
  page-depth:
    backgroundColor: "{colors.neutral-deep}"
---

## Overview

Eidolon Atlas is a calm, private personal archive rather than a productivity dashboard. Its identity combines warm paper surfaces, editorial serif display text, muted natural accents, and quiet depth. Information should feel collected and durable; privacy, backup, and destructive actions should feel sober and explicit.

The interface prioritizes structured reading over visual spectacle. Cards, lists, and controls remain compact, while large headings and generous page gutters provide the breathing room. The visual language remains stable from authentication to the record workspace, settings, and knowledge graph.

## Colors

The foundation is warm paper (`neutral`) with deep, almost charcoal-green ink (`primary`). Use copper (`tertiary`) for primary action, active navigation, and focused interaction; use its pale container for low-emphasis copper surfaces. Sage (`positive`) denotes constructive status, goal progress, and active filters. Reserve `danger` for irreversible actions and errors.

Surfaces should be translucent cream or white with thin, low-contrast ink outlines. Borders establish hierarchy before shadows do. The background may use a soft radial highlight and faint abstract circles, but those ambient elements must never reduce contrast or compete with content.

Category-specific accents come from the `CATEGORIES` metadata in `public/app.js`. They may color an icon tile, card rule, or local label, but they do not replace the semantic system colors above.

## Typography

Use the serif display styles for product identity, page titles, record titles, selected section titles, and spacious empty states. Use the sans styles for all controls, form labels, body copy, metadata, and navigation. The pairing should read as personal and editorial, not ornamental.

Use `label-caps` for small contextual eyebrows: copper, uppercase, and widely tracked. Supporting copy should use `body-md` or `body-sm` in secondary ink. Monospace is reserved for API methods, paths, and schema data.

Do not introduce a third visual typeface for ordinary product UI. Do not make body copy use display typography.

## Layout

On desktop, the shell has a fixed 248px sidebar and a flexible workspace. The workspace contains a sticky 70px top bar for global search and the primary create action, followed by a centered content area capped at 1440px. Page padding uses the `page` spacing token.

Selected records usually open in a 390px detail pane on the right; the workspace adds matching right padding so the pane does not simply cover content. Specialized full-page views retain the same heading, action, and reading hierarchy.

Use layouts that reveal the content structure:

- Experiences use a vertical timeline.
- Goals use short-, middle-, and long-horizon columns and a progression graph in detail.
- Relationships begin with a category grid.
- Person uses a profile feature card and structured sections.
- Knowledge uses an expandable hierarchy beside a reading pane.
- Projects, resources, and interests use standard card or list views.

At 800px and below, the sidebar becomes an off-canvas panel with a scrim, the top bar becomes 62px, and the detail pane overlays the right edge. At 560px and below, grids and forms collapse to a single reading column. Preserve horizontal scrolling for structures where comparison matters, especially goal horizons and progression graphs.

## Elevation & Depth

Use light translucent surfaces, thin outlines, and soft warm shadows. Standard cards use the small shadow; authentication and modal surfaces use the large shadow. Backdrop blur is appropriate for the sidebar, sticky top bar, authentication card, modal backdrop, and detail pane because it reinforces layered paper surfaces.

Depth communicates state: cards lift slightly on hover, the detail pane slides from the right, and dialogs sit above a blurred dimmer. Do not use heavy shadows, hard black overlays, glassy gradients, or decorative depth on every component.

## Shapes

Use `control` rounding for buttons, inputs, icon buttons, list rows, filter chips, and small status containers. Use `md` for standard cards and `lg` for empty states and feature panels. The authentication card may use the `feature` radius.

Keep corners soft but restrained. A component should not gain an unusual radius merely to look more decorative.

## Components

Primary buttons are copper with warm off-white text. They rise one pixel on hover, darken to `tertiary-dark`, and compress subtly on press. Secondary buttons have a translucent light surface and visible outline. Quiet and icon buttons have no persistent container; their hover surface supplies the affordance.

Fields present a label above the input. Inputs use a translucent light surface, clear outline, and copper border/halo when focused. Focus visibility is mandatory for every interactive component.

Cards use an accent icon tile, serif title, concise supporting copy, and quiet metadata. On hover they brighten, lift slightly, and standard record cards reveal a short category-colored rule. List rows use the same visual language at a denser scale.

Dialogs use native `<dialog>` with a header/body/footer structure, internal scrolling, and a blurred dimmed backdrop. Warning content uses the copper container; permanent deletion uses `danger`, explicit confirmation, and unambiguous copy. Do not render irreversible actions as standard primary actions.

Empty states use a dashed container, small abstract orbital mark, serif heading, concise explanation, and one focused next action. Toast notices appear at the lower right, with dark neutral, positive, or danger surfaces.

Motion should be brief and purposeful: fade/slide content entrance, card hover/press feedback, detail-pane and dialog entrance, and modest search expansion. Honor `prefers-reduced-motion` globally; new animations must reduce to near-zero duration in that mode.

## Do's and Don'ts

Do:

- Compose existing tokens and component patterns before inventing a new one.
- Pair meaningful icons with labels or accessible names.
- Use semantic native controls, the skip link, visible keyboard focus, and logical focus flow for dialogs, mobile navigation, and the detail pane.
- Let each information model use its established structural view rather than forcing it into a generic card grid.
- Keep privacy and destructive states clear, specific, and restrained.

Don't:

- Replace the warm paper/serif identity with a dark, high-chroma, or generic dashboard aesthetic.
- Add stock imagery, mixed icon libraries, ornamental gradients, or non-semantic decoration.
- Use color as the sole indicator of a record or knowledge status.
- Add motion that does not explain arrival, selection, or response.
- Conceal important actions behind icon-only controls without an accessible label.
- Create bespoke components when a card, list, timeline, goal, profile, relationship, knowledge, detail, settings, or dialog pattern already fits.
