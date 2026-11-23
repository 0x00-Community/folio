# Round 6 brief: the automation interface

Status: all three units pass their checks on `r6/automation` (2026-11-21). `scripts/e2e/automation.mjs` passes
5 of 5 on the host, and every `scripts/e2e/shell-*.mjs` still passes. Measured in the runtime on `long.docx`:
`outline` 0.2 ms, one `blocks` call of 500 1.0 ms, the whole `text` walk 0.2 ms in 2 calls.

Changes from this brief as built:

- `insertImage` accepts `image/png` and `image/jpeg` only, as `Source.addMedia` does. A GIF is `bad-request`.
- `setStyle` also accepts the role ids `normal`, `title`, `heading1`, `heading2`, `heading3`, which the editor can
  add to a document that lacks them.
- `Host` gained `markers()` and `watch(listener)`, and `file()` carries a `session` object. `pageOf` takes a block
  id.
- One Rust change was needed, outside the interface. Enter at the end of an untouched imported paragraph sent a
  kept paragraph followed by a new paragraph of the same source, and `plan` in `engine/src/write.rs` refused it
  with `block N appears twice`. The keyboard reached the same failure. `plan` now accepts that order, with tests in
  `engine/tests/save.rs` and `src/engine/save.test.ts`.

## Goal

A caller that is not a person at the keyboard operates the open document and reads its structure through one page
object, `window.word`. It sets the selection at an address, types, presses Enter, inserts a table, an image or a
page break, and applies the formatting the toolbar offers. It reads three views of the document: the blocks, the
text, and the outline. Every edit goes through `Editor.run`, so undo and save treat it as a keystroke.

The rule for this round: JSON in, JSON out. No model object, `src` identity, DOM node or function crosses
`word.call`. A caller that holds only a response can write the next request.

## Read first

- `docs/design/design.md`, "Round 6: an automation interface". Its decisions bind this brief.
- `docs/briefs/r2-shell.md`, "Agent contract" and "Constraints". `docs/briefs/r4-features.md`, "Constraints".
- `src/model.ts` whole (`Pos`, `Selection`, `DocIndex`, `flatText`, the ids). `src/editor/edit.ts`: the exported
  commands and `EditorState`, `Transaction`, `apply`. `src/editor/editor.ts` whole. `src/editor/derive.ts`
  `listMarkers`. `src/editor/pages.ts` `PageView.pageOf` and `Layout`. `src/app.ts`: `boot`, how the toolbar
  handlers call commands, how an image is added (`source.addMedia` then `insertImage`), the preview state and
  `isDialogOpen`. `src/main.ts` `installHook`. `src/editor/input-dom.ts`: where the composition mode lives.
- `src/editor/testkit.ts` for building documents in tests.
- `.audit/acde-skill/references/guide/tools.md`, "eval", for how the e2e reaches the page.

## Data shapes

Put these in `src/automation/types.ts` with a doc comment on each field. That file is the reference a caller
reads, so it imports nothing from the rest of `src`.

