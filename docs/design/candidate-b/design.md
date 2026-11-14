# Candidate B: a flow-DOM editor over a typed document model

Sketches live in `sketch/`. Read `sketch/usage.ts` first, then `sketch/model.ts`.

## Problem

The app is a Word-like editor for Dopame OS. Its users edit Chinese government forms, theses and agreements, so CJK text,
SimSun and SimHei, tables, numbered headings, headers and footers are the normal case. Four measured facts in
`grounding.md` make the shape non-obvious.

- acdert's `contenteditable` is inert. Enter, arrow movement, the caret and `execCommand` do not work, so the editor owns
  input, caret, selection and history. A focused `<textarea>` does deliver `keydown`, `beforeinput` and clipboard events.
- Text paints with the right font only as HTML using system fonts or CSS `@font-face`. rdocx's SVG pages paint the wrong font.
- rdocx layout is a whole-document pass. A relayout after a small edit costs about 1.1 ms per page in wasm (16 to 18 ms
  for 14 pages, measured), so about 110 ms at 100 pages (extrapolated). There is no incremental layout API.
- rdocx's cheap mutators edit one paragraph in place (`split_run`, `remove_run`, run setters). Its structural mutators
  (`try_remove_content`, `clone_content`, `replace_paragraph_xml`, `embed_image`) clone the whole package on every call
  through `clone_for_staging`, and most also rezip and reopen it through `prepare_and_reopen_staged` (read in
  `document.rs`). Nothing moves a run with its XML from one paragraph to another.

The document also carries content the editor does not model: fields, comments, bookmarks, content controls and unknown
XML. That content must survive open, edit elsewhere, save.

This candidate splits the work by time. While the user edits, a typed TypeScript model is the only source of truth, and
acdert lays it out as HTML flow with system fonts. The editor cuts that flow into page boxes itself. rdocx runs as
WebAssembly in the page and touches the document only at the edges: import on open, write-back on save, export to PDF
and HTML.

## Usage (caller's view)

The app shell (`app.ts`) is the only caller of the editor and the engine. The full call sites are in
`sketch/usage.ts`. These four carry the design.

```ts
const engine = await loadEngine()                       // instantiates rdocx wasm once per window
const editor = Editor.mount(pagesHost, engine.blank(), { locale: 'zh' })

self.on('request', async (request) => {                 // the system's default-app request for a .docx
  if (request.kind !== 'open-file') return
  const opened = engine.open(await readBytes(request.handle))   // throws OpenError with a user-facing reason
  editor.load(opened)
  file = { handle: request.handle, name: request.handle.name, saved: opened.doc }
})

async function save() {
  const bytes = editor.source.save(editor.state.doc)     // pure: pristine document + model -> verified .docx bytes
  if (!file.handle || !(await tryWrite(file.handle, bytes))) return saveAs(bytes)
  file.saved = editor.state.doc                          // dirty is derived: state.doc !== file.saved
}

toolbar.bold.onclick = () => editor.run(toggleMark('bold'))
editor.on('change', () => { toolbar.render(editor.toolbar()); status.render(editor.status()) })
```

A command is a plain function of editor state, so the toolbar, the keymap, menus and tests all call `editor.run(cmd)`.
The app never sees run indices, rdocx types, DOM ranges or page geometry.

## Shape

### Data shapes

**Document model** (`sketch/model.ts`, shipped as `src/model.ts`). A `Doc` is an immutable tree.

```ts
Doc       { body: Block[]; sections: Section[]; stories: Map<StoryKey, Block[]>; styles: StyleSheet; lists: ListTable; media: MediaTable }
Block     = Paragraph | Table | OpaqueBlock
Paragraph { kind: 'p'; id: ParaId; src: ParaSrc | null; props: ParaProps; inlines: Inline[]; lock: Lock | null; sectionEnd: number | null }
Inline    = TextRun | Atom
TextRun   { kind: 'text'; text: string; marks: Marks; src: RunSrc | null }
Atom      { kind: 'atom'; atom: AtomKind; src: RunSrc | null }   // image, field, page break, or opaque (footnote ref, equation, ...)
Table     { kind: 'table'; id; src; props; grid: Pt[]; rows: Row[] }   Row { src; props; cells: Cell[] }   Cell { src; span; vMerge; blocks: Block[] }
OpaqueBlock { kind: 'opaque'; id; src: BlockSrc; label; preview: Paragraph[]; removable: boolean }
```

