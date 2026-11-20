# Round 5 brief: print preview and PDF export

Status: all three units pass their checks on `r5/print` (2026-11-20). The engine links layout and PDF, and
`public/engine.wasm` is 24.8 MB (5.9 MB before). Measured in the runtime: layout 94 ms and 932 ms, one page image at
144 dpi 141 ms and 229 ms, for `basic.docx` and `long.docx`.

A real 35 page government form (private, read from `WORD_TEST_DOC` and `WORD_TEST_REF_PDF`, never committed) showed
two rdocx layout defects, both fixed on the kit branch `work/editing-kit-grok` with a regression test each:
`w:charSpace` was read as twips instead of 4096ths of a point (reversed, spread-out text), and a table after a
full-width floating table was drawn through it. On that document the PDF went from 30 pages and 1,180 missing
characters to 37 pages and 82 missing (Word: 35 pages, 26 missing).

Open:

- A vertically merged table row taller than a page is placed whole and runs past the page box. The 82 missing
  characters are there. `scripts/e2e/print.mjs` fails its reference case for this reason.
- Wasm memory is 490 MB after one layout of `basic.docx` and 1.3 GB for the real document. The layout copies each
  font's bytes about five times. It does not grow on later layouts.
- The page count of the preview differs from the editing view's (59 against 50 for `long.docx`).
- The preview shows a table without borders as the file has it. The editing view draws borders on every table.
- `shell-input.mjs` and `shell-app.mjs` each logged `engine.wasm: 404` once in one regression run and passed five
  reruns. Not explained.
- Not verified: an exported PDF opened in a PDF reader by a person, a CFF `.otf` CJK face, the abort path when the
  engine panics.

## Goal

A user opens print preview, sees the pages as rdocx lays them out with the system's Chinese fonts, and exports
that same layout as a PDF. The PDF embeds every font it uses, Chinese text is real text and not boxes, and it holds
the document as edited, not as opened. Today `Source.exportPdf` throws and the engine links no layout or PDF code.

The rule for this round: one layout serves both. The preview and the PDF are made from the same `LayoutResult`, so
the file the user exports is the one the preview showed.

## Read first

- `docs/design/design.md`, "Grafted from candidate A" items 1 and 2, and the measured numbers in "Synthesis
  decision". `docs/design/candidate-b/design.md`, "CJK fonts in PDF export". `docs/design/grounding.md`.
- `docs/briefs/r2-shell.md`, "Agent contract" and "Constraints". `docs/briefs/r4-features.md`, "Constraints".
  All of them apply here.
- `engine/src/lib.rs` (`Session`, `save_result_tampered`), `engine/src/write.rs` (`write`, `Written`),
  `engine/Cargo.toml`.
- `src/engine/engine.ts` (`Source`, `exportPdf`, `fontsUsed`, `addFont`, `toPatch`, `documentPatch`),
  `src/fonts.ts` (`fetchFonts`, `aliasChain`), `server.ts` and `server/fonts.ts` (`/api/fonts`,
  `/api/fonts/resolve`, `/api/fonts/:id/face`, `extractFace`).
- `src/app.ts` (`pickSave`, `writeBytes`, `performSave`), `src/ui/toolbar.ts`, `src/ui/dialog.ts`, `index.html`.
- The rdocx kit at `/Users/user/code/rdocx-editing-kit/crates`: in `rdocx/src/document.rs` the functions
  `layout_with_fonts_aliases_and_bundled_fallback_and_options` and its siblings, in `oxml-pdf/src/lib.rs`
  `render_to_pdf_checked` and `render_page_to_png`, in `oxml-layout/src/output.rs` `LayoutResult`, `PageFrame`,
  `FontData`, and in `oxml-layout/src/font.rs` `load_caller_font`.

## Findings from the survey

Read from the code on 2026-11-20. Items marked inferred or unmeasured were not run. Settle each one named in a
unit below with a test or a measurement before you build on it.

1. `Document::layout_with_fonts` has no bundled fallback. The variants named `_and_bundled_fallback` do. Latin
   fonts the system lacks (Calibri) must still come from the bundled substitutes.
2. `oxml_pdf::render_to_pdf_checked(&LayoutResult)` renders an existing layout to PDF, and
   `oxml_pdf::render_page_to_png(&LayoutResult, page_index, dpi)` renders one page of the same layout to a PNG.
   `rdocx` does not export them again, so the engine needs `oxml-pdf` as a path dependency.
3. `write::write` returns `Written { document, .. }` before any bytes exist. A layout of the edited document can
   use that document directly.
4. This machine has no SimSun. The font service resolves 宋体 to Songti SC (face 3 of
   `/System/Library/Fonts/Supplemental/Songti.ttc`, 19.8 MB extracted), 黑体 to Heiti SC (52.8 MB), 楷体 to Kaiti SC
   (28.0 MB), 仿宋 to STFangsong (15.2 MB). The design's check "embeds SimSun" becomes "embeds the face the font
   service resolves 宋体 to".
