//! Candidate A engine sketch: the wasm-bindgen surface (`Editor`) and the internal executor.
//!
//! One file for review. In the crate each `mod` below is its own file (`engine/src/<mod>.rs`); `lib.rs` holds only
//! `Editor`. Bodies are `todo!()`; `// TODO` blocks are pseudocode for the tricky parts.
//!
//! # Usage (written first; the types below are derived from it)
//!
//! The page drives `Editor` (see editor.ts). Native tests drive `Session`, the same object without wasm:
//!
//! ```ignore
//! // 1. Open a Chinese form, give it SimSun, click into a cell, type, and see the caret on page 1.
//! let mut s = Session::open(&std::fs::read("fixtures/gov-form.docx")?)?;
//! for family in s.wanted_fonts() { if family == "SimSun" { s.add_font("SimSun", std::fs::read("/Library/Fonts/SimSun.ttf")?) } }
//! s.apply(Command::Pointer { phase: PointerPhase::Down, at: DocPoint { x: 180.0, y: 240.0 }, clicks: 1, extend: false })?;
//! s.apply(Command::InsertText { text: "申请人：张三".into() })?;
//! let u = s.frame()?;
//! assert_eq!(u.caret.map(|c| c.page), Some(0));
//!
//! // 2. Enter then Backspace is a no-op on text; one undo returns to the opened content.
//! s.apply(Command::InsertParagraph)?;
//! s.apply(Command::Delete { dir: Dir::Back, unit: DeleteUnit::Char })?;
//! s.seal()?;
//! s.apply(Command::Undo)?;
//! assert_eq!(s.debug_text(), original_text);
//!
//! // 3. The PDF is rendered from the exact layout on screen, CJK faces included.
//! let pdf = s.export_pdf()?;
//! ```

#![allow(dead_code, unused_variables)]

use std::collections::HashMap;
use std::ops::Range;

use rdocx::{Document, Paragraph, ParagraphRef, RunRef};
use rdocx_layout::{SourceNodeId, WordLayoutResult, WordSourcePath};

// ---------------------------------------------------------------------------------------------------------------
// wire: the only types that cross into JS. tsify generates wire.ts from these; nothing else is exported.
// ---------------------------------------------------------------------------------------------------------------
pub mod wire {
    use serde::{Deserialize, Serialize};
    use tsify::Tsify;

    /// Intent only. No command carries a document position: the engine resolves moves and points against its own
    /// layout, so the frontend cannot hold a stale or UTF-16 offset.
    #[derive(Debug, Clone, Deserialize, Tsify)]
    #[tsify(from_wasm_abi)]
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum Command {
        InsertText { text: String },
        InsertParagraph,
        InsertLineBreak,
        Delete { dir: Dir, unit: DeleteUnit },
        Move { unit: MoveUnit, dir: Dir, extend: bool },
        /// `at` is in document points (page stack space; see `PageMeta::top`).
        Pointer { phase: PointerPhase, at: DocPoint, clicks: u8, extend: bool },
        SelectAll,
        Compose(Compose),
        ToggleMark { mark: Mark },
        SetRun { patch: RunPatch },
        SetParagraph { patch: ParaPatch },
        ToggleList { kind: ListKind },
        ListLevel { delta: i8 },
        /// Plain text; `\n` separates paragraphs. Rich paste later goes through `insert_html_fragment`.
        Paste { text: String },
        InsertTable { rows: u16, cols: u16 },
        Table { op: TableOp },
        PageSetup { width_pt: f32, height_pt: f32, margins_pt: [f32; 4] },
        Undo,
        Redo,
    }

    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum Dir { Back, Fwd }
    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum DeleteUnit { Char, Word }
    /// Arrows, Ctrl+arrows, Home/End, Up/Down, PageUp/PageDown, Ctrl+Home/End.
    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum MoveUnit { Char, Word, LineEdge, Line, Screen { viewport_pt: f32 }, DocEdge }
    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum PointerPhase { Down, Drag, Up }
    #[derive(Debug, Clone, Copy, Deserialize, Serialize, Tsify)]
    pub struct DocPoint { pub x: f32, pub y: f32 }

    #[derive(Debug, Clone, Deserialize, Tsify)]
    #[serde(tag = "phase", rename_all = "camelCase")]
    pub enum Compose { Start, Update { text: String }, Commit { text: String }, Cancel }

    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum Mark { Bold, Italic, Underline, Strike }

