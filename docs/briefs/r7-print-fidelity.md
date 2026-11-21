# Round 7 brief: print fidelity

Status: unit 4 passes its checks on `r7/print-fidelity` (2026-11-21). Units 1 to 3 are not done.

Unit 4 as built:

- A line between two cells comes from both facing edges, as rdocx paints it: it is drawn when either cell has it,
  and when both do and differ, the right or lower cell's edge is the one drawn. The owner cell still paints it once.
- Dashed, dotted and double edges are drawn as one solid band, because an inset shadow is one band.
- Conditional regions of a table style (first row, banding) are not imported.
- Open: rdocx treats a cell edge of `none` as unset and falls back to the table's edge, and only `nil` removes
  the line. The importer stores both as no line.

## Goal

The print preview and the exported PDF hold every character of the document inside the page box, the editing view
breaks pages where the preview does, a table shows the borders its file gives it and no others, and one preview
of a real Chinese document fits in the window's memory. These are the four items round 5 left open
(`docs/briefs/r5-print.md`, "Open").

The rule for this round: measure, then change. Every unit starts by producing the number it will be judged on,
from the code as it is today, and ends by producing the same number again. A cause named below as inferred is
not a cause until the unit's first step confirms it.

## Read first

- `docs/design/design.md`, "Round 7: print fidelity". Its decisions bind this brief.
- `docs/briefs/r5-print.md` whole. Its constraints and its "Open" list are the starting point.
- `docs/briefs/r2-shell.md`, "Agent contract" and "Constraints". `docs/briefs/r4-features.md`, "Constraints".
- For kit units: `/Users/user/code/rdocx-editing-kit-wt/brief-layout.md` (how the earlier layout fixes were
  briefed and checked), `crates/rdocx/examples/layout_anomaly_check.rs` and `crates/rdocx/src/layout_check.rs`.
- The files each unit names.

## Findings from the survey

Read from the code on 2026-11-21 by three read-only surveys. Nothing below was run. Items marked inferred were
derived by arithmetic or by reading only one side. Paths starting with `crates/` are in the kit,
`/Users/user/code/rdocx-editing-kit`, branch `work/editing-kit-grok` at `077a5d67`.

Merged rows:

1. Table rows are placed one at a time with no look-ahead (`crates/rdocx-layout/src/paginator.rs`, the row loop
   near line 1041). A row that does not fit moves whole to the next page once, and is then painted whole even when
   it is taller than the page.
2. `split_simple_table_row` splits an ordinary row at paragraph or line boundaries. It returns `None` for a row
   with any cell where `is_vmerge_continue`, `starts_vmerge`, `merge_with_below`, `clip_content`, a rotation or a
   vertical alignment is set. Its doc comment calls this a fallback "until those cases have their own safe break
   model".
3. A vertical merge is not placed as a unit. The restart cell is left out of its own row's height
   (`table.rs` near 807). When its content is taller than the span, the last row of the span grows (`table.rs`
   837-871). The restart cell is painted from its own row's y with the summed height of the span, and
   continuation cells paint nothing (`paginator.rs` near 5556).
4. Inferred from 1 to 3: the defect is wider than "a row taller than a page". Any vertical merge whose rows land
   on two pages paints the restart cell's content past the bottom of the first page. Removing the refusal in 2
   does not fix it, because the height that overflows belongs to a cell of another row.
5. No test has a vertical merge that crosses a page. Layout tests build their documents in code
   (`crates/rdocx/tests/regression_test.rs`, for example
   `table_row_fragments_preserve_merge_and_body_ownership`).
6. The repo does not record what Word does at such a break. The reference is the PDF Word made of the private
   document.
7. `layout_anomaly_check` prints `layout_pages`, `pdf_shortfall` and per-page counts, and with a third argument
   `word_pages` and `word_shortfall`. Its `text_outside_page_runs` tests against the paper edge only, so text
   below the bottom margin and above the paper edge is not flagged.

Memory:

8. Each face added to the session is copied whole five times during one `print_layout`, used or not: the
   session's `Arc<[u8]>` (`engine/src/lib.rs`, `add_font`), `to_vec()` into `LayoutInput.fonts`
   (`crates/rdocx/src/document.rs` near 37453), `to_vec()` into `FontManager.additional_fonts`, a clone into
   fontdb's `Source::Binary`, and a clone into `ReusableEngineContext.fonts` (`crates/rdocx-layout/src/engine.rs`
   near 2922 and 3836). A face the layout loads gets one more kept copy in `font_data_for_face`
   (`crates/oxml-layout/src/font.rs` near 3149), shared from there into `LayoutResult.fonts`.
