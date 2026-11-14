# Candidate A: layout-driven WYSIWYG

Sketches: [`engine.rs`](engine.rs) (wasm surface and executor), [`wire.ts`](wire.ts), [`editor.ts`](editor.ts),
[`input.ts`](input.ts), [`view.ts`](view.ts), [`server.ts`](server.ts). Citations use the grounding's prefixes
(D = rdocx `document.rs`, P = `paragraph.rs`, R = `run.rs`, T = `table.rs`, L = `rdocx-layout/src/lib.rs`,
E = `rdocx-layout/src/engine.rs`).

## Problem

We need a Word-like editor for Dopame OS whose pages look exactly like Word's and whose saved files keep everything the
editor does not understand. Chinese government forms and theses are the real workload. In acdert, `contenteditable` is
nearly inert, there are no Web Workers, SVG ignores web fonts, and only absolutely positioned HTML spans with a CSS
`@font-face` paint the right font. rdocx compiles to wasm (17-19 MB), lays out 14 pages in 16-18 ms after a small edit
(about 1.1 ms per page, whole document, no incremental API), and gives every glyph run a `SourceSpan` back to its
paragraph. The shape has to answer the following questions:

- How does an editor whose state is a `Document` that is not `Clone` get undo?
- How do Enter and Backspace work when rdocx has no paragraph split or merge, and no in-place block removal?
  `try_remove_content` D:26226 clones and reopens the whole package through `prepare_and_reopen_staged` D:18349.
- How does CJK get into layout when wasm has no system fonts and `layout_with_fonts*` copies and byte-compares the
  caller's font bytes on every call (E:2733, D:35644)?

This candidate's answer is that the rdocx `Document` in the page is the only document state, rdocx layout is the only
geometry, and the TypeScript side never sees a position, a run, or a paragraph.

## Usage (caller's view)

The caller of the engine is the TypeScript editor shell. It sends commands, pulls one `Update` per animation frame,
and asks for page views only for visible pages whose hash changed.

```ts
// main.ts: boot, then open whatever the system hands us.
const session = await EditorSession.boot(document.querySelector('#app')!)
self.on('request', (r) => { if (r.kind === 'open-file') void session.openHandle(r.handle) })

// input.ts: one keystroke. No layout here; the session paints on the next frame.
textarea.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'insertText' && !ime.composing) { e.preventDefault(); session.run({ type: 'insertText', text: e.data! }) }
})

// chrome.ts: toolbar and menu. State comes back in update.format; nothing is read from the DOM.
boldButton.onclick = () => session.run({ type: 'toggleMark', mark: 'bold' })
menu('file', [{ id: 'save', label: t('save'), shortcut: 'mod+s', onSelect: () => session.save() }])
session.onUpdate((u) => { boldButton.ariaPressed = String(u.format.bold === 'on'); status(u.where, u.dirty) })
```

Native Rust tests drive the same `Session` without wasm. The first call site in `engine.rs` shows that use.

## Shape

### Core data shapes (named first)

**Position and selection (engine-internal, never on the wire).**
`Pos { para: ParaAddr, offset: u32 }`. `offset` counts Unicode scalars of `ParagraphRef::text()`, which is the
unit `SourceSpan` uses (tab, break and CR count 1, drawings 0). `ParaAddr` is a closed enum of the places the editor
can write:
`Body { content }` (direct body child, `insert_paragraph` / `remove_content` index),
`InControl { paragraph }` (block-SDT paragraph, `paragraph_mut` index), and
`Cell { table, row, col, para }` (`table_mut` → `Table::cell` T:2007 → `Cell::paragraph_mut` T:2291).
`Selection { anchor, focus, goal_x, pending: Option<RunPatch> }`. `goal_x` drives Up and Down. `pending`
holds marks toggled at a collapsed caret, which is how typing after Ctrl+B comes out bold. `Composition { start, len }`
is the live IME range. A resolver maps `WordSourcePath` (L:47) to `ParaAddr` and back. It is the only code that
knows rdocx's index arithmetic. That arithmetic is uneven: `nth_paragraph_in_body` D:14516 skips top-level tables
but enters tables inside SDTs. A path the resolver cannot prove maps to no `ParaAddr`, so that content is read-only.