    /// Direct run properties the editor models. `None` = leave as is; `Some(None)` = clear the direct value.
    #[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct RunPatch {
        pub bold: Option<bool>,
        pub italic: Option<bool>,
        pub underline: Option<bool>,
        pub strike: Option<bool>,
        /// Applied to ascii, hAnsi and eastAsia slots (`set_font` sets all four; eastAsia via `set_slot_font`).
        pub font: Option<String>,
        pub size_pt: Option<f32>,
        pub color: Option<Option<String>>,
        pub highlight: Option<Option<String>>,
    }

    #[derive(Debug, Clone, Default, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct ParaPatch {
        pub style: Option<StyleChoice>,
        pub align: Option<Align>,
        pub line_spacing: Option<f32>,
        pub indent_left_pt: Option<f32>,
        pub first_line_pt: Option<f32>,
        pub space_before_pt: Option<f32>,
        pub space_after_pt: Option<f32>,
    }

    #[derive(Debug, Clone, PartialEq, Deserialize, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum StyleChoice { Normal, Title, Heading1, Heading2, Heading3, Other { name: String } }
    #[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum Align { Left, Center, Right, Justify }
    #[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum ListKind { Bullet, Decimal }
    #[derive(Debug, Clone, Copy, Deserialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum TableOp { RowAbove, RowBelow, ColLeft, ColRight, DeleteRow, DeleteCol }

    /// One per animation frame. `layout` is present only when the document was laid out since the last frame.
    #[derive(Debug, Clone, Serialize, Tsify)]
    #[tsify(into_wasm_abi)]
    #[serde(rename_all = "camelCase")]
    pub struct Update {
        pub rev: u32,
        pub layout: Option<LayoutMeta>,
        /// `None` while the selection is a range (Word draws no caret then) or lies in no laid-out line.
        pub caret: Option<CaretRect>,
        pub selection: Vec<PageRect>,
        pub composition: Vec<PageRect>,
        pub format: FormatState,
        pub r#where: Where,
        /// The state differs from the last save (or from the opened file).
        pub dirty: bool,
        pub notice: Option<NoticeCode>,
        /// Scroll the caret into view (true after edits and keyboard moves, false after pointer drags).
        pub reveal: bool,
    }

    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct LayoutMeta { pub pages: Vec<PageMeta>, pub new_fonts: Vec<FontMeta> }

    /// Points. `top` is the page's offset in the single vertical document space (engine-owned page gap).
    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct PageMeta { pub index: u32, pub width: f32, pub height: f32, pub top: f32, pub hash: String }

    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct FontMeta { pub key: String, pub family: String }

    #[derive(Debug, Clone, Copy, Serialize, Tsify)]
    pub struct CaretRect { pub page: u32, pub x: f32, pub y: f32, pub h: f32 }
    #[derive(Debug, Clone, Copy, Serialize, Tsify)]
    pub struct PageRect { pub page: u32, pub x: f32, pub y: f32, pub w: f32, pub h: f32 }
    #[derive(Debug, Clone, Copy, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct Where { pub page: u32, pub page_count: u32 }

    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum Tri { On, Off, Mixed }

    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct FormatState {
        pub bold: Tri,
        pub italic: Tri,
        pub underline: Tri,
        pub strike: Tri,
        /// `None` = mixed across the selection.
        pub font: Option<String>,
        pub size_pt: Option<f32>,
        pub color: Option<String>,
        pub highlight: Option<String>,
        pub style: Option<StyleChoice>,
        pub align: Option<Align>,
        pub list: Option<ListKind>,
        pub line_spacing: Option<f32>,
        pub read_only: bool,
    }

    /// A refused command. TS maps codes to zh/en strings; the engine never produces UI text.
    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub enum NoticeCode { ReadOnlyRegion, TrackedChanges, FieldBoundary, StructureBoundary, CannotSplitHere, NothingToUndo }

    /// One page's paint list. Lines are keyed by content hash so the painter keeps DOM for unchanged lines.
    #[derive(Debug, Clone, Serialize, Tsify)]
    #[tsify(into_wasm_abi)]
    #[serde(rename_all = "camelCase")]
    pub struct PageView { pub index: u32, pub lines: Vec<LineView>, pub shapes: ShapesView }

    #[derive(Debug, Clone, Serialize, Tsify)]
    pub struct LineView { pub key: String, pub spans: Vec<SpanView> }

    /// Points, baseline origin. `ls` = letter-spacing that makes the browser's advances equal rdocx's.
    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct SpanView {
        pub x: f32,
        pub baseline: f32,
        pub text: String,
        pub font: String,
        pub size: f32,
        pub color: String,
        pub ls: Option<f32>,
        pub weight: Option<u16>,
        pub italic: bool,
        /// CSS matrix for runs inside rotated or scaled groups; `None` for plain translation.
        pub transform: Option<[f32; 6]>,
    }

    /// Non-text elements in paint order, split at the first text element into below and above layers.
    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(rename_all = "camelCase")]
    pub struct ShapesView { pub key: String, pub below: Vec<Shape>, pub above: Vec<Shape> }

    #[derive(Debug, Clone, Serialize, Tsify)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum Shape {
        Rect { x: f32, y: f32, w: f32, h: f32, fill: String },
        Line { x1: f32, y1: f32, x2: f32, y2: f32, stroke: String, width: f32 },
        Path { d: String, fill: Option<String>, stroke: Option<String>, width: f32 },
        Image { x: f32, y: f32, w: f32, h: f32, media: String },
    }

    #[derive(Debug, Clone, Serialize, Tsify)]
    #[tsify(into_wasm_abi)]
    #[serde(rename_all = "camelCase")]
    pub struct Stats { pub words: u32, pub characters: u32 }
}