Two identities live on every node, and they mean different things, so they carry different brands. `ParaId` is the
editor's identity, minted in TypeScript, used for DOM keys, selections and caches. `ParaSrc` and `RunSrc` are minted by
the bridge at import and name the pristine XML node a model node descends from. The bridge mints them as ordinals in
pristine order, and TypeScript only compares them. A `TextRun.src` says "my unmodeled run properties are run r's". Splitting a run for bold creates two pieces with the same
`src`. Typing next to a run makes the new text a piece of that run, the way Word inherits the previous character's
formatting. A `Paragraph.src` says "my `w:pPr` and paragraph-level XML are paragraph p's". Enter gives both halves the same
`src`. A merge keeps one side's `src` and props, the same side Word keeps. That is the first paragraph, unless the
deletion began at the first paragraph's start or the first paragraph was empty, in which case it is the second. Deleting
a whole heading therefore leaves the next paragraph's formatting alone.

Marks and paragraph props hold direct formatting only. `undefined` means inherit. What the user sees is a look, derived
as `look(paraStyle, runStyle) ⊕ marks`, where `look` comes from rdocx's own cascade (`resolve_paragraph_properties`
`document.rs:30350`, `resolve_run_properties` `document.rs:30401`, theme fonts resolved through `theme()`
`document.rs:32489`). The TypeScript side never reimplements the style cascade. It overlays direct marks on a resolved look.

Bookmarks, comment ranges and permission ranges are not in the model. They sit between runs in the XML, and the model
never merges two runs with different `src`, so every marker keeps its run boundary through any edit. rdocx's
`remove_run` (`paragraph.rs:1284`) and `split_run` (`paragraph.rs:1257`) already keep markers in place.

Invariants, each enforced by one function (`checkDoc` in tests and debug builds):

1. Values are never mutated. A transaction shares every untouched block, so object identity is the change signal for the
   render cache, the measure cache and write-back.
2. `TextRun.text` is non-empty and contains no U+FFFC. An atom occupies one offset.
3. Source order holds. Every `ParaSrc` and `RunSrc` in a story appears in non-decreasing pristine order. Commands never copy
   a `src` to a new place. Paste mints pieces of the run at the caret, not of the copied runs.
4. Adjacent text runs merge only when `src` and marks are both equal (`normalizeInlines`).
5. A paragraph with `lock` and an atom with `removable: false` never change. Locks cover tracked revisions and paragraphs
   whose fields do not balance inside them (a table of contents line), which `set_text` refuses (`paragraph.rs:903`).

**Position and selection.** `Pos = { p: ParaId; o: number }`, where `o` is a UTF-16 offset into the paragraph's flat
text, the unit DOM ranges use. Paragraphs inside table cells and header stories have their own `ParaId`, so one `Pos`
type addresses every story. `Selection = { kind: 'text'; anchor; head } | { kind: 'cells'; table; anchor; head }`. The
vertical goal column is view state and lives in the editor, not in the selection.

**Transaction and command.** `Command = (state: EditorState) => Transaction | null`. A `Transaction` is
`{ doc, sel, stored, intent }`, where `stored` holds marks toggled at a collapsed caret and `intent` is `typing`,
`deleting`, `discrete` or `none`, which drives undo grouping. `apply(state, tr)` is the one place history changes.
Commands are pure. Visual motion (Up, Down, Home, End, PageUp, PageDown) needs geometry, so the view computes the target
`Pos` and runs `setSelection`.

**Import and write-back contract.** The bridge exposes two operations on a `Session` that holds the pristine `Document`.

