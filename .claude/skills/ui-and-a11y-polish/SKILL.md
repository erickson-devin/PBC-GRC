---
name: ui-and-a11y-polish
description: Review PBC-GRC React components (src/components, src/views, src/pages) for responsive Tailwind breakpoints, keyboard navigation, ARIA and focus handling, and consistent loading, empty, error and read-only states, using the app's existing building blocks and without changing architecture, state management or dependencies. Use when a screen, dialog, form or table is added or changed, or when the user asks for UI polish, accessibility or a11y review.
---

# UI and accessibility polish (PBC-GRC)

Stack: React 19 function components, Tailwind CSS 3 utility classes, `lucide-react` icons, `framer-motion` for motion, self-hosted Inter / JetBrains Mono. State lives in React context (`src/context/`) and hooks (`src/hooks/`); data comes through `src/services/apiClient.ts`.

**Boundaries**: polish only. No new dependencies, no new state library, no moving or renaming components, no API or data-shape changes, no edits to `src/data/frameworks/**` or `src/data/stigs/**`. If a fix needs any of those, report it instead.

## 1. Reuse what exists

| Need | Use |
| --- | --- |
| Modal / confirm | `DialogOverlay` + `DialogTitle` (`src/components/common/DialogOverlay.tsx`). Never a native `<dialog>`. The panel needs a height cap (`max-h-[..]` or `my-auto`), enforced by `tests/appRoute.test.ts`; a nested dialog gets a higher z-index (`z-[60]` over `z-50`). |
| Error message | `ErrorNotice` (`src/components/common/ErrorNotice.tsx`) |
| Focus trap / Escape / scroll | `useFocusTrap`, `useEscapeKey`, `useScrollLock` in `src/hooks/` |
| Clickable non-button, radio groups | `activateOnKey`, `radioGroupKeyDown` in `src/utils/a11y.ts` |
| Write permission | `canRoleWrite` (`src/utils/roles.ts`), passed down as `canEdit` |
| AI disabled notice | `AiOffNotice`; browser-only tenants: `BrowserOnlyNotesBanner` |

## 2. Checklist (cite `file:line`)

**Responsive**: works at 360 px, `sm`, `md`, `lg`, `xl`. Tables scroll inside `overflow-x-auto`, not the page; long control IDs and file names wrap (`break-words` / `truncate` + `title`); flex rows that hold buttons wrap; dialogs fit a phone height.

**Keyboard**: every action reachable with Tab in visual order; real `<button type="button">` / `<a href>`, not clickable `<div>`s; visible focus ring (`focus-visible:ring-*` matching neighbours); Escape closes dialogs and menus; focus moves into a dialog on open and back to the trigger on close; no `tabIndex` > 0.

**ARIA and semantics**: inputs have `<label htmlFor>` or `aria-label`; groups use `<fieldset>`/`<legend>`; icon-only buttons have `aria-label` and the lucide icon has `aria-hidden="true"`; toggles expose `aria-pressed` / `aria-expanded`; tabs use `role="tablist"`/`tab`/`tabpanel`; errors announce with `role="alert"`, progress with `aria-live="polite"` / `aria-busy`; colour is never the only signal for status (MET / NOT_MET / severity carry text or an icon); text contrast meets WCAG AA in the existing dark palette.

**States**: every data-driven view renders **Loading**, **Empty** (says what to do next), **Error** (`ErrorNotice`, retry where sensible) and **Populated**, plus:
- read-only role (`canEdit` false): controls disabled or hidden, with a reason;
- offline / not yet loaded: editors disabled like the notes editor;
- archived program: read-only;
- browser-only vs server-backed tenant where behaviour differs;
- staged AI output visually distinct from committed records (warning badge or border, explicit accept / reject);
- destructive actions confirm first and state counts and IDs, never CUI text.

**Consistency**: spacing, radius and colour classes match the neighbouring components; buttons show a disabled + spinner state while a request is pending and cannot double-submit; views follow the active program (`tests/programViews.test.ts`).

## 3. Verify

```bash
npm run typecheck
npm run build
npx tsx tests/appRoute.test.ts
npx tsx tests/pageHeaders.test.ts
```

To look at it, start the `api` and `app` configs from `.claude/launch.json` in the browser pane and check keyboard flow and a mobile viewport there. No Puppeteer or browser-test tooling in the repo.

## 4. Report

Findings grouped by component: issue, `file:line`, exact JSX / Tailwind change (before and after), and which state or breakpoint it affects. Mark anything that would cross the boundaries above as a hand-off.
