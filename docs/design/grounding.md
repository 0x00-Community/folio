# Grounding for the Word editor design

Goal: a Word-like editor app for Dopame OS (acde/acdert runtime) built on the Rust library rdocx at
`/Users/lilleap/code/rdocx`. The app project is `/Users/lilleap/code/rdocx-acde` (git, baseline commit is a throwaway
textarea prototype with a Node backend spawning a native rdocx binary; everything there may be replaced).
The acde developer docs are the skill at `/Users/lilleap/.claude/skills/acde/SKILL.md` and its `references/`.

The user is Chinese. Their real documents are Chinese government forms, theses, agreements: CJK text, SimSun/SimHei,
tables, numbered headings, headers and footers. CJK must work.

## Runtime facts (measured in acdert 0.0.10, macOS, this session)

All numbers below were measured with throwaway probe apps under the session scratchpad.

Editing primitives:
- `contenteditable` is nearly inert. Typing inserts text, Backspace deletes, but Enter does nothing (keydown fires, no
  beforeinput), ArrowLeft/Right/Down/End and Shift+Arrow do not move the selection, no caret is painted,
  `document.execCommand('bold')` returns false.
- `beforeinput` fires with `inputType`/`data`, is cancelable, and `preventDefault()` works. `getTargetRanges()` is empty.
- A `<textarea>` works as an input sink: keydown, beforeinput (`insertText`, `insertLineBreak`, `deleteContentBackward`),
  input, copy events fire. ArrowRight moves its caret; ArrowDown and Shift+Arrow extension did not.
- IME composition could not be exercised headlessly (no OS IME in `acde act`). Treat composition handling as unverified;
  design for `compositionstart/update/end` on a focused textarea, positioned at the caret.
- `document.caretPositionFromPoint(x, y)` and `caretRangeFromPoint` return correct text node + offset, including for
  wrapped lines and CJK. `Range.getClientRects()` returns one rect per line fragment; collapsed ranges give a 1px caret rect.
- `navigator.clipboard.readText`, `ClipboardEvent`, `DataTransfer` exist.
- ResizeObserver, IntersectionObserver, MutationObserver, TextEncoder exist. No Web Workers, no WebGL, no OffscreenCanvas.

Fonts and text painting:
- CSS `@font-face` with `src:url(...)` works for HTML text: app files, `blob:` URLs, and `data:` URLs all work.
- `new FontFace(name, arrayBuffer)` reports `loaded` but is NOT used for painting (HTML, SVG, canvas all fall back).
- SVG `<text>` ignores web fonts entirely (always a default serif). So rdocx's `render_page_to_svg` (which embeds fonts
  as `@font-face` data URLs inside the SVG, 2.7 MB per page) paints with the wrong font. Do not use it for display.
- Absolutely positioned HTML `<span>`s with a web font paint correctly.
- System CJK fonts paint in HTML by family name (`sans-serif` gives PingFang, `Songti SC`, `SimSun` work).
- This Mac has `/Library/Fonts` or `~/Library/Fonts` SimSun.ttf, SimHei.ttf, Kaiti.ttf; `/System/Library/Fonts/Hiragino Sans GB.ttc`
  (24 MB), `STHeiti Light.ttc` (56 MB), PingFang.ttc under `/System/Library/AssetsV2/...`.

rdocx in the page as WebAssembly:
- rdocx (facade crate, `default-features = false`) compiles to `wasm32-unknown-unknown`; `wasm-bindgen` CLI 0.2.128 is
  installed, so the engine crate must pin `wasm-bindgen = "=0.2.128"` in its own lockfile. Release (opt-level s, LTO):
  17-19 MB `.wasm` (fonts are bundled inside).
- `WebAssembly.instantiate(bytes)` works; `instantiateStreaming` is absent. Init 8 ms. `from_bytes` on a small docx 13 ms.
  `to_pdf` 39 ms.