- `import()` walks `body_items()` (`document.rs:24200`) and emits `Imported` JSON: blocks, inlines, direct props, `src`
  ids, the looks of every `(paraStyle, runStyle)` pair in use, list definitions (`numbering_level` `document.rs:26812`),
  sections (`sections()` `document.rs:30508`), header and footer stories (`section_story` `document.rs:30559`), media
  references and font families. Run indices are accepted-view indices (`run(i)` `paragraph.rs:1202`), the same indices
  `run_mut`, `split_run` and `remove_run` take.
- `save(patch)` returns `.docx` bytes. `Patch` is the final body in order. A block that is the same object the import
  produced is sent as `{ keep: BlockSrc }`. Every other block is sent whole, with its `src` ids. The bridge diffs against
  the pristine document and applies only the difference.

The wire types are Rust structs with `ts-rs` derives, so `wire.d.ts` is generated, not hand-synced. `engine.ts` parses
`Imported` into the model at the boundary and builds `Patch` from it. Nothing else touches wire types.

### Module map

| Module | Owns |
| --- | --- |
| `src/model.ts` | The document types, `Pos` and `Selection`, ids, `checkDoc`, `flatText`, `normalizeInlines`, the derived paragraph index. No DOM. |
| `src/editor/edit.ts` | `EditorState`, `Transaction`, `apply` and history, and every command. Pure functions only. |
| `src/editor/render.ts` | What a block looks like in the DOM, and the mapping between DOM points and `Pos`. The only module that knows span structure. |
| `src/editor/pages.ts` | Measurement, pagination into page slices, page mounting with virtualization, caret and selection painting, hit testing, line motion. |
| `src/editor/input.ts` | The hidden textarea, the keymap table, IME composition, clipboard, mouse gestures. Turns events into `editor.run` calls. |
| `src/editor/editor.ts` | The `Editor` facade. Holds state, runs commands, drives `pages.ts`, derives toolbar and status state, emits `change`. |
| `src/engine.ts` | Loads the wasm, parses `Imported` into the model, builds `Patch`, caches looks, fetches image blobs. |
| `src/fonts.ts` | One alias table for font families (SimSun, 宋体, Songti SC, ...). Builds CSS stacks for the page and file choices for the backend. |
| `src/app.ts`, `src/ui/*` | File lifecycle (new, open, drop, request, save, save as, export), menus, toolbar, status bar, dialogs, zh and en strings. |
| `server.ts` | Stateless font service. Indexes system font files by every localized family name, serves bytes and line metrics. |
| `engine/` (`rdocx-bridge`) | The wasm crate. `bridge.rs` is the `Session` surface, `import.rs` and `write.rs` are the two directions, `wire.rs` the shared types. |
| `rdocx` (upstream) | Four in-place paragraph edits the facade lacks, listed under the save section. |

The trace for any keystroke is `input.ts`, then `edit.ts`, then `editor.ts` into `pages.ts`, and each hop changes the
abstraction (event, model change, screen change). `pages.ts` and `render.ts` split along one line. `render.ts` knows what
one block looks like, and `pages.ts` knows where blocks are.

### What happens on a keystroke

Typing "a" into paragraph 400 of a 20-page document:

1. `input.ts` receives `beforeinput` (`insertText`) on the textarea, cancels it, runs `insertText('a')`.
2. `edit.ts` builds a new `Paragraph` with the letter added to the run at the caret, a new `body` array with that one slot
   replaced, and a new selection. `apply` coalesces the step into the open typing entry of the history.
3. `editor.ts` finds changed blocks by identity against the previous `body` (a pointer compare per block).
4. `pages.ts` asks `render.ts` for the new block element and swaps it into each mounted copy (a block that straddles a page
   boundary is mounted twice).
5. `pages.ts` reads the block's height and line bottoms, which forces one acdert layout of the mounted pages.
6. Pagination reruns from the block's page and stops at the first page whose start matches the previous run. A keystroke
   that does not change the line count stops at once.
7. The caret moves to the rect of a collapsed `Range` at the new `Pos`, and the textarea moves with it for the IME.
8. Toolbar and status state are derived in the next animation frame.