```ts
type Address = { para: string; offset: number | 'end' }
type Range = { anchor: Address; head: Address }
type Place = Address | Range

type SelectionView =
  | { kind: 'text'; anchor: { para: string; offset: number }; head: { para: string; offset: number } }
  | { kind: 'cells'; table: string; anchor: { row: number; cell: number }; head: { row: number; cell: number } }

type Request = { v?: 1 } & (ReadRequest | EditRequest)

type ReadRequest =
  | { op: 'info' }
  | { op: 'selection' }
  | { op: 'blocks'; from?: number; count?: number }
  | { op: 'text'; from?: number; count?: number }
  | { op: 'text'; ids: string[] }                       // paragraph or table ids, at most 500
  | { op: 'outline' }
  | { op: 'find'; text: string; from?: Address; limit?: number; matchCase?: boolean; wholeWord?: boolean }
  | { op: 'hitTest'; clientX: number; clientY: number }

type EditRequest = { at?: Place } & (
  | { op: 'select'; at: Place }
  | { op: 'selectCells'; table: string; anchor: { row: number; cell: number }; head: { row: number; cell: number } }
  | { op: 'selectAll' }
  | { op: 'insertText'; text: string }                  // "\n" and "\t" as insertText in edit.ts treats them
  | { op: 'enter' } | { op: 'lineBreak' } | { op: 'pageBreak' }
  | { op: 'delete'; direction?: 'backward' | 'forward'; unit?: 'char' | 'word' }   // no direction: the selection
  | { op: 'toggleMark'; mark: 'bold' | 'italic' | 'underline' | 'strike' }
  | { op: 'setMark'; mark: string; value: string | number | boolean | null }       // the marks setMark accepts
  | { op: 'setStyle'; style: string }                   // a style id from `info.styles`
  | { op: 'setAlign'; align: 'left' | 'center' | 'right' | 'justify' | 'distribute' }
  | { op: 'setIndent'; left?: number; right?: number; firstLine?: number; hanging?: number }   // points
  | { op: 'setLineSpacing'; rule: 'auto' | 'exact' | 'atLeast'; value: number }
  | { op: 'indentLevel'; delta: 1 | -1 }
  | { op: 'toggleList'; list: 'bullet' | 'decimal' }
  | { op: 'insertTable'; rows: number; cols: number }
  | { op: 'insertRow'; where: 'above' | 'below' } | { op: 'deleteRows' }
  | { op: 'insertColumn'; where: 'left' | 'right' } | { op: 'deleteColumns' }
  | { op: 'deleteTable'; table?: string }               // no id: the table holding the selection
  | { op: 'insertImage'; base64: string; contentType: string }
  | { op: 'resizeImage'; at: Address; widthPt: number; heightPt: number }
  | { op: 'moveImage'; at: Address; to: Address }
  | { op: 'setPageSetup'; section: number; page: PageSetupView }
  | { op: 'replace'; text: string; with: string; matchCase?: boolean; wholeWord?: boolean; all?: boolean; from?: Address }
  | { op: 'undo' } | { op: 'redo' }
)

type Response = ReadResponse | EditOk | ReplaceOk | Refusal
type EditOk = { ok: true; rev: number; selection: SelectionView; created: string[]; removed: string[] }
type ReplaceOk = EditOk & { replaced: number; skipped: number }
type Refusal = { ok: false; error: { code: ErrorCode; message: string; para?: string } }
type ErrorCode =
  | 'bad-request' | 'unknown-op' | 'unsupported-version' | 'unknown-address' | 'out-of-range'
  | 'locked' | 'read-only-story' | 'busy' | 'refused'
```

Read responses, each with `ok: true` and `rev`:

- `info`: `{ name, dirty, pages, pagesFinal, words, blocks, sections: [{ index, page: PageSetupView, breakType }],
  styles: [{ id, name, heading: number | null }] }`. `blocks` is the body block count. `PageSetupView` is the
  `PageSetup` of `model.ts` in plain numbers (points).
- `blocks`: `{ total, from, next: number | null, blocks: BlockView[] }` over body blocks in order.
  `BlockView = { index, id, kind: 'paragraph' | 'table' | 'opaque', section, page, ... }`, with
  `{ length, style, heading, locked }` for a paragraph, `{ rows, cols }` for a table, `{ label }` for an opaque
  block. `page` is 1-based, from the editing view's layout, and `null` for a block the layout has not reached.
- `text`: the same paging, or `ids`. `{ ..., blocks: TextBlock[] }`.
  `ParagraphText = { kind: 'paragraph', id, text, runs, style, align, list, locked }`. `text` is the flat text with
  U+FFFC for each atom. `runs` covers `text` exactly and in order: `{ start, end, marks }` for text (the direct
  marks of `Marks`, without `link`, plus `link: true` when the text is in a hyperlink) and
  `{ start, end, atom: 'field' | 'pageBreak' | 'columnBreak' | 'opaque', display? }` for an atom, and
  `{ start, end, atom: 'image', widthPt, heightPt }` for a picture. The `blocks` op lists block metadata and does not
  repeat those inlines.
  `list` is `{ level, marker } | null` with the marker text of `listMarkers`. `locked` is the lock reason or `null`.
  `TableText = { kind: 'table', id, rows: [{ cells: [{ span, vMerge, blocks: TextBlock[] }] }] }`.
  `OpaqueText = { kind: 'opaque', id, label, preview: string[] }`.