**Command (TS → engine).** A serde-tagged enum: `insertText`, `insertParagraph`, `insertLineBreak`,
`delete{dir,unit}`, `move{unit,dir,extend}` (unit is `char | word | lineEdge | line | screen | docEdge`),
`pointer{phase,at,clicks,extend}` (`at` in document points), `selectAll`, `compose{start|update|commit|cancel}`,
`toggleMark`, `setRun`, `setParagraph`, `toggleList`, `listLevel`, `paste{text}`, `insertTable`, `table{op}`,
`pageSetup`, `undo`, `redo`. Commands carry intent, never positions. The engine resolves `move` and `pointer` against
its own layout.

**Engine JS API (`Editor`, 15 methods).** `blank()`, `open(bytes)`, `addFont(family, bytes)`, `wantedFonts()`,
`apply(cmd)`, `frame() → Update`, `page(i) → PageView`, `fontBytes(key)`, `mediaBytes(key)`, `selectedText()`,
`insertImage(bytes, name)`, `idle() → bool` (seals an undo checkpoint), `save() → bytes`, `exportPdf() → bytes`,
`stats()`. TS types are generated from the Rust wire types with `tsify` (see `wire.ts`). The command list and the
update shape therefore exist in one place, per **type-system-discipline**: derive types from the authoritative schema.

**View model of a laid-out page.**
`Update { rev, layout?: { pages: PageMeta[], newFonts: FontMeta[] }, caret?, selection: PageRect[], composition: PageRect[],
format: FormatState, where: { page, pageCount }, dirty, notice?, reveal }`. `layout` is present only when the
document was laid out again since the last frame, so selection-only frames (drag-select, arrows) carry a few rects.
`PageMeta { index, width, height, top, hash }` uses points. `top` places the page in one vertical document space
whose page gap is fixed by the engine, so pointer coordinates and PageUp/PageDown use the same space as painting.
`PageView { index, lines: LineView[], shapes: ShapesView }`. `LineView { key, spans: SpanView[] }` is keyed by a
content hash so the painter reuses DOM for lines that did not change.
`SpanView { x, baseline, text, font: FontKey, size, color, ls?, weight?, italic, transform? }`. `FontKey` and
`MediaKey` are content hashes of the bytes in `LayoutResult.fonts` and `Image` elements, so a relayout that
renumbers `font_id` does not reload fonts.

### Module map

| Module | Owns |
| --- | --- |
| `engine/src/lib.rs` | The wasm-bindgen `Editor`. It parses wire types, forwards to `Session`, and is the only file that knows JS exists. |
| `engine/src/session.rs` | `Session`, the single writer of the Document, Selection, Composition, History, ViewCache and FontStore. |
| `engine/src/addr.rs` | `Pos`, `ParaAddr`, `Selection`, the `WordSourcePath` ↔ `ParaAddr` resolver, and word boundaries. |
| `engine/src/kernel.rs` | Paragraph-local edits on `&mut Paragraph`: locate, insert text, delete, classify plain or rich, transplant runs, copy pPr. |
| `engine/src/exec.rs` | Command → document mutations and new selection: Enter, merge, range delete, formatting, lists, tables, images, page setup. Also `transact`. |
| `engine/src/history.rs` | Undo and redo as whole-document checkpoints. Also the saved-state marker. |
| `engine/src/view.rs` | Layout with caller fonts, page hashes, `PageView` building, font and media keys, span letter-spacing. |
| `engine/src/geom.rs` | Per-page line index: caret rect, selection rects, hit test, line, screen and document movement. |
| `engine/src/format.rs` | `FormatState` from effective properties, the style catalog (Normal, Title, Heading 1-3 by name), list definitions, theme fonts. |
| `engine/src/fonts.rs` | Caller font bytes and the Chinese alias table (宋体 → SimSun, 黑体 → SimHei, 仿宋_GB2312 → FangSong …). |
| `src/wire.ts` | Generated by tsify. Never edited. |
| `src/editor.ts` | `EditorSession`: engine lifecycle, frame loop, idle sealing, file handle, save, save as, PDF, dirty title, `beforeclose`. |
| `src/input.ts` | `InputAdapter`: hidden textarea, keymap table, IME state machine, clipboard, pointer → commands. |
| `src/view.ts` | `PageViewport`: page virtualization, keyed line painting, `@font-face` and blob registries, overlays, zoom, client → doc points. |
| `src/chrome.ts` | Toolbar, status bar, `acde:window` menus, zh/en strings keyed by `NoticeCode` and labels. Menu shortcuts are read from `input.ts`'s keymap table, not listed twice. |
| `server.ts` | Font discovery only: lists the CJK families on disk and serves each as one single-face sfnt (TTC faces extracted). |