| Step | Estimated cost | Basis |
| --- | --- | --- |
| Command and history | under 0.1 ms | Guess. One paragraph copy and a 2000-slot array copy. |
| Derived indexes (paragraph index, list numbers, word count) | 0.3 to 1 ms at 100 pages | Guess. Linear passes, cached per `body` array. |
| Render one block | 0.1 to 0.3 ms | Guess. One `<div>` with a span per run and script segment. |
| acdert layout of mounted pages and measurement reads | 1 to 5 ms | Unknown. Risk 1 below measures it. |
| Pagination arithmetic | under 0.2 ms | Guess. Cached measures, early stop. |
| Caret and selection paint | under 0.3 ms | Guess. A few `getClientRects` calls. |

The cost does not depend on document length, because only three to five pages are mounted. A 20-page document and a
100-page document cost the same per keystroke. A layout-driven design pays 22 ms (20 pages) to 110 ms (100 pages) per
keystroke for the rdocx relayout alone, before any painting.

### Pagination, and how far it matches rdocx's PDF

`pages.ts` keeps one `Measure` per block object at a content width: height, line bottoms, row bottoms for tables, and
the keep, widow and break flags. On open it renders every block into a hidden measuring host in chunks of about 200
blocks per task. The first pages appear after the first chunk, and the status bar reads "第 1 页，共 ≥3 页" until the
rest is measured.

A page is a fixed-size box from its section's page size and margins. Its body is a list of slices
`{ block, y0, y1 }`. Each slice is a wrapper with `height: y1 - y0; overflow: hidden` that holds the block's element
shifted up by `y0`. A paragraph that straddles a break is mounted twice, each copy clipped to its part. Break points snap
to line bottoms for paragraphs and row bottoms for tables. Repeated header rows render as a decoration in the continuation
slice. Page boxes have exact sizes, so virtualization is exact. Unmounted pages are empty boxes, and an
`IntersectionObserver` mounts the visible pages plus one on each side.

The paginator implements Word's block rules exactly, because they are arithmetic over measures: `pageBreakBefore`,
`keepNext` chains, `keepLines`, widow and orphan control, section breaks, table rows that cannot split, header rows,
space-before suppression at the top of a page, and header height pushing the body down. Paragraph spacing is padding,
not margin, so CSS margin collapsing never applies.

Lines are where parity is lost. Inside a block, line breaks come from acdert's shaper and line breaker, not rdocx's.
Two measures narrow the gap. Line height is set explicitly per span from the font's own metrics (the backend reads
`OS/2` and `hhea` from the same file rdocx embeds), multiplied by the spacing rule, so `line-height: normal` never decides
it. Document-grid line pitch snaps that height up to a multiple of the pitch. What remains are differences in CJK kinsoku,
justification and tab stops. The expectation, a guess until risk 4 measures it, is the same page count for most
documents and page starts that drift by one or two lines in long ones. Print and PDF always use rdocx's layout, so the
file a government office receives is rdocx's pagination. If drift proves too large, rdocx can supply page-break hints at
idle (`body_layout_fragments` `rdocx-layout/src/lib.rs:354`) and the paginator would break where rdocx breaks.

### IME composition

The textarea is transparent, one pixel wide, and positioned at the caret rect with the line's height, so the system IME
anchors its candidate window there. During composition `input.ts` does not cancel `beforeinput`.
`compositionstart` deletes a non-empty selection as a typing step. Each `compositionupdate` sets a preedit decoration
`{ pos, text }` on the editor. `render.ts` draws it as an underlined span inside the paragraph, so the line rewraps
around it, the block is re-measured and repaginated through the same path as typing, and the caret and textarea move
to the end of the preedit. `compositionend` clears the decoration, runs `insertText(data)` and empties the textarea.
The preedit is view state. It never enters the model, the history or a save, and decorated renders skip the measure
cache. Composition is unverified in acdert (grounding), so this is risk 2.

### Undo

Undo stores snapshots, not inverse steps. A history entry is `{ before: { doc, sel }, after: { doc, sel }, intent, at }`.
Because docs share structure, an entry costs one paragraph plus one `body` array of pointers, about 16 KB at 2000
blocks. `apply`
coalesces a `typing` or `deleting` transaction into the top entry when it continues the same paragraph within one second.
A composition commit is one typing step. Undo sets `doc` and `sel` from `before`.