- Layout in wasm, generated 240-paragraph doc (14 Letter pages, Carlito): first `layout()` 106 ms; after a small run edit,
  `layout()` again takes 16-18 ms (shaping caches are reused, but layout is a whole-document pass; no incremental API).
  Roughly 1.1 ms per page per relayout.
- Page 0 of that doc has 550 `GlyphRun`s (rdocx splits runs at word boundaries), each with `source` set.
- Under wasm, rdocx has no system font discovery. Bundled fonts: Carlito, Caladea, Gelasio, Selawik, Liberation
  Sans/Serif/Mono, Noto Arabic/Devanagari/Thai/Hebrew, and only tiny SUBSETS of Noto Sans SC/JP/KR (87 KB SC). So arbitrary
  Chinese text lays out with missing glyphs unless the caller supplies CJK font bytes
  (`Document::layout_with_fonts(&[(&str family, &[u8])])`). PDF export has the same need.
- An app backend (Node, `server.ts`, `export default { fetch }`) is portable JS and can read system font files from disk;
  pages cannot (acde:fs has no fonts root). See `/Users/lilleap/.claude/skills/acde/references/guide/backend.md`.

## rdocx API facts (from a full read of the facade; file:line in the rdocx repo)

D = crates/rdocx/src/document.rs, P = paragraph.rs, R = run.rs, T = table.rs, L = crates/rdocx-layout/src/lib.rs,
O = crates/oxml-layout/src/output.rs.

Lifecycle: `Document::new()`, `from_bytes(&[u8])` D:17719, `to_bytes(&mut self)` D:18197, `to_pdf(&self)` D:35659,
`to_html`, `to_html_fragment` (no source mapping, no data attributes), `to_markdown`. `Document` is not `Clone`;
`clone_for_staging(&self)` D:16519 deep-clones (O(package size)). Many `Document::` mutators (`try_remove_content`,
`embed_image`, `insert_table_column`, `remove_table_row`) clone internally, so they cost O(document). Direct
`paragraph_mut`/`run_mut`/`table_mut` edits are in place and cheap. Every mutation invalidates the cached layout.

Body: `body_items()` D:24200 yields `BodyItemRef::{Paragraph, Table, ContentControl, UnsupportedXml}`; its enumerate index is
the body (content) index. `content_count()`, `remove_content(i)`, `insert_paragraph(i, text)` (panics if i > count),
`insert_table(i, rows, cols)`. Paragraph index (`paragraph(i)`, `paragraph_mut(i)`) counts body paragraphs only (skips
tables, enters block SDTs); map with `paragraph_index_of_content` / `content_index_of_paragraph` D:26051/26065.
Typed story locators: `ContentLocation`, `insert_content`, `remove_content_at`, `move_content`, `clone_content`,
`story_items(&StoryId)`.

Paragraph (mutable `Paragraph<'_>` has almost no getters; read via `ParagraphRef`):
`text()`, `set_text(&str)` (replaces all runs with one, keeps pPr, `\t` tab, `\n` break), `add_run(&str)` (append only),
`run_count`, `run(i)`, `run_mut(i)` (None for runs nested in revisions/SDTs), `split_run(run_index, char_offset) -> Result<usize>`
P:1257 (Unicode scalar offset, new run at index+1 with cloned rPr), `remove_run(i)` P:1284. No `insert_run(at)`, no
paragraph split or merge API (build Enter from `insert_paragraph` + split/remove runs; there is no API that moves a run with
its XML from one paragraph to another).
Properties: `set_style(id)`, `set_alignment(Alignment::{Left,Center,Right,Justify})`, indents (`set_indent_left`,
`set_first_line_indent`, `set_hanging_indent`, all `Length`), spacing (`set_space_before/after`, `set_line_spacing_multiple`),
`set_numbering(num_id, level) -> bool`, `set_numbering_value(None)`, `set_page_break_before`, `set_keep_with_next`.
Lists: `Document::add_list_definition(&[ListLevel]) -> u32` D:28895 with `ListLevel::bullet()` / `decimal()`.
`ParagraphRef::items()` yields `Run | Hyperlink | Equation | ContentControl | Revision | Comment/Bookmark markers | UnsupportedXml`.