- `outline`: `{ headings: [{ id, level, number, text, page, from, to }], truncated }`. A heading is a top-level body
  paragraph whose style's `w:name` is `heading 1` to `heading 9` in any letter case. `number` is its list marker or
  `null`. `from` is its own block index. `to` is the index of the last block before the next heading of the same
  or a higher level, or the last block of the body. At most 5000 headings.
- `find`: `{ matches: [{ para, start, end }], truncated }`, in document order, cells included, a match inside one
  paragraph only. Default `limit` 100, at most 1000. `wholeWord` requires both ends to be word boundaries from the
  `zh` word segmenter. Headers, footers, and preview paragraphs are still skipped.
- `replace`: `ReplaceOk`. Without `all`, replaces the first match at or after `from`, or at the document start when
  `from` is omitted. `all` replaces every match in one undo entry and ignores `from` after validating it. A locked
  paragraph or a match that touches a hyperlink is skipped and still reported. The same text is not an edit. No match
  is `{ ok: true, replaced: 0, skipped: 0 }` and pushes no undo entry. An empty `with` deletes the match.
- `selection`: `{ selection: SelectionView }`.
- `hitTest`: `{ at: { para, offset } | null }`.

Limits: `count` defaults to 200 and is capped at 500. A `text` longer than 1,000,000 UTF-16 units, an image over
16 MiB decoded, or a table over 63 columns or 500 rows is `bad-request`.

## Decisions already made

| Subject | Decision | Where |
| --- | --- | --- |
| Entry | `word.call(request)` validates the request shape first. An unknown `op` is `unknown-op`, a wrong field is `bad-request` naming the field, `v` other than 1 is `unsupported-version`. It never throws and never rejects: an exception inside becomes `refused` with the message, and is logged with `console.error`. | `src/automation/api.ts` |
| Host seam | `api.ts` talks to a small `Host` interface (`state()`, `run(command)`, `undo()`, `redo()`, `pageOf(pos)`, `status()`, `busy(): string | null`, `addMedia(blob)`, `hitTest(x, y)`, `file(): { name, dirty }`). `app.ts` implements it over the current `Editor`. Tests implement it over `EditorState` and `apply`. | `src/automation/host.ts` |
| Addresses | Resolve before running. An id that is not in the document: `unknown-address` with `para`. An offset outside `0..length`: `out-of-range`. A paragraph in a header or footer story, or in an opaque block's preview: `read-only-story`. | `src/automation/address.ts` |
| Locks | An edit whose target paragraphs include a locked one answers `locked` with `para` and changes nothing. Selection ops are allowed there. | `api.ts` |
| A command that returns null | `refused`, with a message that names the op. Do not guess a reason. A `select` to the selection already held is not a refusal: it answers `ok`. | `api.ts` |
| `at` | Runs `setSelection` first, then the op. If the op is refused, the selection goes back to what it was. | `api.ts` |
| `created` and `removed` | Compare the ids of every paragraph, table and opaque block (cells included) before and after. | `api.ts` |
| `rev` | A counter the interface keeps. It advances when the document object the host reports differs from the one seen at the last call or change event, so user edits advance it too. It starts again at 0 when another file is loaded. | `api.ts` |
| Busy | `host.busy()` names the reason: `preview`, `dialog`, `composition`. Edits answer `busy`. Reads answer normally. | `app.ts` |
| Page numbers | `Editor` gains one public method that gives the 0-based page of a block id from the layout, without touching the DOM, and `null` past the measured part of an incomplete layout. | `editor.ts`, `pages.ts` |
| Reads are pure | `read.ts` takes a `Doc`, the marker map and a page lookup function. It imports no DOM and no `Editor`. Cache the outline and the block list on the `Doc` identity with a `WeakMap`. | `src/automation/read.ts` |
| Install | `main.ts` sets `window.word` after `boot`, in every build. `window.__word` keeps its present fields. | `main.ts` |

## Units and their checks