Undo never touches rdocx. The pristine document is immutable and save is a pure function of the model, so undo after a
save simply makes the document dirty again, and saving once more writes the older state correctly.

### Save patches the original and keeps unmodeled content

`Session.save(patch)` runs `write(pristine, patch)`, then `to_bytes()` (`document.rs:18197`). Every save starts from a
fresh copy of the document as opened (`clone_for_staging` `document.rs:16519`). Nothing a save does feeds the next one,
so saving twice writes the same document content and a failed save leaves nothing behind.

`write` groups the patch into regions. A region is a connected set of pristine paragraphs and final paragraphs. A final
paragraph links to a pristine one when it holds one of its runs or carries its `src`. Every final paragraph in a region
carries the same `src`, because merges and splits copy one side's `src`, and `plan` rejects a patch that breaks this.
Most regions are one paragraph to one paragraph. A pristine paragraph that no final block references joins the adjacent
region (the one before it, or the one after when it leads the body), so its bookmarks and comment anchors move into the
survivor instead of being cut. A deleted paragraph never costs a staged removal. The bridge walks the final body from the
end to the start, so earlier content indices never shift under it, and for each region:

1. Joins the region's pristine paragraphs into one that keeps the `w:pPr` of the region's `src` (kit
   `join_paragraphs`), then splits it at the final paragraph boundaries (kit `split_paragraph`). Both halves of a split
   keep the full `w:pPr`, as Word does on Enter.
2. Per final paragraph, applies changed paragraph props through `paragraph_mut` (`document.rs:25422`) and the setters
   `set_style` (`paragraph.rs:1335`), `set_alignment` (`:1316`), `set_indent_left` (`:1426`), `set_first_line_indent`
   (`:1464`), `set_hanging_indent` (`:1499`), `set_space_before` and `set_space_after` (`:1388`, `:1407`),
   `set_line_spacing_multiple` (`:1613`) and `set_numbering_value` (`:1368`).
3. Patches runs. Pieces that share a source run become separate runs through `split_run` (`paragraph.rs:1257`, which
   clones `w:rPr`). Changed text goes through `run_mut` (`:1211`) or `edit_run` (`:1227`, for runs inside hyperlinks or
   content controls) with `Run::set_text`, `add_tab` and `add_break` (`run.rs:471`, `:483`, `:488`). Changed marks go
   through the `_value` setters (`set_bold_value` `run.rs:547` and its siblings), so `undefined` clears a direct value.
   Deleted runs go through `remove_run` (`paragraph.rs:1284`), which leaves markers in place. A source run that mixes
   text with a drawing or field is split first, so each run holds text only or one non-text child, because
   `Run::set_text` replaces every child of a run. Text with no `src` in an empty paragraph is added with
   `add_run_inheriting_mark` (`paragraph.rs:1085`), which clones the paragraph mark's formatting as Word does.

New paragraphs use `insert_paragraph` (`document.rs:25975`), new tables `insert_table` (`:25997`) and cells
`Cell::add_paragraph` and `Cell::paragraph_mut` (`table.rs:2207`, `:2291`). Rows use `Table::add_row` (`table.rs:925`),
`clone_table_row` (`document.rs:25659`) and `remove_table_row` (`:25712`). Columns use `Table::insert_column`
(`table.rs:973`) and `delete_table_column` (`document.rs:25601`). A whole table or opaque block the user deleted goes
through `try_remove_content` (`document.rs:26226`), which reconciles comments. New images use `embed_image`
(`document.rs:26757`) and `Run::add_picture` (`run.rs:500`). New lists use `add_list_definition` (`document.rs:28895`),
missing built-in styles use `add_style` (`:29918`), and page setup uses `section_mut` (`:30987`) with
`Section::set_page_size` and `set_margins` (`:4255`, `:4292`). The staged calls in this list run once per table removal,
image, list or style, never per paragraph.