Run: `text()`, `set_text`, `add_text`, `add_tab`, `add_break(BreakKind)`, `add_picture(rel_id, w, h)`,
`set_bold/italic/underline/strike`, `set_size(pt)`, `set_font(name)` (all four slots), `set_slot_font(RunFontSlot::EastAsia, ..)`,
`set_color("FF0000")`, `set_highlight(name)`, `set_superscript/subscript`, `_value(Option)` variants to clear.
`RunRef` getters return DIRECT values only. `RunRef::items()` yields `Text | Tab | Break | Drawing(DrawingRef) | Field | FootnoteReference | ...`.

Effective formatting: `Document::effective_paragraph_properties(&ParagraphRef) -> CT_PPr` D:30356 and
`effective_run_properties(&ParagraphRef, &RunRef) -> CT_RPr` D:30411 merge docDefaults, style chains, numbering, direct.
Theme fonts are not resolved (`font_ascii_theme = "minorHAnsi"`); resolve via `Document::theme()`.
Styles: `styles()`, `style(id)` with `style_id()`, `name()`, `style_type()`.

Tables: `TableRef` rows/cells/`grid_widths`, `CellRef::paragraphs()`, `items()` (nested tables). Mutation via `table_mut(i)`,
`Cell::paragraph_mut(i)`, `Cell::add_paragraph`, `Table::add_row`, `Document::clone_table_row`, `remove_table_row`,
`insert_table_column`, `delete_table_column`, `Table::merge_cells`, borders, shading.

Images: `Document::image_data(rel_id)`, `pictures()` (bytes + EMU size + location), `embed_image(bytes, name) -> rel_id`,
`insert_picture_at(&StoryRunPosition, bytes, name, w, h)`.

Sections: `sections()`, `SectionRef::page_size()`, `margins()`, `section_mut(i).set_page_size/set_margins/set_orientation`.
Headers/footers via `section_story(..)` + `story_items` + `set_story_text(&ContentLocation, &str)`.

Layout: `Document::layout(&self) -> Result<Arc<rdocx_layout::WordLayoutResult>>` D:35409 (cached until next mutation),
`layout_with_fonts(&[(&str, &[u8])])` D:35525 (uncached). `WordLayoutResult.layout.pages: Vec<Arc<PageFrame>>`,
`PageFrame { width, height, elements: Vec<PositionedElement> }` in points, origin top-left. Walk with
`oxml_layout::walk(&elements, |el, transform| ..)`. Elements: `Text(GlyphRun)`, `MultilingualText(..)` (with clusters),
`Line`, `FilledRect`, `Image { rect, data, content_type }`, `LinkAnnotation`, `Path`, `Group`, `MarkedContent`.
`GlyphRun { origin (baseline, pt), font_id, font_size, glyph_ids, advances (per glyph, pt), text, source: Option<SourceSpan>, color, bold, italic, field_kind, .. }`.
`SourceSpan { node: SourceNodeId, char_start, char_end }` in Unicode scalars of the paragraph's accepted-view text
(tab/break/CR count 1, drawings 0, matches `ParagraphRef::text()`); None for caps-transformed text, field results, list markers.
`WordLayoutResult::source_node(id) -> Option<&WordSourcePath { story, children }>`: body paragraph = `children [body_index]`,
table cell paragraph = `[body_index, row, cell, content_index]`, headers/footers use `WordStory::Header{..}`.
`body_layout_fragments(body_index)` gives per-page block boxes. `paragraph_numbering(SourceNodeId)` gives list marker text.
`LayoutResult.fonts: Vec<FontData { id, family, data: Arc<[u8]>, face_index, bold, italic }>` (the exact font bytes each glyph run used).
No hit-test API; no line boxes (group GlyphRuns by baseline y). Caret x inside a run = `origin.x + sum(advances[..k])` when glyphs map 1:1 to chars.

`crates/rdocx-wasm` exposes only 14 coarse append-only methods; a new wasm surface is needed regardless of design.
