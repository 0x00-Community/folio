# Interface guide

Rules for anything a user sees: the bar, menus, palettes, dialogs, overlays on the page. A brief that adds
interface points here, and the reviewer checks the result against the last section before it merges. The user's
standing request (2026-11-23): the interface must not look rough, and it should feel like Word.

## Principles

1. **Quiet chrome, the page is the subject.** One accent color, used only for state (pressed, selected, focus,
   handles). No second accent, no gradients, no colored icons. The only color that comes from data is a swatch
   or the bar under the font color and highlight buttons.
2. **Word's order and Word's names.** A control sits where a Word or WPS user would look for it, and carries the
   name Word gives it in that language. When unsure, copy Word's label.
3. **Few things on screen.** A command used rarely goes in a menu or a dialog. A control that applies only in one
   context (table tools, picture handles) exists only in that context. The bar stays one row at 1180 px.
4. **Nothing jumps.** Showing or hiding chrome does not move the document under the pointer. A popup never
   changes the layout of what is under it.
5. **Every state is designed.** Rest, hover, pressed-down, on, mixed, disabled, keyboard focus, and both themes.
   A control with an undesigned state is not finished.

## Tokens

All color comes from the custom properties at the top of `index.html`, which have a light and a dark value. No
color literal anywhere else, in CSS or in TypeScript. A new need gets a new token with both values.

`--chrome-bg` surfaces (bar, strip, menu, dialog). `--status-bg` status bar. `--canvas-bg` behind pages.
`--chrome-border` hairlines and field borders. `--text`, `--text-muted`. `--control-hover`, `--control-active`.
`--accent`, `--accent-soft`. `--field-bg`. `--chrome-shadow`. `--error-bg`, `--error-text`.

## Measures

| Thing | Value |
| --- | --- |
| UI text | 13 px, the system stack already on `.toolbar`. Status bar 12 px. No other sizes, weight 400 or 600 only |
| Bar | 42 px tall, 10 px side padding |
| Bar button | 28 by 28 px, radius 5 px, 2 px between buttons of a group |
| Divider | 1 by 18 px, 6 px each side |
| Select and text field | 26 px tall, radius 5 px, 1 px border |
| Context strip | 34 px tall |
| Menu | radius 8 px, 1 px border, `--chrome-shadow`, 4 px padding, item 28 px tall, icon 18 px, 8 px gap, chord right-aligned in `--text-muted` |
| Swatch | 18 by 18 px, 1 px `--chrome-border`, 2 px gap, selected: 2 px `--accent` ring outside |
| Dialog | radius 10 px, 20 px padding, 12 px between rows, labels above or left of fields and aligned on one edge, buttons bottom right with the default one last and filled with `--accent` |
| Spacing | multiples of 2 px, and 4, 8, 12, 16, 20 for anything larger than a gap |

Elements in one row share a top and a height. Text baselines in a row line up.

## States

- Hover `--control-hover`. Pressed-down `--control-active`.
- On (`aria-pressed="true"`, a checked item): `--accent-soft` background, content in `--accent`, 1 px inset ring
  of `--accent` at 35 percent.
- Mixed: `--control-hover` background.
- Disabled: 38 percent opacity, no hover, default cursor.
- Keyboard focus: `:focus-visible`, 2 px `--accent` outline, 1 px offset. Never remove it without a replacement.
- A button whose popup is open shows the pressed-down background.

## Icons

One family, in `src/ui/icons.ts`. 18 px box, 16 unit grid with 1 unit of margin, 1.5 px strokes, round caps and
joins, `currentColor`, lines on half pixels. No fill except dots and bullets.

- An icon is two or three shapes. If it needs more to be understood, it needs a text label instead. A 3 by 3
  grid with a badge was tried for the table tools and was a blot at 18 px.
- Related commands share geometry: the same line lengths, the same box, one changed part.
- Letters as icons (B, I, U, S, A) use the UI font, not a serif.
- A context strip or a menu shows icon and text. Only the bar may show an icon alone, and then with a `title`.

## Popups, dialogs and overlays

- A popup is appended to `document.body`, positioned under its button, kept inside the window, and above the
  page scroller (the runtime's hit testing ignores the scroller's clip). Closed means out of the DOM or `hidden`.
- Keys: arrows move, Home and End jump, Enter and Space choose, Escape closes and returns focus to the opener. A
  key never reaches the document while a popup is open. After a command, focus returns to the editor.
- A dialog validates as the user types: an invalid field is marked and the default button is disabled. No alert
  boxes. Cancel and Escape change nothing. OK is one undo entry.
- Overlays on the page (handles, outlines, drop marks) are drawn in screen pixels whatever the zoom, use
  `--accent` and `--field-bg`, and are out of the reading order except where a script needs a name.

## Text

- Every string is in `src/locales/zh.ts` and `en.ts`. Chinese first: check that the Chinese label fits its
  control and is the term Word uses.
- Labels are nouns or short verb phrases, sentence case in English, no trailing colon or period. An ellipsis
  only on an item that opens a dialog.
- Numbers show a unit, and the unit is the one the page setup dialog uses.

## Do not

- No emoji, no icon font, no image files, no new dependency for interface.
- No native `alert`, `confirm` or `prompt`. No browser-default buttons, checkboxes or number spinners left
  unstyled next to styled controls.
- No animation longer than 120 ms, and none on layout.
- No tooltip that only repeats a visible label.

## Acceptance, done by the reviewer on the host

A delegate cannot see the window, so nothing visual is accepted from its report. Before merge the reviewer takes
and looks at screenshots of every new or changed surface:

1. Light and dark, Chinese and English, at the default 1180 px width.
2. Each popup and dialog open. Each control in its on, mixed and disabled state where it has one.
3. The widest realistic content: the longest font name, style name and label of both languages.
4. A narrow window (1000 px) to see how it wraps.

Checks on those screenshots: one row where one row is promised, nothing clipped or overlapping, shared tops and
baselines, no color outside the tokens, icons legible at actual size, the Chinese labels fit, focus ring visible
after a Tab. What fails goes back to the delegate as a fix brief with the screenshot named, or the reviewer
fixes it when it is a few lines. The user sees the screenshots in the report.