The facade lacks four in-place edits. They belong in rdocx because only rdocx knows how `CT_P` positions its markers,
hyperlinks and raw children. Each mirrors a Word action and each is small next to `split_accepted_run`, which already
exists.

| Upstream addition | Word action | Without it |
| --- | --- | --- |
| `Document::split_paragraph(body_index, run_boundary)` and the `Cell` twin | Enter | The tail is rebuilt from modeled marks. Its unmodeled `w:rPr` and non-portable atoms are lost. |
| `Document::join_paragraphs(body_index, keep)` and the `Cell` twin, `keep` naming the side whose `w:pPr` survives | Backspace at a paragraph start, deleting whole paragraphs | Same loss, plus one staged removal per merge. |
| `Paragraph::insert_run_like(at, like_run, text)` | Typing a new run mid-paragraph | A neighbor's text is extended and split back, which fails next to non-text runs. |
| `Paragraph::set_first_line_chars_value` | Changing a 首行缩进 2 字符 indent | The editor shows `firstLineChars` but cannot change it. |

Before returning bytes, `save` verifies its own output. It re-imports the written document and checks two things. The
projection of every final paragraph (text, marks, atom kinds) must equal the patch. The multiset of unmodeled items
(bookmarks, comment markers, fields, content controls, raw XML islands) must equal the pristine multiset minus the atoms
the user deleted. On a mismatch, save throws `SaveVerifyError`, the file on disk stays as it was, and the document stays
dirty. A reconciler bug cannot silently destroy a thesis.

Estimated save cost at 100 pages is 150 to 400 ms (a guess). That is one clone, in-place patches, a few staged calls,
one `to_bytes`, and one verification import.

### CJK fonts in PDF export

The page has no access to system font files, and rdocx in wasm ships only an 87 KB Noto Sans SC subset (grounding).
`server.ts` fills that gap and holds no document state. On first use it indexes the system font directories (macOS
`/Library/Fonts`, `~/Library/Fonts`, `/System/Library/Fonts`, Linux fontconfig directories, Windows `C:\Windows\Fonts`)
by every family name in each file's `name` table, including localized ones, because Chinese documents often name
`宋体` rather than `SimSun`. Export runs in four steps.

1. The engine lists the families the document uses (`fontsUsed(doc)`, from the looks).
2. The app fetches `GET /api/font?family=宋体` for each one. The backend resolves the name through `fonts.ts`'s alias table
   (`宋体` to SimSun, then Songti SC, STSong, Noto Serif CJK SC) and returns one face as a standalone font file, extracted
   from a `.ttc` when needed.
3. The engine registers each face under the requested name (`Session.add_font`).
4. `export_pdf(patch)` writes the working copy and calls `to_pdf_with_fonts` (`document.rs:35758`).

Display uses the same alias table to build CSS stacks, and `render.ts` splits each run into script segments so CJK
characters use the East Asian slot font and Latin characters the ASCII slot font, as Word and rdocx do. Screen and PDF
therefore resolve each run to the same physical font file.

### Interface depth

The app sees two objects. `Editor` exposes `mount`, `load`, `run`, `undo`, `redo`, `on`, `toolbar`, `status`, `setZoom`
and `focus`. It hides input handling, IME, selection painting, measurement, pagination and virtualization. `Source`
gives the app `save`, `exportPdf`, `exportHtml`, `fontsUsed`, `addFont` and `addMedia`, and gives the editor looks and
image URLs. It hides rdocx, the wire format, run indices, region planning, the upstream kit and verification. Commands
are the one extension point, and a new command is a pure function in `edit.ts` with a unit test. The interface stays
this small because the hard rules each have one owner. rdocx's XML rules live in `write.rs`, span structure lives in
`render.ts`, and page geometry lives in `pages.ts`.

Screened against the red flags. State has one writer at a time. Commands write the model while the user edits, `save`
writes a fresh working copy, and nothing writes the pristine document. The wire types and the keymap are single lists
(ts-rs generates the TypeScript mirror, and menus read their shortcuts from the keymap). A lint rule keeps `editor/*`
internals out of `app.ts`, which may import only `editor.ts` and the commands in `edit.ts`. There is one way to change
the document, a command.

