# Round 4 brief: lists, page setup, tables, images

Status: not started (2026-11-20). Branch `r4/features`.

## Goal

A user changes a list level with Tab, changes the paper size and margins, inserts a table and adds or removes its
rows and columns, and inserts a picture. Each of these shows on the page at once, and each survives save and reopen.
Today the model and the commands for all four exist and are unit tested (`src/editor/edit.ts`), but only the bullet
and number buttons reach the user, and `write.rs` refuses page setup, inserted tables, row and column changes and
inserted images with `WriteError::Contract`.

The rule for this round: a control ships only together with its save path. No control may produce a document that
save refuses.

## Read first

- `docs/design/design.md`, then `docs/design/candidate-b/design.md`, sections "Pagination" and "Save patches the
  original and keeps unmodeled content" (the paragraph that starts "New paragraphs use `insert_paragraph`").
  Line numbers into rdocx in that document are stale. Find functions by name.
- `docs/briefs/r2-shell.md`, "Agent contract" and "Constraints". `docs/briefs/r3-save.md`, "Data shapes" and
  "Constraints". All of them apply here.
- `src/model.ts` (`Table`, `Row`, `Cell`, `Atom`, `Section`, `PageSetup`, `ListTable`, `MediaTable`, `checkDoc`).
- `src/editor/edit.ts`: `toggleList`, `changeIndentLevel`, `insertTable`, `insertRow`, `deleteRows`, `insertColumn`,
  `deleteColumns`, `deleteTable`, `insertImage`, `setPageSetup`, `insertPageBreak`, `toolbarState`.
- `src/editor/pages.ts` (`PageView.update`, `diffIds`, `paginate`, `placeTable`, `paintCells`), `src/editor/derive.ts`
  (`listMarkers`), `src/editor/render.ts` (table and image rendering).
- `src/editor/input.ts` (`Action`, `defaultKeymap`), `src/editor/input-dom.ts`, `src/ui/toolbar.ts`, `src/ui/unsaved.ts`,
  `src/app.ts`, `src/main.ts` (`window.__word`).
- `engine/src/write.rs` (`plan`, `Step`, `table_shape_changed`, `reject_fresh_atoms`, `apply_insert`, `patch_table`,
  `table_ordinal`), `engine/src/verify.rs`, `engine/src/wire.rs`, `engine/src/import.rs` (`SourceMap`, `RowOrigin`,
  `CellOrigin`, `wire_section`, `remember_media`), `src/engine/engine.ts` (`toPatch`, `addMedia`, `imageUrl`).
- The rdocx kit at `/Users/user/code/rdocx-editing-kit`, `crates/rdocx/src/document.rs`, `table.rs`, `run.rs`:
  `insert_table`, `clone_table_row`, `remove_table_row`, `Table::insert_column`, `delete_table_column`,
  `Table::set_grid_widths`, `Table::set_borders`, `embed_image`, `Run::add_picture`, `section_mut`,
  `Section::set_page_size`, `set_margins`, `set_gutter`, `set_header_footer_distance`, `set_orientation`.
- The acde skill copy in `.audit/acde-skill/`, `guide/files.md` for the open picker.

## Findings from the survey

Read from the code on 2026-11-20. Items marked inferred were not run. Confirm each inferred item with a failing test
before you build on it.

1. `PageView.update` diffs `doc.body` only, and `paginate` returns the previous result when no block changed. A
   `setPageSetup` transaction changes only `doc.sections`, so the page does not change.
2. Only blocks whose object changed are rendered again. A list paragraph whose number shifts because a sibling
   changed keeps its old marker text.
3. Tab has no binding. The keydown handler returns on an unbound chord, so Tab moves browser focus out of the editor.
4. `insertTable` splits the paragraph at the caret and both halves keep one `src`. The planner places an insert after
   the end of that region, so the table would be written after the tail (inferred).
5. `Source.addMedia` keeps bytes in a TypeScript closure and has no caller. The patch carries no media.
   `insertImage` records `image/png` for every new image.
6. `verify` compares a whole `Atom::Image { media, width_pt, height_pt }`. A new image's model key never equals the
   relationship id that the import of the written file reports, and the EMU conversion may round the size (inferred).
7. The kit's `table_mut` and its staged table calls count every table in document order, nested ones included.
   `table_ordinal` in `write.rs` counts top-level tables only (inferred mismatch for a document with a nested table
   before the edited one).
8. `mod+enter` inserts a page break atom with no `src`, and `reject_fresh_atoms` refuses it. A shipped control
   already breaks the rule above.
9. The section model has no orientation field. `Section::set_orientation` takes `ST_PageOrientation`, which the
   `rdocx` crate does not export again.
10. The key trap in `unsaved.ts` cancels every key except Tab, Escape, and Enter or Space on a button. A dialog with
    inputs cannot be typed into through it.
