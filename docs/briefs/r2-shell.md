# Round 2 brief: the editor shell

Status: written, not dispatched. The user asked to stop after this brief.

## Goal

A user opens a `.docx` in the Word app on Dopame OS, sees its pages, puts the caret in the text and types. Today the
default window shows one status line, and the page view only runs on a synthetic document behind `#view-demo`. Round 1
left four parts on `main` that nothing connects: the model and commands, the page view, the docx import, and the font
service. This round connects them and adds the input layer and the app shell. Saving is round 3.

## Read first

- `docs/design/design.md`. It wins where it disagrees with candidate B.
- `docs/design/candidate-b/design.md`, sections "Usage", "Module map", "What happens on a keystroke", "IME composition".
- `docs/design/candidate-b/sketch/editor/editor.ts`, `sketch/editor/input.ts`, `sketch/usage.ts`. These hold the
  intended signatures.
- `docs/design/grounding.md` for what acdert can and cannot do.
- The acde skill (`~/.grok/skills/acde/SKILL.md`) and its references on capabilities, files, opening apps and windows.
  Read the reference before using any `acde:` module. Do not guess an API.
- The code this round builds on: `src/model.ts`, `src/editor/edit.ts`, `src/editor/pages.ts` (`PageView`),
  `src/editor/render.ts` (`RenderContext`), `src/engine/engine.ts` (`loadEngine`, `Engine`, `Opened`, `Source`),
  `src/fonts.ts`, and `src/editor/demo.ts` as a working example of mounting a `PageView`.

## Data shapes

Choose these before writing logic. Do not replace them with scattered booleans.

| Shape | Structure | Owner |
| --- | --- | --- |
| Editing state | `EditorState` from `edit.ts`, unchanged. The `Editor` holds exactly one and replaces it through `apply`, `undo`, `redo`. | `editor.ts` |
| Preedit | `Decoration \| null` from `render.ts`. View state only. It never enters the model or the history. | `editor.ts` |
| Keymap | One `ReadonlyMap<string, Action>` table, with `Action` as the tagged union in the input sketch. The keydown handler and the menus both read it. | `input.ts` |
| Input mode | A state machine with the states `idle`, `composing` and `dragging`. Each event handler switches on the state. | `input.ts` |
| Open file | `{ handle, name, saved: Doc }` or none. Dirty is derived as `editor.state.doc !== file.saved`. No dirty flag. | `app.ts` |
| Toolbar and status | Derived from `EditorState` on each `change` through `toolbarState` and `wordCount`. Never stored. | `editor.ts` |
| Strings | One key table per locale in `src/locales/zh.ts` and `en.ts`. Every visible string goes through `t()`. | `i18n.ts` |

## Scope

New files:

- `src/editor/editor.ts`. The `Editor` facade: `mount(host, opened, options)`, `load(opened)`, `run(command)`, `undo()`,
  `redo()`, `setPreedit(deco)`, `state`, `source`, `toolbar()`, `status()`, `on('change', fn)`, `destroy()`. It builds
  the `RenderContext` from `Source` and `fonts.ts`, with line heights from `fetchMetrics` and list markers derived from
  document order. It drives `PageView.show` on load and the incremental update path after each transaction.
- `src/editor/input.ts`. The hidden textarea, `defaultKeymap`, `chordOf`, `attachInput`, as documented in the sketch.
  Clipboard is plain text in this round.
- `src/app.ts` and `src/ui/*`. New document, open through the file picker, open through the system request for the
  declared mime type, a toolbar (undo, redo, bold, italic, underline, strike, paragraph style, alignment, bullet and
  numbered list), a status bar (page x of y, word count, zoom), zoom control, the window title with the file name and
  a dirty mark, and zh and en strings.

Changed files:

- `src/main.ts` boots `app.ts`. `#view-demo` keeps working.
- `index.html` holds the shell layout.
- `acde.config.jsonc` requests the capabilities the shell imports.
- `src/editor/render.ts` drops its private `flatText` and imports the one in `model.ts`.
- `src/locales/*.ts`.

Not in this round: save, save as, the close guard, export, table and image insertion UI, page setup, print preview.
`Source.save` still throws. Leave the Save control out of the toolbar until round 3.

## Agent contract

Agents operate the app through `acde inspect` and `acde act`. Measured in acdert 0.0.10 (decision log row 32):

- `act type` fires one `beforeinput` `insertText` with the whole string. `act key enter` fires `keydown` Enter.
- A textarea with `opacity: 0` is hidden from inspect. One with a transparent color is listed as a textbox. Use the
  transparent color, with an accessible name from the locale table.
- A paragraph made of many spans reads as one line when the block has an `aria-label` with its flat text and its
  children are `aria-hidden`.
- The clipped second copy of a block that straddles a page must be `aria-hidden` so it is not read twice.

Every toolbar control is a real `button` or `select` with an accessible name. Toggle buttons carry `aria-pressed`.
The status bar is `role="status"`.

## Constraints

- Tests run on Node 24 with type stripping. Use erasable syntax only: no `enum`, no `namespace`, no parameter
  properties. Relative imports carry the `.ts` extension.
- `acde test` is unavailable (no Bun). End-to-end checks use `scripts/e2e/acde.mjs`.
- acdert has no `confirm()` or `prompt()`, no Web Workers and no modules from a CDN. Build dialogs in the page.
- Use the fixtures in `fixtures/` only. Never read documents from the user's home folders.
- Keep a comment only for a why the code cannot show. No comments that narrate phases.
- Commit after each unit below passes its check. Small commits, imperative subject lines.

## Units and checks

Each unit ends in its check. Do not start the next unit before the check passes.

1. **Editor facade, read-only.** `Editor.mount` shows `fixtures/basic.docx` and `fixtures/long.docx` in the page view.
   For e2e, the dev build exposes `window.__word = { editor, openBytes(base64) }`. Check: the e2e script opens both
   fixtures, the layout completes, the page count is stable across two loads, there are no console errors, and a
   screenshot of page 1 is saved under `docs/design/evidence/shell/`.
2. **Input.** Caret, typing, Enter, Backspace and Delete across paragraph boundaries, arrows with a stable goal
   column, Shift selection, mouse placement, double and triple click, drag selection, copy, cut and paste of plain
   text, undo and redo, and IME composition through the preedit decoration. Check: `node --test` covers `chordOf` and
   `defaultKeymap`. The e2e script uses only `acde act` and `acde inspect` to type English and Chinese, press Enter,
   Backspace across a paragraph boundary, move with arrows, toggle bold at the caret and type, then undo, and it
   asserts `flatText` and marks from the model after each step. Keystroke p95 on `long.docx` stays under 8 ms.
3. **App shell.** New, open by picker, open by system request, toolbar, status bar, zoom, title, zh and en. Check:
   the e2e script finds every toolbar control by role and name through `acde inspect`, toggles each mark on a
   selection and reads the matching `aria-pressed` and model marks, changes the paragraph style and alignment, and
   the status bar shows the page and word counts. A screenshot of the full window in each locale is saved under
   `docs/design/evidence/shell/`.

Before each commit: `npm run typecheck`, `npm test`, `acde check`, and the e2e scripts written so far.

## Success

A reviewer runs `acde dev`, opens `fixtures/basic.docx` from the picker, types in it in Chinese and English, formats
a selection from the toolbar, and undoes it, with no console errors. All three unit checks pass when rerun from a
clean checkout after `npm run engine`.