## Synthesis decision

## Tradeoffs accepted

- We accept on-screen pagination that can drift from rdocx's PDF by a line or two per page in exchange for keystroke
  cost that does not grow with document length.
- We accept a TypeScript paginator that reimplements Word's block-level page rules in exchange for owning the hot path.
  The rules are arithmetic, and rdocx remains the reference that tests compare against.
- We accept a dependency on four small rdocx additions in exchange for structural edits that keep every marker, field
  and unmodeled property. The fallback is lossy and is not shipped.
- We accept a save that replays the whole model onto the pristine document (one clone and one verification import, a few
  hundred milliseconds at 100 pages) in exchange for save being idempotent and undo after save needing no bookkeeping.
- We accept that unmodeled content is read-only. Tracked revisions, table-of-contents paragraphs, content controls and
  equations render but cannot be edited, in exchange for a guarantee that saving never drops them.
- We accept plain-text paste in the MVP. Rich paste needs an HTML-to-model parser, and the model already has the shape for it.
- We accept a hidden measuring pass on open (render every block once) in exchange for exact virtualization afterwards.
  The first pages show after the first chunk, so the cost hides behind a growing page count.
- We accept the default tab-stop width for `\t` in the MVP. Custom tab stops (leader dots in forms) need a second
  measuring pass that sets each tab's width from its x position.

## Alternatives considered

- **Layout-driven canvas of positioned spans.** rdocx lays out every page and the editor paints its `GlyphRun`s as
  absolutely positioned spans, with caret and hit testing from glyph advances. Pages match the PDF exactly. It lost
  because each keystroke pays a whole-document relayout, 22 ms at 20 pages and about 110 ms at 100 (from measured
  per-page cost), and because each edit must first mutate the rdocx document, which turns staged mutators into
  per-keystroke costs. It also exposes rdocx's geometry types to the editor, a much wider coupling.
- **A live rdocx document mutated on every edit, with the model as a cache.** This keeps rdocx as the source of truth
  and patches it incrementally. It lost because structural edits are staged, so the hot path pays package rezips. Undo
  would also need inverse rdocx operations or document snapshots, which cost O(package) each.
- **Write-back by splicing XML strings.** The bridge would read `paragraph_element_xml` and rebuild paragraph XML from
  original run fragments. It lost because `replace_paragraph_xml` refuses an opaque child that moved between paragraphs
  (`admit_edited_paragraph` `document.rs:8137`) and costs a staged reopen per paragraph.
- **rdocx in the backend.** One Node process would hold a document per window. It lost because windows are separate
  heaps that the runtime isolates, while a backend is shared by every window and restarts after crashes. A per-window
  document in the page needs no session keys and no crash recovery protocol.

## Open questions and risks

Ranked by how much of the design each one can sink.

1. **Can acdert lay out the mounted flow fast enough, with clipped duplicates?** This decides the direction. The
   cheapest settling experiment takes half a day. Build 100 page boxes of generated CJK and Latin paragraphs, mount
   three pages with slice wrappers, edit one paragraph per animation frame, and record `performance.now()` around the
   mutation plus the height read. The pass mark is a p95 under 8 ms. In the same probe, check `overflow: hidden` clipping,
   `IntersectionObserver` mounting and `caretPositionFromPoint` inside clipped and `transform: scale` wrappers.
2. **Does composition work on a positioned textarea in acdert?** Run `acde dev` headed with the macOS Pinyin input
   source, log `composition*` and `beforeinput` events, and screenshot where the candidate window appears. If acdert
   draws no candidate window or sends no composition events, the fallback is a visible, styled textarea over the caret
   that shows the preedit itself. That costs polish, not the shape. About one hour with a person typing.
3. **Can rdocx's paragraph split and join be made correct for markers?** Implement `split_paragraph` and
   `join_paragraphs` for body `CT_P` on a branch. The property test runs on the user's documents. For every paragraph and
   every run boundary, a split followed by a join returns identical XML, and `to_bytes` then `from_bytes` succeeds. About one day.
   If it cannot land, should structural edits warn before a save that would flatten unmodeled run properties?
