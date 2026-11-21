//! JSON shapes shared with `src/engine/wire.ts`. Field names are camelCase in JSON.

use serde::{Deserialize, Serialize};

pub type ParaSrc = u32;
pub type RunSrc = u32;
pub type BlockSrc = u32;
pub type RowSrc = u32;
pub type CellSrc = u32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BlockKind {
    #[serde(rename = "p")]
    P,
    #[serde(rename = "table")]
    Table,
    #[serde(rename = "opaque")]
    Opaque,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub body: Vec<Block>,
    pub sections: Vec<Section>,
    pub stories: Vec<(String, Vec<Block>)>,
    pub styles: StyleSheet,
    pub lists: Vec<(i32, ListDef)>,
    pub media: Vec<(String, String)>,
    pub fonts: Vec<String>,
    /// Resolved run looks for paragraph-style / character-style pairs in use.
    /// An absent character style is JSON null.
    pub run_looks: Vec<RunLookEntry>,
    pub para_looks: Vec<ParaLookEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunLookEntry {
    pub para: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    pub look: RunLook,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParaLookEntry {
    pub style: String,
    pub look: ParaLook,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Block {
    P(Para),
    Table(Table),
    Opaque(Opaque),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Para {
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<ParaSrc>,
    #[serde(default)]
    pub props: ParaProps,
    pub inlines: Vec<Inline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_end: Option<u32>,
}

impl Para {
    pub fn new(
        src: Option<ParaSrc>,
        props: ParaProps,
        inlines: Vec<Inline>,
        lock: Option<String>,
        section_end: Option<u32>,
    ) -> Self {
        Self {
            kind: BlockKind::P,
            src,
            props,
            inlines,
            lock,
            section_end,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Inline {
    Text {
        text: String,
        #[serde(default)]
        marks: Marks,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        src: Option<RunSrc>,
    },
    Atom {
        atom: Atom,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        src: Option<RunSrc>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Atom {
    Image {
        media: String,
        width_pt: f64,
        height_pt: f64,
    },
    Field {
        field: String,
        display: String,
    },
    PageBreak {},
    ColumnBreak {},
    Opaque {
        label: String,
        display: String,
        removable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Marks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_east_asia: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vert_align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ParaProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_line: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hanging: Option<f64>,
    /// Hundredths of a character. Omitted: the facade has no getter for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_line_chars: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<LineSpacing>,
    /// `Some(None)` is numId 0, explicit "no list".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numbering: Option<Option<(i32, u32)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_lines: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "rule",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LineSpacing {
    Auto { multiple: f64 },
    Exact { pt: f64 },
    AtLeast { pt: f64 },
}

/// A line, or `None` when the file says the edge has no line (`nil` or `none`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BorderEdge {
    pub style: BorderStyleName,
    pub width_pt: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BorderStyleName {
    Single,
    Double,
    Dashed,
    Dotted,
}

/// All six edges. A null edge is one the chosen border set does not draw.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableBorders {
    #[serde(default)]
    pub top: Option<BorderEdge>,
    #[serde(default)]
    pub left: Option<BorderEdge>,
    #[serde(default)]
    pub bottom: Option<BorderEdge>,
    #[serde(default)]
    pub right: Option<BorderEdge>,
    #[serde(default)]
    pub inside_h: Option<BorderEdge>,
    #[serde(default)]
    pub inside_v: Option<BorderEdge>,
}

/// `None` omits the key (the file does not mention the edge). `Some(None)` is
/// JSON null: the file says that edge has no line.
///
/// Serde reads a JSON null as the outer `None`, so the field module puts the
/// null back into the inner `None` when the key is present.
pub type SpecifiedEdge = Option<Option<BorderEdge>>;

mod specified_edge {
    use super::{BorderEdge, SpecifiedEdge};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        value: &SpecifiedEdge,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(Some(edge)) => edge.serialize(serializer),
            _ => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<SpecifiedEdge, D::Error> {
        Ok(Some(Option::<BorderEdge>::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CellBorders {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "specified_edge"
    )]
    pub top: SpecifiedEdge,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "specified_edge"
    )]
    pub left: SpecifiedEdge,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "specified_edge"
    )]
    pub bottom: SpecifiedEdge,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "specified_edge"
    )]
    pub right: SpecifiedEdge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<BlockSrc>,
    pub grid_pt: Vec<f64>,
    pub rows: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub borders: Option<TableBorders>,
}

impl Table {
    pub fn new(src: Option<BlockSrc>, grid_pt: Vec<f64>, rows: Vec<Row>) -> Self {
        Self {
            kind: BlockKind::Table,
            src,
            grid_pt,
            rows,
            borders: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<RowSrc>,
    pub header: bool,
    pub cant_split: bool,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<CellSrc>,
    pub span: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v_merge: Option<String>,
    pub blocks: Vec<Block>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub borders: Option<CellBorders>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Opaque {
    pub kind: BlockKind,
    pub src: BlockSrc,
    pub label: String,
    pub preview: Vec<Para>,
    pub removable: bool,
}

impl Opaque {
    pub fn new(src: BlockSrc, label: String, preview: Vec<Para>, removable: bool) -> Self {
        Self {
            kind: BlockKind::Opaque,
            src,
            label,
            preview,
            removable,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<u32>,
    pub width_pt: f64,
    pub height_pt: f64,
    pub margins_pt: [f64; 7],
    pub break_type: String,
    pub title_page: bool,
    pub headers: Vec<(String, String)>,
    pub footers: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<(String, f64, Option<i32>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyleSheet {
    pub paragraph: Vec<ParaStyle>,
    pub character: Vec<(String, String)>,
    pub default_paragraph: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParaStyle {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListDef {
    pub fresh: bool,
    pub levels: Vec<ListLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListLevel {
    pub format: String,
    pub text: String,
    pub start: u32,
    pub indent_left_pt: f64,
    pub hanging_pt: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunFonts {
    pub ascii: String,
    pub h_ansi: String,
    pub east_asia: String,
    pub cs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunLook {
    pub fonts: RunFonts,
    pub size_pt: f64,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    pub caps: bool,
    pub char_spacing_pt: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParaIndent {
    pub left: f64,
    pub right: f64,
    pub first_line: f64,
    pub hanging: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_chars: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParaSpacing {
    pub before: f64,
    pub after: f64,
    pub line: LineSpacing,
    pub contextual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParaLook {
    pub align: String,
    pub indent: ParaIndent,
    pub spacing: ParaSpacing,
    pub numbering: Option<(i32, u32)>,
    pub keep_next: bool,
    pub keep_lines: bool,
    pub page_break_before: bool,
    pub widow_control: bool,
}

/// Bytes for one image key. `write` embeds each key once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPart {
    pub key: String,
    pub file_name: String,
    pub base64: String,
}

/// What the editor sends to save: the final document, with untouched blocks named by source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub body: Vec<PatchBlock>,
    pub sections: Vec<Section>,
    /// Lists created this session, keyed by their negative numId.
    #[serde(default)]
    pub new_lists: Vec<(i32, ListDef)>,
    /// Built-in roles applied but missing from the pristine styles.
    #[serde(default)]
    pub added_styles: Vec<String>,
    /// Image bytes for atoms with `src: null`. One entry per distinct key.
    #[serde(default)]
    pub media: Vec<MediaPart>,
}

/// A body block in a patch. `Keep` is the block import produced; `Changed` is the full block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)]
pub enum PatchBlock {
    Keep { keep: BlockSrc },
    Changed(Block),
}

/// Save failure. `Open` is produced by `Session::open`; save returns `Write` or `Verify`.
///
/// A print layout whose patch `write` refuses returns `Write` with the same detail.
/// Font, layout, and render failures are `crate::print::PrintError`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeError {
    Open { reason: String, detail: String },
    Write { detail: String },
    Verify { first_difference: String },
}