9. Every layout entry point takes `&[(&str, &[u8])]`. None takes shared bytes.
10. Every session face goes to every layout (`engine/src/lib.rs` 187-191). `fontsUsed` returns the fonts of every
    paragraph style in the style table, not of the text, so a style table that names four Chinese families
    fetches four faces and their bold faces.
11. `wasmMemoryBytes()` is the size of the linear memory, which never shrinks, so it reports the high-water mark.
12. The recorded sizes (490 MB for `basic.docx`, 1.3 GB for the private document) are 10 to 11 times the face
    bytes. Finding 8 explains 5 to 7 times. The rest is not explained.
13. How the runtime counts wasm memory and `ArrayBuffer`s against `heapMb: 512` is not documented and was not
    measured. The private document reached 1.3 GB and no failure was recorded.
14. `ensurePrintFonts` holds every fetched face in the page at once until all are added.

Page breaks:

15. The editing view shows 50 pages for `long.docx` and the preview 59.
16. `long.docx` is 634 paragraphs in Calibri 11 pt with `eastAsia` also Calibri, no document grid, no table. Each
    body paragraph ends in one run that mixes 124 Latin and 22 Chinese characters.
17. Inferred, the leading candidate: the editing view gives every segment of that run Carlito's line box. rdocx
    replaces the font of a whole run when the font cannot draw all of it (`engine.rs` near 9925), so the run and
    its Latin text move to the caller's Chinese face with a taller box. A paper model of both gives 50 and 59.
    The same reading means the PDF draws that Latin text in a Song face, which Word would not do. Not confirmed.
18. Verified differences that `long.docx` does not exercise and Chinese documents do: a direct `exact` line rule
    is imported as `atLeast` (`engine/src/import.rs`, `direct_props`); the editing view snaps `exact` lines to
    the document grid and rdocx does not; the editing view adds the space after one paragraph to the space before
    the next and rdocx takes the larger (`paginator.rs` near 1597); `charSpace` of the grid is imported and
    ignored; `snapToGrid`, tab stops and footnote bodies are not imported.
19. Nothing compares the two paginations. The editing view answers a page per block (`blocks` of `word.call`).
    `PrintLayout` keeps the layout and drops `body_layout_fragments`, which hold a `physical_page` per body item.

Borders:

20. `src/editor/view.css` draws inset shadows on every table and every `td`. The model, the wire format and the
    importer carry no border. rdocx resolves direct `w:tblBorders`, then the table style chain, then `w:tcBorders`,
    and the facade exposes them (`TableRef::border`, `style_id`, `CellRef::border`,
    `style(id).table_properties()`).
21. A table the editor inserts is written with single 0.5 pt black borders on all six edges and no table style
    (`engine/src/write.rs` near 2305). In the model it has `props: {}`.
22. `verify.rs` compares a hand-built projection of a table that would not include a new field.
23. No fixture has a table with borders from the file or from a style.

## Data shapes

| Shape | Structure | Owner |
| --- | --- | --- |
| Block pages of a print layout | `PrintLayout::block_pages() -> [{ index, firstPage, lastPage }]`, one entry per body block of the model in order, 0-based pages, from `body_layout_fragments`. `index` is the model's body block index, mapped through the session's source map and tested against the import. | `engine/src/print.rs` |
| Drift report | A pure function `drift(edit: (number \| null)[], print: { firstPage, lastPage }[]) -> { blocks, samePage, share, firstDiff: number \| null, editPages, printPages }`. `samePage` counts blocks whose first page is equal on both sides. | `src/editor/drift.ts` |
| Memory stages | One record per print: `{ baseline, afterFonts, afterLayout, afterPdf, afterPng }` in bytes of wasm memory, plus `faceBytes`, the sum of the faces passed to that layout. The existing `memoryBefore` and `memoryAfter` become two of its fields. | `src/app.ts` (`measurePrint`), `scripts/print-bench.mjs` |
| Shared font bytes | In the kit, caller font bytes are `Arc<[u8]>` from the entry point to fontdb and to `LayoutResult.fonts`. New entry points take `&[(&str, Arc<[u8]>)]`. The `&[u8]` entry points stay and wrap them. | kit `font.rs`, `engine.rs`, `document.rs` |
| Table borders | `Table.props.borders?: { top, left, bottom, right, insideH, insideV }` and `Cell.borders?: { top, left, bottom, right }`, each edge `{ style: 'single' \| 'double' \| 'dashed' \| 'dotted', widthPt, color } \| null`. `null` is an edge the file says has no line. An absent `borders` means the file says nothing. The wire types mirror this and omit the field when absent, so the import goldens do not change. | `src/model.ts`, `engine/src/wire.rs` |
| Fragment of a merged cell | Decided by unit 1's first step and written into its report before code: how a restart cell's blocks are divided at a page break and which row of the next page carries the rest. | kit `paginator.rs` |