5. Caller font bytes are copied when a layout loads them. Whether the faces `basic.docx` needs (about 48 MB) fit
   in the window's 512 MB heap next to the wasm memory is unmeasured.
6. A caller face given under a Latin family name would override the bundled bold of that family and get synthetic
   bold (inferred). Only CJK faces are passed as caller fonts.
7. The PDF writer emits TrueType CID fonts only. A CFF `.otf` face would likely embed wrongly (inferred).
8. Whether a whole `.ttc` passes through layout and PDF is untested. `extractFace` already returns one face.
9. With layout, PDF and bundled fonts linked, `grounding.md` gives a wasm size of 17 to 19 MB. Today it is 5.9 MB.
10. A 37 page Chinese layout took 548 ms in wasm. There are no Web Workers, and a task over 5 s marks the window as
    not responding.
11. `engine/Cargo.toml` sets `panic = "abort"`. A panic in layout or PDF code leaves the session unusable.
12. `window.print` is not documented in acdert. This round does not use it.

## Design decision: the preview is page images

`design.md` item 2 says the preview paints `PageFrame`s as positioned HTML spans. This round renders each page with
`render_page_to_png` instead and shows it in an `img`. The reasons: the image is rdocx's own rasterization of the
layout, so it cannot drift from the PDF, while span painting depends on acdert shaping glyphs the same way (candidate
A's risk 3, unproven). The preview is read only, so it needs no text nodes. The cost is raster time per page, which
unit 2 measures. If one page at 144 dpi takes more than 400 ms in wasm on `basic.docx`, stop and report instead of
building unit 3.

## Data shapes

Choose these before writing logic.

| Shape | Structure | Owner |
| --- | --- | --- |
| Print layout | One wasm object `PrintLayout` that owns a `LayoutResult`: `page_count()`, `page_size(index) -> [widthPt, heightPt]`, `page_png(index, dpi) -> bytes`, `pdf() -> bytes`, `fonts() -> [{ family, embedded }]`, `free()`. Made by `Session::print_layout(patch_json)`. Preview and export both read it. Nothing else lays out. | `engine/src/print.rs`, `lib.rs` |
| Session fonts | `Session::add_font(family, bytes)` and `Session::add_font_alias(requested, loaded)` keep caller faces for the life of the session, each face stored once. `print_layout` passes them by reference. A family added twice replaces the first. | `lib.rs` |
| Caller font plan | A pure function `printFonts(families, catalog) -> { faces: { id, family }[], aliases: [requested, loaded][] }` over the families the document uses and the `/api/fonts` list: only faces flagged `cjk`, only TrueType outlines, each physical face once, every other requested spelling of it as an alias. When the document has any Han character and no CJK family resolves, the face for 宋体 is added so no text falls back to boxes. | `src/fonts.ts` |
| Print errors | A tagged union `PrintError = { kind: 'font', family } \| { kind: 'layout', detail } \| { kind: 'render', detail }`, decoded from the engine like the save errors are. Layout and render code in the engine returns `Result`. It does not `unwrap` or `expect` on document content. | `engine.ts`, `print.rs` |
| Preview state | A state machine `closed -> preparing -> open -> exporting -> open`, and `preparing -> failed -> closed`. One object holds the `PrintLayout` and the blob URLs of rendered pages, and `close` frees the layout and revokes the URLs. No booleans beside it. | `src/ui/preview.ts` |
| Page images | Rendered on demand: an `IntersectionObserver` asks for the visible pages plus one each side, one page per animation frame. Each `img` has the page's size from `page_size` before its image exists, so the scroll height is exact from the start. | `src/ui/preview.ts` |

## Scope

In scope:

- Engine: `print.rs`, the session fonts, `PrintLayout`, the `oxml-pdf` dependency.
- Binding: `Source.printLayout(doc)` replaces the `exportPdf` and `exportHtml` stubs, which are deleted with their
  declarations. `addFont` sends bytes to the session. `printFonts` and the fetch of the faces.
- App: one toolbar button, 打印预览 / Print preview. The preview takes the place of the page view: a bar with the
  page count, an Export PDF button and a Close button, and the page images below it. Escape closes it. While it is
  open the document cannot be edited and the editing toolbar is hidden. Closing returns to the document with the
  selection and the scroll position it had.
- Export PDF writes `pdf()` through the save picker with the PDF type and the document's name with `.pdf`.
  It does not change the open file, the title or the dirty state.
- A status line while the layout is being prepared, painted before the blocking call starts.

Not in this round: printing to a printer, page ranges, PDF/A or other conformance options, a direct Export PDF
button on the editing toolbar, selectable text in the preview, zoom in the preview beyond fit-to-width.

## Units and checks

Each unit ends in its check. Do not start the next unit before the check passes. Each unit is a separate dispatch.
The delegate's sandbox cannot reach the `acde dev` socket, so the delegate writes each e2e script and the reviewer
runs it on the host.

1. **Engine print layout (Rust).** Findings 1, 2, 3, 6, 7, 8, 11. Native `cargo test` in `engine/tests/print.rs`.
   The tests read the CJK face from the path in `WORD_TEST_CJK_FONT`, default
   `/System/Library/Fonts/Supplemental/Songti.ttc`, and fail with a message that names the variable when the file
   is missing. They write PDFs under a temporary folder and run `pdffonts` and `pdftotext` (poppler 26.11 is
   installed in `/opt/homebrew/bin`).
   - `basic.docx` with the face added as 宋体 and aliased for SimSun: `pdffonts` lists no font with `emb` `no`, and
     lists a font whose name starts with the PostScript name of the face. `pdftotext` output, with whitespace
     removed, contains the text of every body paragraph of the import with whitespace removed, in order.
   - The same with no caller font: the layout succeeds, and the test records what `pdftotext` returns for the
     Chinese paragraphs, so the difference the caller font makes is visible in the test.
   - A patch that changes one paragraph's text to a new Chinese sentence: the PDF holds the new sentence and not
     the old one. The session's own document is unchanged afterwards: `save` of an all-keep patch still imports
     equal to the original.
   - `page_count` equals the number of pages `pdfinfo` reports. `page_size(0)` equals the section's page size.
     `page_png(0, 144)` is a PNG whose pixel size is the page size times two.
   - The whole `.ttc` passed as the face, against one face extracted from it (finding 8). State which works.
   - `pdf()` called twice on one layout returns equal bytes. Two layouts of the same patch give PDFs with equal
     `pdftotext` output.
   - `long.docx`: the layout and `pdf()` succeed, and the test prints the page count and both times.
   - `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, the wasm build, and the size of
     `public/engine.wasm` before and after.
2. **Binding, fonts and the measurements (TypeScript).** Findings 4, 5, 9, 10. `Source.printLayout`, `printFonts`,
   font bytes into the session, `PrintError`. `window.__word` gains a dev hook that makes a layout and returns the
   page count, the PDF as base64 and the times.
   - `node --test`: `printFonts` on a catalog like this machine's (宋体 and SimSun give one Songti face and one
     alias, Calibri gives nothing, an `.otf` CJK face is left out, Han text with only Latin families adds the 宋体
     face). `Source.printLayout` on `basic.docx` in Node with the Songti face read from disk: page count above 0
     and a PDF header.
   - `scripts/e2e/print.mjs` through the hook, on `basic.docx` and `long.docx`: record font fetch time, layout
     time, `pdf()` time, the time of `page_png(0, 144)`, the wasm fetch and compile time at boot, and
     `performance.memory` or the wasm memory size before and after. Write the PDF to a temporary folder and run
     the unit 1 poppler checks on it. Pass when no single blocking call exceeds 3 s and no error is logged.
3. **Preview and export (app).** The preview state machine, the page images, the bar, the toolbar button, Export
   PDF, strings in both locales.
   - `node --test` for the state machine transitions, including `preparing -> failed -> closed` and that `close`
     frees the layout once.
   - `scripts/e2e/shell-print.mjs`, only through `acde act` and `acde inspect`: open `basic.docx`, type a Chinese
     sentence, open the preview by its button, the bar shows the page count, the first page `img` has a natural
     size, the editing toolbar is not reachable. Export with `acde choose save` pointing into a temporary folder:
     the file passes the unit 1 poppler checks and holds the typed sentence. The title and the dirty mark are as
     before the export. Escape closes the preview, the caret is where it was, typing works again. Open and close
     the preview five times and the wasm memory does not grow by more than one layout. A screenshot of the preview
     in each locale under `docs/design/evidence/print/`.

Before each unit is reported done: `npm run typecheck`, `npm test` (4 known failures in `server/fonts.test.ts`,
nothing else), and when Rust changed, `cargo test`, clippy, fmt and `npm run engine`.

## Constraints

- All constraints of the round 2, 3 and 4 briefs apply.
- Never call `Document::to_pdf` or any `to_pdf_with_fonts` variant. They lay out again. The PDF comes from
  `render_to_pdf_checked` on the `PrintLayout`'s own `LayoutResult`.
- No layout at idle. A layout runs only when the user opens the preview.
- The engine builds with `RUSTUP_TOOLCHAIN=nightly SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
  Clippy and fmt run with `RUSTUP_TOOLCHAIN=1.97.1`. Run cargo with `--offline`. The sandbox has no network. If a
  new crate is not in the offline cache, stop and report it. The reviewer fetches it on the host.
- Use only the fixtures in `fixtures/`. System font files may be read. Write test output under a temporary folder.
- Do not commit. Leave the changes in the working tree. End with a report: what changed per file, each check and
  its result, each finding you settled and how, each number you measured, and anything left open.

## Success

A reviewer opens `fixtures/basic.docx`, types a Chinese sentence, opens the preview, exports a PDF and opens it in
a PDF reader: the sentence is there in a Song typeface, every font is embedded, and the pages match the preview. All
unit checks pass when rerun from a clean checkout after `npm run engine`.