4. **How far do page breaks drift from rdocx?** Run the importer and paginator over the user's real documents and compare
   each page's first paragraph and line with `body_layout_fragments`. The metric is the share of page starts that land in
   the same paragraph. If it is below about 90 percent, do we adopt rdocx page-break hints at idle?
5. **Does `to_pdf_with_fonts` take `.ttc` bytes, and which face?** Export one Chinese paragraph with `Songti.ttc` and
   with an extracted face, then read the embedded fonts with `pdffonts`. About 30 minutes.
6. **Is `Intl.Segmenter` present in acdert, with Chinese word data?** One `acde eval`. If it is absent, word motion falls
   back to character classes, which treats each CJK character as a word. Is that acceptable for Ctrl+arrow?
7. **Does an `open-file` request handle allow writing?** Call `createWritable()` on one in a probe. Save already falls
   back to Save As on refusal, so this only changes how often users see the picker.

## Build units

Each unit ends in a check that passes before the next unit starts.

1. **Flow and pagination probe.** Run risks 1 and 2 as a throwaway `probe/` app. Check: the p95 edit-to-measure time on a
   100-page synthetic document is under 8 ms, and composition events arrive on the textarea.
2. **Bridge import.** `engine/` builds to wasm with `wasm-bindgen = "=0.2.128"`, and `Session.open(bytes).import()` returns
   `Imported`. `engine.ts` parses it into a `Doc`. Check: for every document in the corpus, each paragraph's `flatText`
   equals rdocx's `ParagraphRef::text()` with atoms removed, `checkDoc` passes, and the generated `wire.d.ts` compiles.
3. **Read-only pages.** `render.ts` and `pages.ts` show an imported document in acdert, virtualized, with headers and
   footers. Check: `acde test` opens three corpus documents, screenshots match references, and a 100-page document shows
   page 1 in under one second. The drift report from risk 4 runs here.
4. **Pure editing core.** `model.ts` and `edit.ts` with typing, deletion across paragraphs, Enter, marks, paragraph props,
   lists, tables and undo. Check: `bun test` with property tests. Random command sequences keep `checkDoc` true, and undo
   after any sequence restores the original object.
5. **Input and geometry.** `input.ts` and the caret, selection, hit testing and motion in `pages.ts`. Check: `acde test`
   types English and `keyboard.insertText('你好')`, presses Enter, Backspace across a paragraph boundary, arrows, Up and Down
   across a page break with a stable goal column, drag-select, double and triple click, copy and paste, and asserts the
   model. Keystroke p95 on a 20-page document stays under 8 ms.
6. **rdocx editing kit.** The four upstream additions with tests in rdocx. Check: the property test from risk 3 passes
   on the corpus.
7. **Save and file lifecycle.** `write.rs` with region planning and verification, plus new, open (picker, drop, request),
   save, save as and the unsaved-changes dialog in `app.ts`. Check: a round-trip harness applies scripted edits to each
   corpus document, saves, and asserts that edited paragraphs match the model, that the unmodeled-item multiset is
   unchanged, and that kept paragraphs no deletion touched are byte-identical through `paragraph_element_xml`.
8. **Formatting UI.** Toolbar, styles, alignment, spacing, indents, lists, stored marks, zh and en strings. Check:
   toggling bold at a collapsed caret and typing yields a saved run with direct bold and its neighbors without it, and
   toolbar state matches the selection in each case.
9. **Tables, images, page setup, zoom.** Check: inserting a table, adding and removing rows and columns, and inserting an
   image round-trip through save. Changing margins changes the page count and the saved `w:pgMar`. Clicking text at 150
   percent zoom places the caret on the clicked character.
10. **Export.** PDF through the font service, and HTML. Check: a Chinese corpus document exports to a PDF whose
    `pdffonts` list shows embedded SimSun or its alias and whose `pdftotext` output equals the document text.

## Next implementation step

Build unit 1, the throwaway acdert probe for risks 1 and 2, because its numbers decide whether this direction survives.