### Per-keystroke data flow and budget (20-page document)

1. `beforeinput insertText` → `session.run` → `engine.apply`. The kernel finds the run at the caret and calls
   `Run::set_text` R:471, adding `split_run` P:1257 when pending marks need a new run. The history records "dirty since
   the last checkpoint". Nothing is laid out.
2. `requestAnimationFrame` → `engine.frame()`. This lays out with caller fonts
   (`layout_with_fonts_aliases_and_bundled_fallback` D:35587, which has a reusable engine and paragraph cache), hashes
   each page, builds the line index for the caret's page only, and computes rects and `FormatState`.
3. `view.render(update)` calls `engine.page(i)` for each visible page whose hash changed and reconciles lines by key.
4. `input.placeAt(update.caret)` moves the hidden textarea so the IME candidate window follows the caret.

| Step | Cost | Basis |
| --- | --- | --- |
| apply: parse, paragraph lookup, run edit | < 0.2 ms | inferred; O(paragraph) in-place mutation |
| layout, 20 pages | ~22 ms | measured 1.1 ms/page relayout |
| caller font copy and compare, SimSun + SimHei ≈ 20 MB | unknown, guess 4-15 ms | E:2733 compares, D:35644 copies; risk 1 |
| page hashes (~11k runs) + caret-page geometry | ~1 ms | guess |
| Update + one PageView across the boundary | ~1 ms | guess |
| DOM: 1-3 keyed lines replaced, style and paint | ~3-5 ms | guess |
| **Total** | **~27 ms + font tax** | 2 frames if the font tax is ≤ 6 ms |

Input never queues behind layout, because `apply` is cheap and `frame` runs at most once per animation frame. A held
key or a fast typist produces several applies per layout. At 100 pages, layout is about 110 ms, so typing paints at
about 8 Hz. That is usable but visibly laggy. The only real fix is upstream incremental pagination, which reuses page
frames before the first dirty paragraph. This design leaves room for it, because `frame()` is the only caller of
layout.

### Painting