11. The page draws a border on every table cell from CSS. `insert_table` writes no borders, so an inserted table
    would show borders in the editor and none in Word.

## Data shapes

Choose these before writing logic.

| Shape | Structure | Owner |
| --- | --- | --- |
| Layout inputs | `PageView.update` reacts to three inputs by object identity: `doc.body`, `doc.sections`, and the marker map from `listMarkers`. A section whose `page` changed invalidates the measures of the blocks in that section. A paragraph whose marker text changed renders again. No "needs relayout" flag. | `pages.ts`, `editor.ts` |
| Key routing | Tab and Shift+Tab are `Action`s in `defaultKeymap`. One command decides by context: in a table cell it moves to the next or previous cell, in a list paragraph it changes the level, elsewhere it inserts a tab character. Tab in the last cell of a table appends a row and moves into it, as Word does. | `input.ts`, `edit.ts` |
| Dialog | One `openDialog({ title, body, buttons }) -> Promise<result>` in `src/ui/dialog.ts` that owns the modal layer, the focus trap and Escape. Text and number inputs inside it accept typing. `unsaved.ts` becomes a caller of it, and its private trap is deleted. | `src/ui/dialog.ts` |
| Paper sizes | One table `PAPER_SIZES: { key, widthPt, heightPt }[]` (A4, A3, A5, B5, Letter, Legal, 16K). The dialog's size select, the "custom" choice and the orientation radio are all derived from `PageSetup` by matching it against the table within 0.5 pt in either orientation. Orientation is `widthPt > heightPt`. It is not a stored field. | `src/ui/page-setup.ts` |
| Table edit plan | For a table with a `src`, `plan` aligns the final rows against the imported rows by `RowSrc`, and the cells of each kept row by `CellSrc`, into `Keep`, `Insert` and `Remove` operations. Kept rows and cells must stay in imported order, otherwise `Contract`. Operations apply from the last row and column to the first so indexes do not shift. A table with no `src` is one `InsertTable` step. | `write.rs` |
| Body position of an insert | A fresh block is placed by its position in the final body between its neighbors, including the two halves of a split paragraph. It is never placed "after the region". | `write.rs` |
| Patch media | `Patch.media: { key, fileName, base64 }[]`, holding exactly the keys that image atoms with `src: null` in the final document reference. `write` embeds each once and maps `key` to its relationship id. `verify` compares a fresh image through that map and compares sizes after the same EMU conversion the writer used. | `wire.rs`, `wire.ts`, `engine.ts` |
| Table tools | A toolbar group rendered from `toolbarState().inTable`: insert row above and below, delete row, insert column left and right, delete column, delete table. Disabled outside a table. Not stored. | `toolbar.ts` |

## Scope

In scope:

- Lists. Tab and Shift+Tab change the level. Increase and decrease indent buttons call `changeIndentLevel`. Markers
  of sibling paragraphs update when numbering shifts.
- Page break. A page break inserted with `mod+enter` saves.
- Page setup. A dialog for the section that holds the caret: paper size, orientation, the four margins. The page
  view lays out again at the new size. Save writes `w:pgSz` (with `w:orient` for landscape) and `w:pgMar`.
- Tables. Insert a table of chosen rows and columns at the caret (1 to 20 rows, 1 to 10 columns). Insert and delete
  rows and columns. Delete the table. Tab between cells. An inserted table is written with single borders and
  equal column widths that fill the text width, so Word shows what the editor shows.
- Images. Insert a PNG or JPEG from the file picker as an inline image at the caret, scaled down to the text width
  when it is wider, with its real content type. Backspace and Delete remove it (the atom path exists).

Not in this round. Do not add a control for any of these: merged or split cells, column resizing by drag, table
styles and shading, cell range selection, nested table insertion, image resize handles, floating images, section
break insertion, restart numbering, list format choice, headers and footers.

## Units and checks

Each unit ends in its check. Do not start the next unit before the check passes. Each unit is a separate dispatch.
The delegate's sandbox cannot reach the `acde dev` socket, so the delegate writes each e2e script and the reviewer
runs it on the host.

1. **Layout inputs and list keys (TypeScript only).** Findings 1, 2, 3. `PageView.update` reacts to sections and
   markers. Tab and Shift+Tab as actions with the routing above (the table branch can call the cell motion now, since
   it needs no engine change). Indent buttons in the toolbar with icons in the existing style and names from the
   locale tables.
   - `node --test`: `pages.test.ts` gains a case where `setPageSetup` with narrower margins changes the page count of
     a long synthetic document, and one where it changes nothing but `titlePage` and no block is measured again.
     `derive` or `pages` tests gain a case where deleting the first item of a numbered list changes the rendered
     marker of the third. `input.test.ts` covers the Tab routing in a list, in a cell, in the last cell, and in plain
     text.
   - `scripts/e2e/shell-lists.mjs`, only through `acde act` and `acde inspect`: make three numbered paragraphs, press
     Tab on the second, read level 1 from the model and the changed marker from the page, press Shift+Tab, use both
     indent buttons, delete the first item and read the renumbered markers. Focus stays in the editor after Tab.