use wire::*;

// ---------------------------------------------------------------------------------------------------------------
// addr: positions. Engine-internal. Offsets are Unicode scalars of `ParagraphRef::text()` (the SourceSpan unit).
// ---------------------------------------------------------------------------------------------------------------
pub mod addr {
    use super::*;

    /// The places the editor may write. A region with no variant here is read-only by construction.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ParaAddr {
        /// Direct body paragraph; `content` is the body index of `insert_paragraph` D:25975 / `remove_content` D:26220.
        Body { content: u32 },
        /// Paragraph inside a block content control; `paragraph` is the `paragraph_mut` D:25422 index.
        InControl { paragraph: u32 },
        /// Paragraph in a table cell; `table` is the `table_mut` D:25509 index (counts tables inside SDTs too).
        Cell { table: u32, row: u16, col: u16, para: u16 },
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Pos { pub para: ParaAddr, pub offset: u32 }

    #[derive(Debug, Clone, PartialEq)]
    pub struct Selection {
        pub anchor: Pos,
        pub focus: Pos,
        /// Up/Down goal column in page points; cleared by any horizontal move or edit.
        pub goal_x: Option<f32>,
        /// Marks toggled at a collapsed caret; applied to the next inserted text, cleared by any move.
        pub pending: Option<RunPatch>,
    }

    /// Live IME preedit: `len` scalars at `start` are provisional document text.
    #[derive(Debug, Clone)]
    pub struct Composition { pub start: Pos, pub len: u32 }

    /// A selection normalized to document order.
    pub struct Span<'a> { pub start: &'a Pos, pub end: &'a Pos }

    impl Selection {
        pub fn caret(at: Pos) -> Self { todo!() }
        pub fn is_collapsed(&self) -> bool { todo!() }
        pub fn ordered(&self) -> Span<'_> { todo!() }
    }

    /// The single owner of rdocx's index arithmetic. Must mirror `nth_paragraph_in_body` D:14516 (skips top-level
    /// tables, enters SDTs, and inside SDTs enters tables) and `nth_table_in_body` D:14703.
    pub struct Resolver;