Each `GlyphRun` and `MultilingualGlyphRun` becomes one absolutely positioned `<span>` in a page box whose CSS units
are `pt`. Zoom is one `transform: scale()` on the page stack and never relays out. Fonts come from
`LayoutResult.fonts`. Each `FontKey` gets one `@font-face { font-family: "k<key>"; src: url(blob:…) }`, declared at
weight 400 so a run whose `FontData.synthetic_bold` is set gets browser synthesis from `font-weight: 700`. The painter
measures the browser's baseline offset for each new font key once with a DOM probe, so `top = baseline - ascent(key)
* size` is exact for the browser that paints it. Two things keep span widths equal to rdocx's advances. First, the
engine sets `ls` (letter-spacing) to the mean deviation between rdocx advances and the face's natural `hmtx` advances.
Second, it splits a run where that deviation is not uniform, which is the CJK justification case. Rects, rules and
paths go into one per-page `<svg>` (SVG paints shapes correctly; only SVG text is broken). Images use blob URLs keyed
by `MediaKey`. Only pages within one viewport of the visible area are mounted. The others are sized placeholders.

### IME composition

The hidden textarea is the input sink and sits at the caret rect. Its own text is transparent. Composition is a
provisional document edit, so the preedit wraps and reflows exactly as the committed text will.
`compose.start` deletes a non-empty selection. `compose.update{text}` replaces the composition range with the new
preedit, using pending marks. `compose.commit{text}` replaces it with the final text and ends the composition.
`compose.cancel` removes it. The engine returns `composition` rects and the view underlines them. `idle()` never seals
a checkpoint while a composition is open, so the undo history never contains pinyin. The `InputAdapter` drops
`beforeinput` and `input` events while composing and acts only on `compositionend.data`. This is unverified in acdert
(risk 5).

### Enter and merge from available primitives

The kernel's central rule is the run transplant. A run sequence is **plain** when every item is a direct
`ParagraphItemRef::Run` (P:32), outside any `hyperlink_spans()` P:2989, holding only `Text | Tab | Break |
Drawing(inline)` (R:331), with no comment or bookmark markers between the runs. Plain runs are copied by value into a
`RunValue` (items plus every direct property the `RunRef` getters expose). They are rebuilt with `add_run` P:1043,
`add_text` / `add_tab` / `add_break` / `add_picture(rel_id, w, h)` R:477-500 and the matching setters (R:534-1212),
all in place. Anything else is **rich** and moves as XML in a transaction. A transaction does
`clone_for_staging` D:16519, runs the steps on the clone, swaps the clone in, and keeps the warm layout engine with
`transfer_reusable_bundled_fallback_layout_from_with_aliases` D:35372. A failed step drops the clone, so the command
is atomic.

**Enter** at `Pos { Body{j}, o }`. If `o == 0`, call `insert_paragraph(j, "")` D:25975 and copy pPr through the
`ParagraphRef` getters to the `Paragraph` setters (`set_style` P:1335, `set_alignment` P:1316, indents, spacing,
`set_numbering` P:1361, mark). Paragraph A is untouched. If `o == len`, do the same at `j + 1`. Otherwise
`split_run(k, o_k)` P:1257 gives the tail boundary `b`. If runs `b..n` are plain, insert paragraph `j + 1`, copy the
pPr, transplant the tail, and `remove_run` P:1284 from `n-1` down to `b` in A. Everything is in place, so the cost is
one relayout. If the tail is rich, a transaction runs `clone_content(A → after A)` D:24097 (lossless), removes runs
`b..` from A and runs `..b` from the copy. If `remove_run` refuses (half a field, a note reference), the transaction
aborts with the notice `cannotSplitHere`. In a table cell, Enter on the cell's last paragraph uses `Cell::add_paragraph`
T:2207 in place. Elsewhere in a cell it uses `insert_content` D:23884 in a transaction.

**Merge** (Backspace at offset 0 of B = `Body{j}`, A = `Body{j-1}` a paragraph). The result keeps A's paragraph
properties. If B is plain, transplant B's runs onto A's end in place, then `remove_content(j)` D:26220, which is one
staged op. If B is rich, a transaction takes `paragraph_element_xml` D:22601 for A and B. `kernel::join_xml` appends
B's children (without its pPr) before A's `</w:p>` and merges B's namespace declarations onto A's root. Then
`replace_paragraph_xml(A)` D:22673 and `remove_content(j)` run, which is two staged ops. If A is a table or SDT,
Backspace moves the caret into it and does not merge, as Word does. Delete at a paragraph's end is a merge of the next
paragraph.

**Range delete.** The executor clears A's tail and Z's head in place, removes the whole blocks between them, then
merges A and Z. rdocx has no batched block removal. This is gap G1, the source of risk 2: `k` blocks cost `k` staged ops
in one transaction. A range whose ends are in different table cells clears the covered cells' text. It never removes
part of a table.

### Undo with a non-Clone Document

Undo uses whole-document checkpoints. It does not invert individual commands. `History { past: Vec<Checkpoint>,
future: Vec<Checkpoint>, dirty: bool, saved: Option<CheckpointId> }`, where `Checkpoint { id, bytes, resume: Selection }`.

- The bottom checkpoint is the opened file's own bytes, so it costs nothing.
- `seal()` runs `to_bytes` D:18197 (on a staged clone; the live layout cache is untouched) when the document changed
  since the top checkpoint. It runs from `idle()` 700 ms after the last input and before every discrete command
  (formatting, paste, table, image, page setup). Typing, Enter, Backspace and Delete coalesce until the next seal, which
  gives Word's "Undo Typing" granularity.
- The first edit after a seal stores the pre-edit selection in the top checkpoint's `resume`, so undo puts the caret
  where the edit happened.
- `undo` captures the current state into `future` if it is dirty, then restores the top of `past`. Restoring means
  `Document::from_bytes` D:17719, a warm-engine transfer D:35372, and `selection = resume`. `redo` is symmetric.
- `save` seals, then writes the top checkpoint's bytes, so a save costs one `to_bytes` and makes the state clean.
- Checkpoints are compressed `.docx` bytes, a few hundred KB for text documents. `past` is capped by total bytes
  (128 MB, under `heapMb: 512`) by evicting the oldest.

This is exact for every command, including styles, numbering definitions, sections and media, because it is the save
path rdocx already guarantees. It adds no per-command inverse code. Every staged op already pays for the same
zip-and-reparse round trip. It is a cost the system already accepts, not a new mechanism, per **laziness-protocol**.

### CJK fonts into layout and PDF

`server.ts` is the backend, and it does only this. It scans the platform font folders for a fixed family table
(SimSun, SimHei, KaiTi, FangSong, Microsoft YaHei, Songti SC, Noto Serif/Sans CJK SC). It answers
`GET /api/fonts` with the families present and `GET /api/fonts/:family` with one single-face sfnt. It extracts the face
from a `.ttc`, because `@font-face` cannot select a collection index and Dopame OS ships Noto CJK as TTC. After `open`,
the page asks `wantedFonts()`. That returns the families the document's styles, runs (all four font slots) and theme
reference, plus a CJK fallback. The page fetches the ones the backend has and calls `addFont` before the first
`frame()`. `FontStore` passes `(family, bytes)` and the alias table to
`layout_with_fonts_aliases_and_bundled_fallback` D:35587. The resulting `LayoutResult.fonts` hold exactly the bytes
each run used, so the screen paints with the same faces. PDF export is `oxml_pdf::render_to_pdf_checked(&layout.layout)`
on that same `WordLayoutResult`. It never calls `Document::to_pdf` D:35659, which lays out again without caller fonts.
The PDF is the screen.

### Content the editor cannot address

| Content | Behavior |
| --- | --- |
| Glyph runs with `source: None` (list markers, field results, caps text) | Painted. Hit-testing snaps to the nearest addressable stop on the same line. The caret skips them. |
| Fields | A whole-field run is removed whole by `remove_run`. Cutting part of a field is refused with notice `fieldBoundary`. |
| Comments, bookmarks, unknown XML in a paragraph | Never touched by run edits (`remove_run` keeps markers, `split_run` clones rPr). A range containing them makes a transplant rich, so it moves as XML. |
| Inline SDTs, hyperlinks, tracked insertions | Typing and deleting inside one run uses `Paragraph::edit_run` P:1227. Structural edits across their edges are refused with notice `structureBoundary`. |
| Paragraphs holding `w:del` / moves | Read-only in the MVP (notice `trackedChanges`, banner on open). They are preserved verbatim. |
| Block-SDT paragraphs | Editable through `InControl`. Enter inside one is refused until experiment 7 shows `insert_content` accepts SDT boundaries. |
| Tables nested in SDTs | Cell text is editable only if the resolver round-trips the path (experiment 7). Otherwise read-only. Structural table ops are refused. |
| Headers, footers, footnotes, text boxes, equations | Painted, read-only in the MVP. Header editing later uses `edit_story_paragraph` D:23647 (staged). |
| Body `UnsupportedXml` items | Invisible and preserved. They are removed only when wholly inside a deleted range, as Word would. |

Every other part of the package survives untouched, because the `Document` is never rebuilt. Open → in-place edits →
`to_bytes` is rdocx's own round trip.

### Invariants, validation, and what the shape refuses

- The TS side cannot represent a position, so UTF-16 versus scalar offsets cannot leak, and the frontend cannot drift
  from the document. Per **separate-before-serializing-shared-state**, there is exactly one writer.
- `ParaAddr` lists only writable places. A read-only region has no `ParaAddr`, so no executor branch can write to it,
  per **model-the-domain**.
- `Plain` and `Rich` are a type (`Transplant`), not a boolean. In-place code only accepts `PlainRuns`, so a lossy
  rebuild of a field is not expressible.
- Wire values are parsed once in `lib.rs` (serde), and the engine trusts its types after that, per **boundary-discipline**.
  Commands that are valid but impossible (Enter in a header) become `NoticeCode`s, not errors. `Err` means an engine
  bug.
- Commands converge. `idle()` and `seal()` are no-ops on a clean document. A failed transaction leaves nothing behind.
  Re-running `frame()` without input returns an Update with no `layout`, per **make-operations-idempotent**.
- The shape does not do collaborative editing, tracked-change authoring, or incremental layout, and the TS side does
  not parse document XML.

**Interface depth.** TS sees 15 methods and three wire types (`Command`, `Update`, `PageView`). Behind them sit
positions, scalar offsets, runs, transplants, transactions, the resolver, layout, fonts, hit testing, word boundaries
and history. TS does not know what a run is. The interface stays small because pointer and movement commands take
intent and points, not positions, per **minimize-reader-load**: tracing a keystroke crosses `input.ts → engine apply →
exec.rs → kernel.rs`.

## Synthesis decision

## Tradeoffs accepted

- We accept a whole-document relayout every frame that has edits (about 1.1 ms per page) in exchange for Word's
  pagination on screen and a PDF identical to the screen. A 100-page document paints at about 8 Hz while typing.
- We accept one staged op (a full zip and reparse) on merges, cross-paragraph deletes and table structure, in exchange
  for no rdocx changes in the MVP. Gap G1 makes deleting many blocks slow until rdocx gets a range removal.
- We accept undo latency of one `from_bytes`, and undo granularity set by idle pauses, in exchange for one exact undo
  mechanism with no per-command inverses.
- We accept that plain runs moved by Enter or merge lose `rPr` children no `RunRef` getter exposes (w14 effects), and
  that run boundaries may differ after undo-free edits, in exchange for in-place, single-frame structural keystrokes.
  Rich content always moves as XML.
- We accept that the merge rule is "the first paragraph's formatting wins" (as in Google Docs and recent Word), not
  Word's older paragraph-mark rule.
- We accept a 17-19 MB wasm download per window, in exchange for one engine that edits, lays out, paints and prints.
- We accept read-only headers, footers, footnotes, text boxes, equations and revision paragraphs in the MVP.
- We accept UAX#29 word boundaries, so Ctrl+Arrow and double-click move one Han character at a time until a dictionary
  segmenter is added.

## Alternatives considered

- **A TS-side document mirror with DOM hit-testing.** `caretPositionFromPoint` works in acdert, so TS could hold
  paragraphs and spans and compute positions itself. It lost because the frontend would need a second model of
  paragraphs, runs and scalar offsets kept in sync with the engine. Every edit would then be split ownership. The
  interface would grow by everything TS needs to know about runs.
- **`dispatch(cmd) → Update` with layout inside each call.** That is one method fewer, but it lays out once per event.
  Key repeat and IME bursts then queue behind 20-110 ms layouts. Splitting `apply` from `frame` keeps the same depth
  and lets the engine choose when to lay out.
- **Per-command inverse ops or block XML patches for undo.** These are cheaper to capture, but each command needs its
  own inverse. Inverses through setters are lossy, and restoring a block range costs one staged op per block anyway.
  Checkpoints hide all of that behind `seal`, `undo` and `redo`.
- **Engine in the Node backend (native rdocx).** It would have system fonts and native speed, but every keystroke and
  every page view would cross a socket. The backend also outlives no window state and cannot paint.
- **Painting with `render_page_to_svg` or canvas.** SVG text ignores web fonts (measured). `FontFace` objects are not
  used for canvas painting (measured). Spans are the only measured-good painter.

## Open questions and risks

Ranked by how much of the shape each one could break. Each has the cheapest experiment that settles it.

1. **Does caller-font layout stay within the frame budget?** `layout_with_fonts*` copies (D:35644) and byte-compares
   (E:2733) every caller font on every call. *Experiment:* extend the existing wasm probe with a 20-page Chinese
   document, SimSun + SimHei bytes, and 30 single-character edits, timing `layout_with_fonts_aliases_and_bundled_fallback`.
   Pass if the median is ≤ 25 ms. *If it fails:* at load, subset each face to the document's characters plus GB2312
   with the `subsetter` crate, or patch rdocx so `FontFile.data` is an `Arc<[u8]>` compared by pointer.
2. **What does one staged op cost?** That covers `remove_content`, `clone_content`, `to_bytes` and `from_bytes` at 20
   and 100 pages in wasm, which drives merge, range delete, undo and idle sealing. *Experiment:* time each in the same
   probe. Pass if a staged op takes ≤ 40 ms at 20 pages. *If it fails:* add two small upstream rdocx methods,
   `remove_content_range` (the body of `try_remove_content` D:26226 draining a range) and an in-place
   `join_paragraphs`. Keep the top three undo checkpoints as live `clone_for_staging` copies.
3. **Do HTML spans paint glyph-exact?** Width drift under justification and kerning, baseline placement, synthetic
   bold, and TTC faces are all open. *Experiment:* paint three fixtures (justified Chinese, Latin with kerning, a table
   form). Compare each span's `getBoundingClientRect().width` with Σ`advances`, and screenshot against a raster of the
   PDF of the same layout. Pass if drift is ≤ 0.5 px at 100%. *If it fails:* fall back to per-cluster spans for runs
   that drift.
4. **Where does the caret go when layout emits no glyphs?** This covers empty paragraphs, empty cells and
   page-break-only paragraphs. *Experiment:* lay out a fixture containing them and list any elements whose source points
   at them. *If there are none:* use `body_layout_fragments` L:354 for body paragraphs. Cells need an upstream
   zero-width paragraph-mark run.
5. **Does IME composition work in acdert?** *Experiment:* run `acde dev` with macOS Pinyin, log the composition event
   order, and check where the candidate window appears with the textarea at the caret. *If it fails:* show the preedit
   as an overlay span without reflow.
6. **Do the offset units agree?** `SourceSpan` scalars must match run literal offsets for `split_run` with tabs, breaks,
   drawings and symbols. *Experiment:* a native property test over the fixtures that checks locate → split → text
   prefix.
7. **Does the resolver agree with rdocx indexing inside SDTs?** *Experiment:* a corpus test that resolves every source
   node and compares `ParagraphRef::text()` with the spans' text. Mismatched nodes become read-only.

Questions for the human:

- Are small upstream rdocx additions acceptable when experiments 1 and 2 fail? Those are `remove_content_range`,
  `Arc` font bytes and in-place join.
- Should a merge keep the first paragraph's formatting?
- Is it acceptable for the MVP to leave revision paragraphs and headers and footers read-only?
- Should undo coalesce typing by idle pause?

## Build units

Each unit ends in a check that passes before the next starts, per **sequence-verifiable-units**.

1. **Read-only viewer.** Engine crate (wasm-bindgen pinned `=0.2.128`, tsify), `Session::open`, `frame`, `page`,
   `view.ts` painting and virtualization, zoom. *Check:* an `acde test` opens three fixtures. Page count and sizes
   match a native layout. A span-width drift script reports ≤ 0.5 px. This settles risk 3.
2. **CJK end to end.** `server.ts` fonts, `wantedFonts`, `addFont`, aliases, `exportPdf` from the same layout.
   *Check:* the Chinese fixture's spans use `k<key>` faces from SimSun bytes. The layout has no missing-glyph
   diagnostics. The PDF's font list contains a SimSun subset. Relayout timing with fonts is recorded. This settles
   risk 1.
3. **Geometry.** Line index, caret, selection rects, hit test, every `move` unit, pointer with 1-3 clicks and Shift.
   *Check:* a native property test (for every reachable `Pos`, `hit(caret(pos).center) == pos`), goal-column tests
   across pages and table cells, and the empty-paragraph fixture. This settles risk 4.
4. **Text kernel.** Insert, delete, Enter, merge, range delete, pending marks, transactions. *Check:* native random
   edit scripts against a string model. A preservation diff: unknown XML, comment and bookmark counts are unchanged and
   untouched paragraphs are XML-equal after `to_bytes`. Staged-op timings are recorded. This settles risks 2 and 6.
5. **Input.** Keymap, `beforeinput`, IME machine, clipboard (plain text), pointer capture, the frame loop. *Check:* an
   `acde test` script types, presses Enter and Backspace, uses arrows and Shift+click, then asserts `selectedText()` and
   the status page. A manual IME checklist. This settles risk 5.
6. **History.** Seal, undo, redo, `resume` selection, dirty against saved. *Check:* a native run of 200 random commands
   with seals. Undoing everything gives the original's text and per-character effective formatting. Redoing everything
   gives the final state.
7. **Formatting.** Marks, font, size, color, highlight, styles, alignment, spacing, indent, lists, `FormatState`, and
   the toolbar. *Check:* native effective-property assertions. An `acde test` checks that the toolbar reflects a mixed
   selection and that Ctrl+B then typing gives bold text.
8. **Files and window.** New, open (picker, drop, `open-file` request), save over the handle (a read-only handle falls
   back to Save As), save as, export PDF, dirty title, a `beforeclose` dialog (`confirm()` returns false in acde), menus,
   zh/en. *Check:* an `acde test` with `chooseFiles` and `chooseSaveFile` reopens the saved bytes and finds the same
   text.
9. **Remaining scope.** Tables (insert in place D:25997, `Table::add_row` T:925; staged column and row removal),
   images (`insert_picture_at` D:21141), page setup (`set_page_size` / `set_margins` D:4255/4292), headers and footers
   rendered, status word count. *Check:* a native test for each op plus a screenshot of each fixture.

## Next implementation step

Build unit 1 together with the timing probes for risks 1 and 2, because those two numbers decide whether this shape
needs upstream rdocx work before unit 4.