2. **Page setup and page break.** Findings 8, 9, 10. `src/ui/dialog.ts`, `unsaved.ts` moved onto it,
   `src/ui/page-setup.ts`, a toolbar button, `write.rs` section writes, `verify` compares sections, `wire_section`
   and the write agree on orientation. If the engine cannot reach `ST_PageOrientation`, add the smallest export to
   the kit on `work/editing-kit-grok` and say so in the report. Remove the `"page setup"` and page break rejections
   and flip the tests that assert them (`save.test.ts`, `engine/tests/save.rs`).
   - `cargo test` in `engine/tests/save.rs`: margins changed, size changed, landscape, and a page break atom inserted
     in the middle of a paragraph, each on `basic.docx` and on `preserve.docx` with the ledger unchanged. A document
     with two sections changes only the section named.
   - `scripts/e2e/shell-page.mjs`: open `long.docx`, open the dialog by its button, type margins of 144 pt through
     `acde act type`, confirm, the page count in the status bar rises. Choose A4 and landscape, the first page box
     is wider than tall. Save through `window.__word.save()`, open the bytes again, `sections[0].page` equals the
     model before the save. Escape and Cancel leave the document unchanged and not dirty. The unsaved-changes
     dialog still passes `shell-save.mjs`.
3. **Table writes (Rust and the patch).** Findings 4, 7, 11. The table edit plan, the body position rule, borders on
   an inserted table. Remove the `"inserted tables"` and `"row and column changes"` rejections for the edits in scope.
   - `cargo test`: insert a table between two paragraphs, at the start and the end of the body, and in the middle of
     a paragraph (the two halves surround it). On the fixture table: insert a row above the first, below the last
     and in the middle, delete a row, insert a column at each edge and in the middle, delete a column, and a mix of
     these in one save. Text typed into new and old cells in the same save. Delete the table. A nested table before
     the edited table does not shift the edit (build the document in the test through the kit). Reordered rows
     return `Write`. Every case imports back equal to the patch and saving twice gives equal imports.
   - `save.test.ts`: the random edit test stops listing these edits in `OUT_OF_SCOPE`.
4. **Table controls.** The insert control (a button that opens a rows and columns dialog through `openDialog`), the
   table tools group, the row appended by Tab in the last cell.
   - `scripts/e2e/shell-table.mjs`: insert a 2 by 3 table by the dialog, type in cells moving with Tab, Tab past the
     last cell, use each table tool once, save, open the bytes again and compare the table projection (rows, cells,
     text). Delete the table and save again. Screenshot under `docs/design/evidence/tables/`.
5. **Images.** Findings 5, 6. Patch media, `write` through `embed_image` and `Run::add_picture`, the verify map, the
   insert button with the open picker, real content type, scale to text width.
   - `cargo test`: insert a PNG and a JPEG in a body paragraph and in a table cell, two uses of one key embed one
     part, delete an imported image, bytes of the embedded part equal the input. `preserve.docx` ledger unchanged.
   - `scripts/e2e/shell-image.mjs` with `acde choose open` pointing at an image the script writes to a temporary
     folder: insert, the page shows an `img` with nonzero natural size, save, open the bytes again, the atom has the
     same size within 0.05 pt and `imageUrl` resolves to the same bytes.

Before each unit is reported done: `npm run typecheck`, `npm test` (4 known failures in `server/fonts.test.ts`,
nothing else), and when Rust changed, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`
and `npm run engine`.

## Constraints

- All constraints of the round 2 and round 3 briefs apply: erasable TypeScript syntax, `.ts` import extensions, real
  `button`, `select` and `input` elements with accessible names from the locale tables in both `zh.ts` and `en.ts`,
  no `confirm()`, comments only for a why the code cannot show.
- No lossy fallback. Where the kit refuses an operation, `write` returns `Write` with the reason.
- `window.__word` may gain read helpers for the e2e scripts. An e2e script drives every edit through `acde act`.
  It does not call commands through `window.__word`.
- The engine builds with `RUSTUP_TOOLCHAIN=nightly SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
  Run cargo with `--offline`. The sandbox has no network.
- Use only the fixtures in `fixtures/`. Write test output under a temporary folder.
- Do not commit. Leave the changes in the working tree. End with a report: what changed per file, each check and
  its result, each finding you confirmed or found wrong, and anything left open.

## Success

A reviewer opens `fixtures/basic.docx`, sets A4 with 2 cm margins, inserts a 3 by 3 table and fills it using Tab,
adds a row and removes a column, inserts a picture, saves, and opens the result again: everything is where it was
put. All unit checks pass when rerun from a clean checkout after `npm run engine`.