    impl Resolver {
        /// `None` = not provably writable (header, footnote, text box, unmatched SDT path): read-only.
        // TODO: walk `doc.body_items()` D:24200 along `path.children`:
        //   [b] + Paragraph            -> Body{b}
        //   [b, r, c, p] + Table       -> Cell{table_index_of(b), r, c, p}
        //   [b, k, ..] + ContentControl -> InControl{count paragraphs before} or Cell inside the control
        //   guard: paragraph(addr).text().chars().count() >= max char_end seen for this node, else None.
        pub fn resolve(doc: &Document, path: &WordSourcePath) -> Option<ParaAddr> { todo!() }
        pub fn path_of(doc: &Document, addr: &ParaAddr) -> WordSourcePath { todo!() }
        /// Read access for any addressable paragraph.
        pub fn read<R>(doc: &Document, addr: &ParaAddr, f: impl FnOnce(ParagraphRef<'_>) -> R) -> R { todo!() }
        /// Write access in place: `paragraph_mut` / `table_mut(t).cell(r, c).paragraph_mut(p)` (T:2007, T:2291).
        pub fn write<R>(doc: &mut Document, addr: &ParaAddr, f: impl FnOnce(&mut Paragraph<'_>) -> R) -> R { todo!() }
    }

    /// UAX#29 word boundaries over `ParagraphRef::text()` (Han characters are single words until a dictionary
    /// segmenter replaces this function).
    pub fn word_at(text: &str, offset: u32) -> Range<u32> { todo!() }
    pub fn next_word_boundary(text: &str, offset: u32, dir: Dir) -> u32 { todo!() }
}

use addr::*;

// ---------------------------------------------------------------------------------------------------------------
// kernel: paragraph-local edits. Pure over one `Paragraph`; no document-level structure, no layout.
// ---------------------------------------------------------------------------------------------------------------
pub mod kernel {
    use super::*;

    /// A paragraph offset resolved to an accepted-view run and an offset inside its literal text.
    pub struct RunCursor { pub run: usize, pub offset: usize }

    /// One run copied by value: what `add_run` + item adders + setters can rebuild in place.
    #[derive(Debug, Clone)]
    pub struct RunValue { pub items: Vec<RunItemValue>, pub props: RunProps }

    #[derive(Debug, Clone)]
    pub enum RunItemValue { Text(String), Tab, Break(rdocx::BreakKind), Picture { rel_id: String, w_emu: i64, h_emu: i64 } }

    /// Every direct property a `RunRef` getter exposes (R:1241 onward), copied getter -> setter.
    #[derive(Debug, Clone, Default)]
    pub struct RunProps { /* bold, italic, underline code, strike, size, slot fonts, theme fonts, hint, color,
                            color theme, highlight, shading, vert align, caps, lang (3), spacing, scale, position,
                            kern, style id, hidden, no proof, snap to grid, ... */ }

    /// Runs `b..n` of a paragraph: plain ones move by value, anything else moves as XML in a transaction.
    pub enum Transplant { Plain(Vec<RunValue>), Rich }

    /// Plain = direct `ParagraphItemRef::Run` P:32 outside `hyperlink_spans()` P:2989, items only
    /// Text | Tab | Break | inline Drawing (R:331), and no comment/bookmark markers between the runs.
    pub fn classify(p: &ParagraphRef<'_>, runs: Range<usize>) -> Transplant { todo!() }

    pub fn locate(p: &ParagraphRef<'_>, offset: u32) -> RunCursor { todo!() }

    /// Insert `text` (may contain `\t`) at `offset`. The text lands in a text run: the run before the caret if it is a
    /// text run, else the run after, else a new run appended (tail transplanted when not plain -> caller's slow path).
    // TODO: when `patch` differs from the host run's props:
    //   run_mut(k).set_text(head + text + tail)          R:471
    //   split_run(k, head_len)                          P:1257  -> k+1 = text + tail (rPr cloned)
    //   split_run(k+1, text_len)                        P:1257  -> k+1 = text, k+2 = tail
    //   apply patch to run k+1 via setters
    //   (runs nested in hyperlinks / inline SDTs / insertions: same steps through `edit_run` P:1227)
    pub fn insert_text(p: &mut Paragraph<'_>, at: &RunCursor, text: &str, patch: Option<&RunPatch>) -> Result<(), Refusal> { todo!() }

    /// Delete `range` inside one paragraph: trim text runs with `set_text`, drop whole runs with `remove_run` P:1284.
    /// `remove_run` refusing (half a field, a note reference) becomes `Refusal(FieldBoundary)`.
    pub fn delete(p: &mut Paragraph<'_>, range: Range<u32>) -> Result<(), Refusal> { todo!() }

    pub fn read_runs(p: &ParagraphRef<'_>, runs: Range<usize>) -> Vec<RunValue> { todo!() }
    pub fn append_runs(p: &mut Paragraph<'_>, runs: &[RunValue]) { todo!() }
    /// Style, alignment, indents, spacing, numbering, keep/page-break flags, mark props: getter -> setter.
    pub fn copy_paragraph_props(from: &ParagraphRef<'_>, to: &mut Paragraph<'_>) { todo!() }
    pub fn apply_patch(p: &mut Paragraph<'_>, runs: Range<usize>, patch: &RunPatch) { todo!() }

    /// Lossless join for rich merges: B's children (minus `w:pPr`) appended before A's `</w:p>`, B's namespace
    /// declarations merged onto A's root. Inputs are `paragraph_element_xml` D:22601 output (namespace-complete).
    pub fn join_xml(a: &[u8], b: &[u8]) -> Result<String, Refusal> { todo!() }

    #[derive(Debug)]
    pub struct Refusal(pub NoticeCode);
}

use kernel::*;

// ---------------------------------------------------------------------------------------------------------------
// fonts: caller font bytes and Chinese family aliases, passed to every layout.
// ---------------------------------------------------------------------------------------------------------------
pub mod fonts {
    pub struct FontStore { files: Vec<(String, Vec<u8>)>, aliases: Vec<(String, String)> }

    impl FontStore {
        /// 宋体 -> SimSun, 黑体 -> SimHei, 楷体/楷体_GB2312 -> KaiTi, 仿宋/仿宋_GB2312 -> FangSong, 微软雅黑 ->
        /// Microsoft YaHei, plus a generic CJK fallback alias to whichever CJK face was added first.
        pub fn new() -> Self { todo!() }
        /// Idempotent per family: re-adding the same family replaces its bytes.
        pub fn add(&mut self, family: &str, bytes: Vec<u8>) { todo!() }
        pub fn files(&self) -> Vec<(&str, &[u8])> { todo!() }
        pub fn aliases(&self) -> Vec<(&str, &str)> { todo!() }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// view: layout, page hashes, page views, font and media keys.
// ---------------------------------------------------------------------------------------------------------------
pub mod view {
    use super::*;

    /// Everything derived from one layout. Rebuilt whole when the document changes; geometry built lazily per page.
    pub struct ViewCache {
        pub layout: WordLayoutResult,
        pub pages: Vec<PageMeta>,
        pub node_of: HashMap<WordSourcePath, SourceNodeId>,
        pub geom: Vec<Option<geom::PageGeom>>,
        /// `font_id` of this layout -> content key; keys survive relayouts that renumber ids.
        pub font_keys: HashMap<u32, String>,
    }

    pub const PAGE_GAP_PT: f32 = 12.0;

    /// `layout_with_fonts_aliases_and_bundled_fallback` D:35587: the reusable engine keeps shaping and paragraph
    /// caches across calls. Never `Document::layout()` (no caller fonts) and never `to_pdf` D:35659.
    pub fn lay_out(doc: &Document, fonts: &fonts::FontStore, known_fonts: &HashMap<String, ()>) -> anyhow::Result<(ViewCache, Vec<FontMeta>)> { todo!() }

    /// Hash of every positioned element on the page (text, origin, font key, size, color, shapes).
    pub fn page_hash(frame: &rdocx_layout::PageFrame) -> String { todo!() }

    // TODO: walk elements with `oxml_layout::walk`; Text/MultilingualText -> spans grouped into lines by
    // (source node, baseline); per span ls = mean(advance - natural_hmtx_advance); split the span where the
    // deviation is not uniform (CJK justification); FilledRect/Line/Path/Image -> shapes, below or above text.
    pub fn page_view(cache: &ViewCache, index: u32) -> PageView { todo!() }

    pub fn font_bytes(cache: &ViewCache, key: &str) -> Option<Vec<u8>> { todo!() }
    pub fn media_bytes(cache: &ViewCache, key: &str) -> Option<Vec<u8>> { todo!() }
}

// ---------------------------------------------------------------------------------------------------------------
// geom: caret, selection, hit test, movement. Pure functions of one ViewCache and the Document's text.
// ---------------------------------------------------------------------------------------------------------------
pub mod geom {
    use super::*;

    /// One visual line: runs of one source node sharing a baseline, sorted by x.
    pub struct GeomLine { pub node: SourceNodeId, pub top: f32, pub bottom: f32, pub baseline: f32, pub x0: f32, pub x1: f32, pub stops: Vec<Stop> }
    /// Caret stop: `x = origin.x + sum(advances[..glyph_of(offset)])`; clusters for MultilingualText.
    pub struct Stop { pub offset: u32, pub x: f32 }
    pub struct PageGeom { pub lines: Vec<GeomLine> }

    /// Lines of every page that `body_layout_fragments(body_index)` L:354 says the paragraph touches.
    pub fn caret_rect(cache: &mut view::ViewCache, doc: &Document, pos: &Pos) -> Option<CaretRect> { todo!() }
    pub fn selection_rects(cache: &mut view::ViewCache, doc: &Document, sel: &Selection) -> Vec<PageRect> { todo!() }
    /// Nearest addressable stop; lines whose node has no `ParaAddr` and spans with `source: None` are skipped.
    pub fn hit(cache: &mut view::ViewCache, doc: &Document, at: DocPoint) -> Option<Pos> { todo!() }
    /// Line and Screen moves use `goal_x`; LineEdge and DocEdge do not. Returns the new focus and goal.
    pub fn moved(cache: &mut view::ViewCache, doc: &Document, from: &Pos, goal_x: Option<f32>, unit: MoveUnit, dir: Dir) -> (Pos, Option<f32>) { todo!() }
}

// ---------------------------------------------------------------------------------------------------------------
// history: whole-document checkpoints. Exact for every command because it is rdocx's save path.
// ---------------------------------------------------------------------------------------------------------------
pub mod history {
    use super::*;

    pub struct Checkpoint { pub id: u64, pub bytes: Vec<u8>, pub resume: Selection }

    pub struct History {
        /// `past.last()` is the state at the most recent seal. `past[0]` is the opened file's bytes.
        past: Vec<Checkpoint>,
        future: Vec<Checkpoint>,
        /// The live document differs from `past.last()`.
        dirty: bool,
        saved: Option<u64>,
        budget_bytes: usize,
    }

    pub enum Restore { To(Checkpoint), Nothing }

    impl History {
        pub fn opened(bytes: Vec<u8>, sel: Selection) -> Self { todo!() }
        /// Called before every mutation. The first edit after a seal stores the pre-edit selection as `resume`.
        pub fn will_edit(&mut self, sel: &Selection) { todo!() }
        /// No-op when clean. Otherwise `to_bytes` D:18197 (staged clone; the live layout cache is untouched).
        pub fn seal(&mut self, doc: &mut Document, sel: &Selection) -> anyhow::Result<()> { todo!() }
        pub fn undo(&mut self, doc: &mut Document, sel: &Selection) -> anyhow::Result<Restore> { todo!() }
        pub fn redo(&mut self) -> Restore { todo!() }
        pub fn mark_saved(&mut self) { todo!() }
        pub fn is_dirty_vs_saved(&self) -> bool { todo!() }
        /// The top checkpoint's bytes when clean; `save()` reuses them instead of serializing twice.
        pub fn clean_bytes(&self) -> Option<&[u8]> { todo!() }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// format: toolbar state, styles, lists.
// ---------------------------------------------------------------------------------------------------------------
pub mod format {
    use super::*;

    /// Style ids differ per document (Chinese Word uses ids like "1" named "heading 1"); match by name.
    pub struct StyleCatalog { by_choice: HashMap<String, String> }
    /// `add_list_definition` D:28895 once per kind per document; reused for every toggle.
    pub struct ListCatalog { bullet: Option<u32>, decimal: Option<u32> }

    /// Collapsed: effective props (D:30411) of the run before the caret, overlaid with `pending`; theme fonts
    /// resolved through `Document::theme()` D:32489. Range: tri-state across covered runs.
    pub fn format_state(doc: &Document, sel: &Selection, read_only: bool) -> FormatState { todo!() }
    pub fn stats(doc: &Document) -> Stats { todo!() }
}

// ---------------------------------------------------------------------------------------------------------------
// session: the one owner of all state, and the command executor.
// ---------------------------------------------------------------------------------------------------------------
pub struct Session {
    doc: Document,
    fonts: fonts::FontStore,
    sel: Selection,
    composition: Option<Composition>,
    history: history::History,
    styles: format::StyleCatalog,
    lists: format::ListCatalog,
    /// `None` after any mutation; rebuilt by `frame()` or by any command that needs geometry.
    view: Option<view::ViewCache>,
    known_fonts: HashMap<String, ()>,
    rev: u32,
    notice: Option<NoticeCode>,
    reveal: bool,
    relaid_since_frame: bool,
}

impl Session {
    pub fn blank() -> Self { todo!() }
    pub fn open(bytes: &[u8]) -> anyhow::Result<Self> { todo!() }
    /// Families referenced by styles, runs (all four slots) and theme, plus one CJK fallback.
    pub fn wanted_fonts(&self) -> Vec<String> { todo!() }
    pub fn add_font(&mut self, family: &str, bytes: Vec<u8>) { todo!() }

    /// Apply one command. Cheap for edits (no layout). Commands that need geometry (Move, Pointer) lay out first if
    /// the view is stale. Refusals set `notice`; `Err` is an engine bug.
    pub fn apply(&mut self, cmd: Command) -> anyhow::Result<()> {
        // TODO:
        //   if cmd is discrete (format, paste, table, image, page setup): self.seal()
        //   if cmd mutates: self.history.will_edit(&self.sel)
        //   match cmd -> exec::* ; on Err(Refusal(code)) -> self.notice = Some(code)
        //   if mutated: self.view = None; self.rev += 1; self.reveal = true
        todo!()
    }

    /// At most once per animation frame: lay out if stale, then caret, rects, format, where.
    pub fn frame(&mut self) -> anyhow::Result<Update> { todo!() }
    pub fn page(&mut self, index: u32) -> PageView { todo!() }
    pub fn selected_text(&self) -> String { todo!() }
    pub fn insert_image(&mut self, bytes: &[u8], name: &str) -> anyhow::Result<()> { todo!() }
    /// Seal an undo checkpoint if the document changed and no composition is open. Returns whether it sealed.
    pub fn idle(&mut self) -> anyhow::Result<bool> { todo!() }
    pub fn seal(&mut self) -> anyhow::Result<()> { todo!() }
    /// Seal, then hand out the top checkpoint's bytes and mark them saved.
    pub fn save(&mut self) -> anyhow::Result<Vec<u8>> { todo!() }
    /// `oxml_pdf::render_to_pdf_checked(&cache.layout.layout)` on the on-screen layout.
    pub fn export_pdf(&mut self) -> anyhow::Result<Vec<u8>> { todo!() }
    pub fn stats(&self) -> Stats { todo!() }
    #[cfg(test)]
    pub fn debug_text(&self) -> String { todo!() }

    /// Run `f` on a staged clone and swap it in only if every step succeeds. Keeps the warm layout engine with
    /// `transfer_reusable_bundled_fallback_layout_from_with_aliases` D:35372. Used by every slow-path command.
    fn transact(&mut self, f: impl FnOnce(&mut Document) -> Result<(), Refusal>) -> Result<(), Refusal> {
        // TODO:
        //   let mut next = self.doc.clone_for_staging();                     D:16519
        //   f(&mut next)?;                                                   (drop `next` on refusal: atomic)
        //   next.transfer_reusable_bundled_fallback_layout_from_with_aliases(&mut self.doc, files, aliases);
        //   self.doc = next;
        todo!()
    }

    fn ensure_view(&mut self) -> anyhow::Result<&mut view::ViewCache> { todo!() }
}

/// The executor: one function per command family. Each reads the selection, mutates the Document, and sets the
/// new selection explicitly. Nothing else holds positions, so no position remapping exists.
mod exec {
    use super::*;

    pub fn insert_text(s: &mut Session, text: &str) -> Result<(), Refusal> {
        // TODO: delete a non-empty selection first; split text on '\n' -> first line inserted, then
        // insert_paragraph + insert for each further line; caret after the inserted text; pending marks used once.
        todo!()
    }

    /// Enter. See design.md "Enter and merge from available primitives".
    pub fn split_paragraph(s: &mut Session) -> Result<(), Refusal> {
        // TODO:
        //   Body{j}, offset o:
        //     o == 0   -> insert_paragraph(j, "") D:25975 + copy_paragraph_props; A untouched
        //     o == len -> insert_paragraph(j+1, "") + copy_paragraph_props
        //     else     -> b = split_run(k, o_k) P:1257
        //                 match classify(A, b..n):
        //                   Plain(runs) -> insert_paragraph(j+1) + copy props + append_runs(runs)
        //                                  + remove_run(i) P:1284 for i in (b..n).rev()
        //                   Rich        -> transact: clone_content(A -> after A) D:24097,
        //                                  remove runs b.. from A and ..b from the copy (refusal aborts)
        //   Cell{.., para == last} -> Cell::add_paragraph T:2207 in place; other cells -> insert_content D:23884 in transact
        //   InControl -> Refusal(StructureBoundary) until experiment 7
        todo!()
    }

    /// Backspace at offset 0 (dir Back) or Delete at the end (dir Fwd) of a paragraph.
    pub fn merge(s: &mut Session, dir: Dir) -> Result<(), Refusal> {
        // TODO: A = previous, B = current (or current, next for Fwd); result keeps A's pPr.
        //   B empty     -> remove_content(B) D:26220
        //   A not a paragraph (table, SDT) -> move the caret into it, no merge
        //   classify(B, all):
        //     Plain(runs) -> append_runs(A, runs) in place, then remove_content(B)      (1 staged op)
        //     Rich        -> transact: join_xml(paragraph_element_xml(A), paragraph_element_xml(B)) D:22601,
        //                    replace_paragraph_xml(A) D:22673, remove_content(B)        (2 staged ops)
        todo!()
    }

    pub fn delete(s: &mut Session, dir: Dir, unit: DeleteUnit) -> Result<(), Refusal> {
        // TODO: non-empty selection -> delete_range; at a paragraph edge -> merge; else kernel::delete over one
        // char (grapheme) or word.
        todo!()
    }

    /// Cross-paragraph delete: trim A's tail and Z's head in place, remove the blocks between (one staged op each,
    /// gap G1), merge A and Z. Ends in different table cells: clear covered cells' text, never part of a table.
    pub fn delete_range(s: &mut Session) -> Result<(), Refusal> { todo!() }

    pub fn toggle_mark(s: &mut Session, mark: Mark) -> Result<(), Refusal> {
        // TODO: collapsed -> flip in `sel.pending`; range -> new value = !(all on); split_run at both ends of each
        // covered paragraph, then apply_patch to the covered runs.
        todo!()
    }

    pub fn set_run(s: &mut Session, patch: &RunPatch) -> Result<(), Refusal> { todo!() }
    pub fn set_paragraph(s: &mut Session, patch: &ParaPatch) -> Result<(), Refusal> { todo!() }
    pub fn toggle_list(s: &mut Session, kind: ListKind) -> Result<(), Refusal> { todo!() }
    pub fn list_level(s: &mut Session, delta: i8) -> Result<(), Refusal> { todo!() }

    pub fn move_caret(s: &mut Session, unit: MoveUnit, dir: Dir, extend: bool) -> anyhow::Result<()> { todo!() }
    /// clicks 1: caret; 2: `word_at`; 3: whole paragraph; Drag extends by the unit of the Down that started it.
    pub fn pointer(s: &mut Session, phase: PointerPhase, at: DocPoint, clicks: u8, extend: bool) -> anyhow::Result<()> { todo!() }

    pub fn compose(s: &mut Session, step: &Compose) -> Result<(), Refusal> {
        // TODO:
        //   Start           -> delete a non-empty selection; composition = { start: caret, len: 0 }
        //   Update{text}    -> replace `len` scalars at start with text (pending marks); len = scalars(text)
        //   Commit{text}    -> same replacement, then composition = None, caret after it
        //   Cancel          -> remove the provisional text, composition = None
        todo!()
    }

    pub fn table(s: &mut Session, op: TableOp) -> Result<(), Refusal> {
        // TODO: rows below/above: Table::add_row T:925 in place (+ move to index via clone_table_row when not last);
        // delete row: remove_table_row D:25712; columns: insert_table_column D:25533 / delete_table_column D:25601.
        todo!()
    }

    pub fn page_setup(s: &mut Session, width_pt: f32, height_pt: f32, margins_pt: [f32; 4]) -> Result<(), Refusal> {
        // TODO: every section: section_mut(i).set_page_size / set_margins (D:4255, D:4292), in place.
        todo!()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// lib.rs: the wasm surface. Parses at the boundary, forwards, serializes. No logic.
// ---------------------------------------------------------------------------------------------------------------
pub mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct Editor { session: Session }

    #[wasm_bindgen]
    impl Editor {
        pub fn blank() -> Editor { todo!() }
        pub fn open(bytes: &[u8]) -> Result<Editor, JsError> { todo!() }
        #[wasm_bindgen(js_name = wantedFonts)]
        pub fn wanted_fonts(&self) -> Vec<String> { todo!() }
        #[wasm_bindgen(js_name = addFont)]
        pub fn add_font(&mut self, family: &str, bytes: Vec<u8>) { todo!() }
        pub fn apply(&mut self, cmd: Command) -> Result<(), JsError> { todo!() }
        pub fn frame(&mut self) -> Result<Update, JsError> { todo!() }
        pub fn page(&mut self, index: u32) -> PageView { todo!() }
        #[wasm_bindgen(js_name = fontBytes)]
        pub fn font_bytes(&self, key: &str) -> Option<Vec<u8>> { todo!() }
        #[wasm_bindgen(js_name = mediaBytes)]
        pub fn media_bytes(&self, key: &str) -> Option<Vec<u8>> { todo!() }
        #[wasm_bindgen(js_name = selectedText)]
        pub fn selected_text(&self) -> String { todo!() }
        #[wasm_bindgen(js_name = insertImage)]
        pub fn insert_image(&mut self, bytes: &[u8], name: &str) -> Result<(), JsError> { todo!() }
        pub fn idle(&mut self) -> Result<bool, JsError> { todo!() }
        pub fn save(&mut self) -> Result<Vec<u8>, JsError> { todo!() }
        #[wasm_bindgen(js_name = exportPdf)]
        pub fn export_pdf(&mut self) -> Result<Vec<u8>, JsError> { todo!() }
        pub fn stats(&self) -> Stats { todo!() }
    }
}