## Units and their checks

Units 1 and 2 are kit work, dispatched one after the other in the kit worktree
`/Users/user/code/rdocx-editing-kit-wt/layout`. Units 3 and 4 are app work in the app worktree, and can run
beside the kit units. Each unit is a separate dispatch and ends in its check.

1. **A vertical merge breaks across pages (kit).** Findings 1 to 7.
   - First step, no layout code yet: a failing test in `regression_test.rs`, built in code, with a three-row
     vertical merge whose restart cell holds enough paragraphs to cross a page, and a second with a restart cell
     taller than a whole page. Each asserts that no text lies below the bottom margin of its page and that every
     paragraph's text appears once. Extend `layout_check` so `text_outside_page_runs` also counts text between
     the bottom margin and the paper edge that is not in a footer, and print it as its own line. Run the check on
     the private document and record `layout_pages`, `pdf_shortfall` and the new line.
   - Then the fix. A restart cell's content divides at paragraph or line boundaries where the page ends, the
     rest continues in the first row of the span on the next page, and the cell's borders close at the break and
     open again after it. Repeated header rows still repeat. `cantSplit` on a row of the span keeps that row
     whole, not the span.
   - Check: both new tests pass. The existing table tests in `regression_test.rs` and `table.rs` pass. On the
     private document the new below-margin line is 0, `pdf_shortfall` is at most 30 (Word's own PDF: 26), and
     `layout_pages` is reported next to Word's 35. If the page count still differs, name the first page where
     the two diverge and stop there. `scripts/e2e/print.mjs` passes its reference case on the host, or the
     report gives the threshold that still fails with both numbers. Page images of the pages that held the
     overflow, before and after, under the kit worktree's `target/sample/` (never committed).
   - `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, the wasm32 check, and the hash harness.
     A hash baseline that moves is listed with the reason.
2. **One copy of each face (kit, engine, binding).** Findings 8 to 14.
   - First step: the memory stages for `basic.docx`, `long.docx` and the private document, in Node through
     `scripts/print-bench.mjs` and in the runtime through `scripts/e2e/print.mjs` (run by the reviewer). From
     them, the multiple of `faceBytes` each stage adds. State what accounts for the part finding 12 leaves
     unexplained, by measurement, before changing anything. In the runtime, also record whether a layout of the
     private document at today's size logs or fails anything (finding 13).
   - Binding: `fontsUsed` returns the families of the text runs and of the styles that paragraphs use, not the
     whole style table. `ensurePrintFonts` fetches, adds and drops one face at a time.
   - Kit: the shared font bytes shape above. `font_data_for_face` returns the `Arc` it was given for a caller
     face. Engine: `Session::print_layout` passes `Arc::clone` of each session face.
   - Check: `node --test` for the narrowed `fontsUsed` (a style table that names four Chinese families, text
     that uses one: one face). The kit's font tests pass. A kit test that lays out with a shared face and asserts
     `Arc::strong_count` shows the layout result shares it. The memory stages again: the high-water mark is at
     most `baseline + 2.5 x faceBytes`, `basic.docx` stays under 200 MB, the private document under 512 MB. If
     a target is missed, the report gives the stage table and the copy that remains. PDFs of the three documents
     have the same `pdftotext` output and the same `pdffonts` list as before the change.
   - `shell-print.mjs` still passes, including its five-preview growth check.
3. **The editing view breaks pages where the preview does (engine, app).** Findings 15 to 19.
   - First step: `PrintLayout::block_pages`, `drift.ts` with its `node --test`, and a `window.__word` hook that
     returns the drift report for the open document. `scripts/e2e/drift.mjs` prints the report for
     `basic.docx`, `long.docx` and the private document. Then the test finding 17 needs: `long.docx` laid out in
     `engine/tests/print.rs` with and without the Chinese face, the page count of each, and `pdffonts` plus one
     page image to show which face draws the Latin text of a mixed run.
   - Then, by what the first step shows:
     - If finding 17 holds and the PDF draws Latin text in the Chinese face: that is a kit defect. Fix the font
       choice so only the characters a font cannot draw move to the fallback face, with a regression test in
       the kit, and measure the report again before touching the editing view.
     - The editing view gives each segment the line box of the face that paints it: Han text in a run whose
       font has no Han glyphs gets the metrics of the face the font service resolves for it.
     - The verified differences of finding 18: import a direct `exact` rule as `exact` (a kit getter if the
       facade lacks one), do not snap `exact` lines to the grid, and collapse adjacent paragraph spacing to the
       larger value as rdocx does. Each with a test in `derive.test.ts` or `pages.test.ts`, and the import
       change with a golden.
   - Check: on `long.docx` and on the private document, `share` is at least 0.9 and the page counts differ by at
     most 2 percent. The report before and after goes into the brief's status. `charSpace`, `snapToGrid`, tab
     stops and footnotes stay out unless the report after the fixes names one of them as the largest remaining
     cause. In that case stop and report it.
   - Keystroke time must not move: the round 2 typing check in `shell-input.mjs` passes, and the p95 of a
     one-character edit on `long.docx` is reported next to the 0.46 ms of `design.md`.
4. **Table borders from the file (engine, app).** Findings 20 to 23.
   - The borders shapes above. The importer fills them from the direct table borders, then the table style
     chain, then the cell's own. `render.ts` draws each cell's four edges as inset shadows from the resolved
     borders, and `view.css` loses the rule that draws them on every table. A table inserted by the editor gets
     in the model the borders `write.rs` writes for it. `write.rs` and `verify.rs` do not change.
   - `tools/corpus` gains one fixture, `tables.docx`: a table with no borders, one with direct borders, one
     with the Table Grid style, and one whose cell overrides an edge to none.
   - Check: `cargo test` import golden for `tables.docx`. `render.test.ts`: each of the four tables gives the
     expected edges, and an edge shared by two cells is drawn once. `scripts/e2e/shell-table.mjs` still passes,
     and a new case opens `tables.docx`, reads the computed shadow of one cell per table, inserts a table, saves
     and reopens: the inserted table has borders in both views. A screenshot of the editing view and of the
     preview's first page side by side under `docs/design/evidence/tables/`.
   - A full-width table keeps its right edge (the reason commit `da030a2` moved to shadows). `shell-table.mjs`
     already checks it.

Before each unit is reported done: `npm run typecheck`, `npm test` (4 known failures in `server/fonts.test.ts`,
nothing else), and when Rust changed, `cargo test`, clippy, fmt and `npm run engine`.

## Not in this round

Cell padding and header row fill that differ between the views, cell shading, custom tab stops, footnotes,
columns, the unexplained `engine.wasm: 404`, and the items of round 5 that need a person (a PDF opened in a
reader, a CFF face).

## Constraints

- All constraints of the round 2, 3, 4 and 5 briefs apply.
- The private document is read from `WORD_TEST_DOC` and `WORD_TEST_REF_PDF`. Never commit it, never copy it
  into the repository, and never put its text in a test, a report or a commit message. Report counts and page
  numbers only.
- Kit changes are made in `/Users/user/code/rdocx-editing-kit-wt/layout` on `work/editing-kit-layout`, never in
  `/Users/user/code/rdocx-editing-kit` itself. The reviewer fast-forwards `work/editing-kit-grok` after review.
- No layout at idle, in any unit. The drift report runs only from the dev hook.
- Kit public signatures that exist stay. New behaviour arrives through new functions or through fixes.
- Cargo runs with `--offline`. The engine builds with `RUSTUP_TOOLCHAIN=nightly
  SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`, clippy and fmt with `RUSTUP_TOOLCHAIN=1.97.1`.
  Unset `CARGO_TARGET_DIR` before `npm run engine`.
- The sandbox cannot reach the `acde dev` socket. Write the e2e script, run everything else, and say in the
  report that the e2e was not run.
- Do not commit. Leave the changes in the working tree. End with a report: what changed per file, each check
  and its result, each number measured before and after, each inferred finding and whether it held, each
  decision this brief did not make, and anything left open.

## Success

A reviewer opens the private document, opens the preview and exports it: no text runs past a page, and the
window's memory stays under its limit. The status bar's page count in the editing view is within 2 percent of
the preview's. `tables.docx` looks the same in both views as far as its lines go. All unit checks pass when
rerun from a clean checkout after `npm run engine`.