1. **Read views.** `types.ts`, `read.ts`, `address.ts`.
   - `node --test`: a document built with the testkit that holds headings at three levels with numbering, a list,
     a table with a merged cell and a nested table, an image atom, a locked paragraph, an opaque block and a
     header story. For each view the exact expected JSON. `outline` ranges: `to` of a level 2 heading stops before
     the next level 1 or 2 heading. Paging: for every `count` from 1 to 7, following `next` visits each block once.
     `runs` covers `text` with no gap or overlap for every paragraph of the document. `JSON.parse(JSON.stringify(x))`
     deep-equals `x` for every response, and no response holds a key named `src`.
   - Address resolution: each refusal code above from a case that produces it.
2. **Operations.** `host.ts`, `api.ts`.
   - `node --test` over a host made from `EditorState`: every op in `EditRequest` once on a document where it
     applies, with the exact `created` and `removed`. `at` followed by a refused op leaves the selection as it
     was. An edit in a locked paragraph, a header paragraph and an unknown id each give their code and the same
     `doc` object. `undo` after each op restores the previous `doc` object. `rev` advances by one per document
     change and not on a selection change.
   - A property test with `mulberry32`: 500 random valid requests keep `checkDoc`, never throw, and every response
     has `ok` true or one of the codes.
3. **The app.** `Host` in `app.ts`, `window.word`, the `Editor` page method, busy states.
   - `scripts/e2e/automation.mjs`. Load `fixtures/basic.docx` with `__word.openBytes`. After that, every action
     and every read goes through `acde eval word 'word.call(...)'` and nothing else.
     Read `outline` and `blocks` and check them against the fixture. `find` a phrase and insert text at the match.
     At the end of the first heading's range: `enter`, `insertText` of a Chinese sentence, `setStyle` to heading 2,
     `insertTable` 2 by 3, text into one cell by its paragraph id from `created`, `pageBreak`, `insertImage` of a
     small PNG made in the script. Read `text` for the created ids and compare with what was sent. The outline now
     holds the new heading with a page number. Then `undo` until the document's `text` view equals the first read
     (ids included), and `redo` back.
     Save bytes with `__word.save()`, load them again, and the `text` view with ids removed equals the one before
     the save.
     With the preview open (opened by its button through `acde act`), an edit answers `busy` and `outline` still
     answers. One `acde inspect --find` shows the typed sentence in the window.
   - The same script on `fixtures/long.docx`: wait for `info.pagesFinal`, page through all of `blocks` and `text`,
     and record the time of `outline`, of one `blocks` call of 500, and of the whole `text` walk. Pass when no
     single call blocks longer than 50 ms and every block has a page.
   - All existing `scripts/e2e/shell-*.mjs` still pass.

Before each unit is reported done: `npm run typecheck` and `npm test` (4 known failures in `server/fonts.test.ts`,
nothing else). No Rust changes are expected. If one is needed, stop and report why.

## Constraints

- All constraints of the round 2, 3 and 4 briefs apply (erasable TypeScript syntax only, `.ts` import extensions,
  no new dependencies, no `any`, no `as` casts on untrusted input).
- `src/automation/` imports from `src/model.ts` and `src/editor/edit.ts` and, for types only, from
  `src/editor/editor.ts`. It does not import `pages.ts`, `render.ts`, `src/engine/` or `src/ui/`.
- No new command in `edit.ts` unless an op cannot be built from the existing ones. If you add one, say which op
  needed it and add its own test in `edit.test.ts`.
- A read never changes editor state, never scrolls and never forces a layout.
- Do not add `requests` or capabilities to `acde.config.jsonc`.
- The sandbox cannot reach the `acde dev` socket. Write the e2e script, run everything else, and say in the report
  that the e2e was not run. The reviewer runs it on the host.
- Use only the fixtures in `fixtures/`. Write test output under a temporary folder.
- Do not commit. Leave the changes in the working tree. End with a report: what changed per file, each check and
  its result, each decision you made that this brief did not make, and anything left open.

## Success

A reviewer runs `scripts/e2e/automation.mjs` on the host from a clean checkout and it passes. In a dev session,
`acde eval word 'word.call({ op: "outline" })'` prints the headings of the open document, and
`acde eval word 'word.call({ op: "insertText", text: "你好", at: { para: "<id>", offset: "end" } })'` puts the text
at the end of that paragraph, visible in the window, undone by one Ctrl+Z.
