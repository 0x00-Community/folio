//! Counts unmodeled items at import and checks a save against the patch.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rdocx::{
    BodyItemRef, CellItemRef, ContentControlRef, Document, HyperlinkItemRef, ParagraphItemRef,
    ParagraphRef, RunItemRef, RunRef, StoryKind, TableRef,
};

use crate::wire::{self, Atom, Block, Inline, LineSpacing, Marks, ParaProps, Patch, PatchBlock};

/// Counts of unmodeled items by fingerprint.
///
/// Bookmarks are named, comment markers carry their id and kind, fields carry their instruction,
/// notes and content controls carry their id, and raw XML carries its local name and a content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ledger {
    pub counts: BTreeMap<String, usize>,
}

pub fn ledger(doc: &Document) -> Ledger {
    let mut counts = BTreeMap::new();
    for item in doc.body_items() {
        accumulate_body(&item, &mut counts);
    }
    if let Ok(stories) = doc.stories() {
        let mut parts = BTreeSet::new();
        for story in stories {
            if story.kind() == StoryKind::Body {
                continue;
            }
            if parts.insert(story.part_name().to_string()) {
                accumulate_part(doc, story.part_name(), &mut counts);
            }
        }
    }
    for part in [
        "/word/comments.xml",
        "/word/footnotes.xml",
        "/word/endnotes.xml",
    ] {
        accumulate_part(doc, part, &mut counts);
    }
    Ledger { counts }
}

pub(crate) fn run_counts(run: &RunRef<'_>) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    accumulate_run(run, &mut counts);
    counts
}

pub(crate) fn body_index_counts(doc: &Document, index: usize) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for (at, item) in doc.body_items().enumerate() {
        if at == index {
            accumulate_body(&item, &mut counts);
            break;
        }
    }
    counts
}

/// Re-imports `written` and checks the patch projection and the unmodeled-item ledger.
pub fn verify(
    written: &Document,
    patch: &wire::Patch,
    imported: &wire::Imported,
    pristine: &Ledger,
    removed: &BTreeMap<String, usize>,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<(), String> {
    let actual = ledger(written);
    let mut expected = pristine.clone();
    subtract(&mut expected, removed)?;
    if let Some(difference) = ledger_diff(&expected, &actual) {
        return Err(difference);
    }
    let again = crate::import::import(written);
    let want = project_patch(patch, imported, list_ids)?;
    let got = project_blocks(&again.imported.body);
    if let Some(difference) = projection_diff(&want, &got) {
        return Err(difference);
    }
    if let Some(difference) = sections_diff(&patch.sections, &again.imported.sections) {
        return Err(difference);
    }
    Ok(())
}

fn sections_diff(want: &[wire::Section], got: &[wire::Section]) -> Option<String> {
    if want.len() != got.len() {
        return Some(format!("section count {} vs {}", want.len(), got.len()));
    }
    for (index, (want, got)) in want.iter().zip(got).enumerate() {
        if want.src != got.src
            || want.break_type != got.break_type
            || want.title_page != got.title_page
            || want.headers != got.headers
            || want.footers != got.footers
            || !grid_same(&want.grid, &got.grid)
        {
            return Some(format!("section {index} structure differs"));
        }
        if !close_pt(want.width_pt, got.width_pt) || !close_pt(want.height_pt, got.height_pt) {
            return Some(format!(
                "section {index} size {}x{} vs {}x{}",
                want.width_pt, want.height_pt, got.width_pt, got.height_pt
            ));
        }
        for (edge, (want_edge, got_edge)) in want.margins_pt.iter().zip(got.margins_pt).enumerate()
        {
            if !close_pt(*want_edge, got_edge) {
                return Some(format!(
                    "section {index} margin {edge} {want_edge} vs {got_edge}"
                ));
            }
        }
    }
    None
}

fn grid_same(
    want: &Option<(String, f64, Option<i32>)>,
    got: &Option<(String, f64, Option<i32>)>,
) -> bool {
    match (want, got) {
        (None, None) => true,
        (Some((want_kind, want_pitch, want_space)), Some((got_kind, got_pitch, got_space))) => {
            want_kind == got_kind && close_pt(*want_pitch, *got_pitch) && want_space == got_space
        }
        _ => false,
    }
}

fn close_pt(want: f64, got: f64) -> bool {
    (want - got).abs() < 0.05
}

/// The same tolerance `table_shape_changed` uses for a grid column.
pub(crate) fn grid_pt_differs(left: f64, right: f64) -> bool {
    (left - right).abs() > 0.05
}

fn subtract(ledger: &mut Ledger, removed: &BTreeMap<String, usize>) -> Result<(), String> {
    for (key, count) in removed {
        let Some(slot) = ledger.counts.get_mut(key) else {
            return Err(format!(
                "{key} was removed but is not in the pristine ledger"
            ));
        };
        if *slot < *count {
            return Err(format!(
                "{key} removed {count} times but the pristine ledger has {slot}"
            ));
        }
        *slot -= count;
        if *slot == 0 {
            ledger.counts.remove(key);
        }
    }
    Ok(())
}

fn ledger_diff(expected: &Ledger, actual: &Ledger) -> Option<String> {
    let mut keys = BTreeSet::new();
    keys.extend(expected.counts.keys());
    keys.extend(actual.counts.keys());
    for key in keys {
        let wanted = expected.counts.get(key).copied().unwrap_or(0);
        let found = actual.counts.get(key).copied().unwrap_or(0);
        if wanted != found {
            return Some(format!("{key} expected {wanted} found {found}"));
        }
    }
    None
}

fn bump(counts: &mut BTreeMap<String, usize>, key: String) {
    *counts.entry(key).or_insert(0) += 1;
}

fn accumulate_part(doc: &Document, part: &str, counts: &mut BTreeMap<String, usize>) {
    let Ok(xml) = doc.part_xml(part) else {
        return;
    };
    scan_xml(&xml, counts);
}

fn accumulate_body(item: &BodyItemRef<'_>, counts: &mut BTreeMap<String, usize>) {
    match item {
        BodyItemRef::Paragraph(paragraph) => accumulate_paragraph(paragraph, counts),
        BodyItemRef::Table(table) => accumulate_table(table, counts),
        BodyItemRef::ContentControl(control) => accumulate_control(control, counts),
        BodyItemRef::UnsupportedXml(raw) => accumulate_raw(raw, counts),
    }
}

fn accumulate_table(table: &TableRef<'_>, counts: &mut BTreeMap<String, usize>) {
    for row_index in 0..table.row_count() {
        let Some(row) = table.row(row_index) else {
            continue;
        };
        for cell_index in 0..row.cell_count() {
            let Some(cell) = row.cell(cell_index) else {
                continue;
            };
            for child in cell.items() {
                match child {
                    CellItemRef::Paragraph(paragraph) => accumulate_paragraph(&paragraph, counts),
                    CellItemRef::Table(nested) => accumulate_table(&nested, counts),
                    CellItemRef::ContentControl(control) => accumulate_control(&control, counts),
                    CellItemRef::UnsupportedXml(raw) => accumulate_raw(raw, counts),
                    _ => {}
                }
            }
        }
    }
}

fn accumulate_paragraph(paragraph: &ParagraphRef<'_>, counts: &mut BTreeMap<String, usize>) {
    for item in paragraph.items() {
        match item {
            ParagraphItemRef::Run(run) => accumulate_run(&run, counts),
            ParagraphItemRef::Hyperlink(link) => {
                for child in link.items() {
                    match child {
                        HyperlinkItemRef::Run(run) => accumulate_run(&run, counts),
                        HyperlinkItemRef::UnsupportedXml(raw) => accumulate_raw(raw, counts),
                        _ => {}
                    }
                }
            }
            ParagraphItemRef::ContentControl(control) => accumulate_control(&control, counts),
            ParagraphItemRef::BookmarkStart { name, .. } => {
                bump(counts, format!("bookmark:{}", name.unwrap_or("")));
            }
            ParagraphItemRef::CommentRangeStart { id, .. } => {
                bump(counts, format!("comment-start:{id}"));
            }
            ParagraphItemRef::CommentRangeEnd { id, .. } => {
                bump(counts, format!("comment-end:{id}"));
            }
            ParagraphItemRef::UnsupportedXml(raw) => accumulate_raw(raw, counts),
            ParagraphItemRef::Revision(revision) => {
                if let Some(inner) = revision.insertion_paragraph() {
                    accumulate_paragraph(&inner, counts);
                }
            }
            _ => {}
        }
    }
}

fn accumulate_run(run: &RunRef<'_>, counts: &mut BTreeMap<String, usize>) {
    for item in run.items() {
        match item {
            RunItemRef::Field(field) => {
                bump(counts, format!("field:{}", squeeze(field.instruction())));
            }
            RunItemRef::FootnoteReference(id) => bump(counts, format!("footnote:{id}")),
            RunItemRef::EndnoteReference(id) => bump(counts, format!("endnote:{id}")),
            RunItemRef::CommentReference(id) => bump(counts, format!("comment-ref:{id}")),
            RunItemRef::UnsupportedXml(raw) => accumulate_raw(raw, counts),
            _ => {}
        }
    }
}

fn accumulate_control(control: &ContentControlRef<'_>, counts: &mut BTreeMap<String, usize>) {
    let id = control.id().map(|id| id.to_string()).unwrap_or_else(|| {
        control
            .tag()
            .or_else(|| control.alias())
            .unwrap_or("")
            .to_string()
    });
    bump(counts, format!("sdt:{id}"));
}

fn accumulate_raw(raw: &[u8], counts: &mut BTreeMap<String, usize>) {
    if ignorable_marker(raw) {
        return;
    }
    bump(counts, format!("xml:{}:{:016x}", local_name(raw), fnv(raw)));
}

fn ignorable_marker(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    text.contains("permStart") || text.contains("permEnd") || text.contains("proofErr")
}

fn local_name(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let Some(start) = text.find('<') else {
        return "raw".into();
    };
    let rest = text[start + 1..].trim_start_matches('/');
    let token: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/')
        .collect();
    token.rsplit(':').next().unwrap_or("raw").to_string()
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn scan_xml(xml: &str, counts: &mut BTreeMap<String, usize>) {
    for tag in tags(xml, "bookmarkStart") {
        if let Some(name) = attr(&tag, "name") {
            bump(counts, format!("bookmark:{name}"));
        }
    }
    for tag in tags(xml, "commentRangeStart") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("comment-start:{id}"));
        }
    }
    for tag in tags(xml, "commentRangeEnd") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("comment-end:{id}"));
        }
    }
    for tag in tags(xml, "commentReference") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("comment-ref:{id}"));
        }
    }
    for tag in tags(xml, "comment") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("comment-part:{id}"));
        }
    }
    for tag in tags(xml, "footnoteReference") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("footnote:{id}"));
        }
    }
    for tag in tags(xml, "endnoteReference") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("endnote:{id}"));
        }
    }
    for tag in tags(xml, "footnote") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("footnote-part:{id}"));
        }
    }
    for tag in tags(xml, "endnote") {
        if let Some(id) = attr(&tag, "id") {
            bump(counts, format!("endnote-part:{id}"));
        }
    }
    for tag in tags(xml, "fldSimple") {
        if let Some(instr) = attr(&tag, "instr") {
            bump(counts, format!("field:{}", squeeze(&instr)));
        }
    }
}

fn tags(xml: &str, local: &str) -> Vec<String> {
    let mut found = Vec::new();
    let needle = format!(":{local}");
    let mut rest = xml;
    while let Some(pos) = rest.find(&needle) {
        let after = &rest[pos + needle.len()..];
        let boundary = after
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric());
        if !boundary {
            rest = &rest[pos + needle.len()..];
            continue;
        }
        let Some(end) = after.find('>') else {
            break;
        };
        found.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    found
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!(":{name}");
    let pos = tag.find(&key)?;
    let after = tag[pos + key.len()..].trim_start();
    let after = after.strip_prefix('=')?.trim_start();
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = &after[1..];
    let end = value.find(quote)?;
    Some(value[..end].to_string())
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Text { text: String, marks: Marks },
    Atom(Atom),
}

#[derive(Debug, Clone, PartialEq)]
enum Proj {
    Para {
        props: ParaProps,
        nodes: Vec<Node>,
    },
    Table {
        grid: Vec<f64>,
        rows: Vec<ProjRow>,
    },
    Opaque {
        label: String,
        removable: bool,
        preview: Vec<Proj>,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct ProjRow {
    header: bool,
    cant_split: bool,
    cells: Vec<ProjCell>,
}

#[derive(Debug, Clone, PartialEq)]
struct ProjCell {
    span: u32,
    v_merge: Option<String>,
    blocks: Vec<Proj>,
}

fn project_patch(
    patch: &Patch,
    imported: &wire::Imported,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<Vec<Proj>, String> {
    let mut by_src = HashMap::new();
    index_blocks(&imported.body, &mut by_src);
    let mut projected = Vec::new();
    for block in &patch.body {
        let block = match block {
            PatchBlock::Keep { keep } => by_src
                .get(keep)
                .copied()
                .ok_or_else(|| format!("keep {keep} is not a pristine block"))?,
            PatchBlock::Changed(block) => block,
        };
        projected.push(project_block(block, list_ids));
    }
    Ok(projected)
}

fn index_blocks<'a>(blocks: &'a [Block], into: &mut HashMap<u32, &'a Block>) {
    for block in blocks {
        match block {
            Block::P(para) => {
                if let Some(src) = para.src {
                    into.insert(src, block);
                }
            }
            Block::Table(table) => {
                if let Some(src) = table.src {
                    into.insert(src, block);
                }
                for row in &table.rows {
                    for cell in &row.cells {
                        index_blocks(&cell.blocks, into);
                    }
                }
            }
            Block::Opaque(opaque) => {
                into.insert(opaque.src, block);
            }
        }
    }
}

fn project_blocks(blocks: &[Block]) -> Vec<Proj> {
    blocks
        .iter()
        .map(|block| project_block(block, &BTreeMap::new()))
        .collect()
}

fn project_block(block: &Block, list_ids: &BTreeMap<i32, u32>) -> Proj {
    match block {
        Block::P(para) => Proj::Para {
            props: mapped_props(&para.props, list_ids),
            nodes: project_inlines(&para.inlines),
        },
        Block::Table(table) => Proj::Table {
            grid: table.grid_pt.clone(),
            rows: table
                .rows
                .iter()
                .map(|row| ProjRow {
                    header: row.header,
                    cant_split: row.cant_split,
                    cells: row
                        .cells
                        .iter()
                        .map(|cell| ProjCell {
                            span: cell.span,
                            v_merge: cell.v_merge.clone(),
                            blocks: cell
                                .blocks
                                .iter()
                                .map(|block| project_block(block, list_ids))
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        },
        Block::Opaque(opaque) => Proj::Opaque {
            label: opaque.label.clone(),
            removable: opaque.removable,
            preview: opaque
                .preview
                .iter()
                .map(|para| Proj::Para {
                    props: ParaProps::default(),
                    nodes: project_inlines(&para.inlines),
                })
                .collect(),
        },
    }
}

fn mapped_props(props: &ParaProps, list_ids: &BTreeMap<i32, u32>) -> ParaProps {
    let mut props = props.clone();
    if let Some(Some((id, level))) = props.numbering
        && let Some(real) = list_ids.get(&id)
    {
        props.numbering = Some(Some((*real as i32, level)));
    }
    // Import does not read w:firstLineChars, so a saved value cannot come back through it.
    props.first_line_chars = None;
    props
}

fn project_inlines(inlines: &[Inline]) -> Vec<Node> {
    let mut nodes = Vec::new();
    for inline in inlines {
        if is_marker(inline) {
            continue;
        }
        match inline {
            Inline::Text { text, marks, .. } => push_text(&mut nodes, text, marks),
            Inline::Atom { atom, .. } => nodes.push(Node::Atom(atom.clone())),
        }
    }
    nodes
}

fn is_marker(inline: &Inline) -> bool {
    matches!(
        inline,
        Inline::Atom {
            atom: Atom::Opaque { label, .. },
            src: None,
        } if label == "bookmark" || label == "comment"
    )
}

fn push_text(nodes: &mut Vec<Node>, text: &str, marks: &Marks) {
    if text.is_empty() {
        return;
    }
    if let Some(Node::Text {
        text: have,
        marks: have_marks,
    }) = nodes.last_mut()
        && have_marks == marks
    {
        have.push_str(text);
        return;
    }
    nodes.push(Node::Text {
        text: text.to_string(),
        marks: marks.clone(),
    });
}

fn projection_diff(want: &[Proj], got: &[Proj]) -> Option<String> {
    if want.len() != got.len() {
        return Some(format!(
            "body block count expected {} found {}",
            want.len(),
            got.len()
        ));
    }
    for (index, (want, got)) in want.iter().zip(got.iter()).enumerate() {
        if let Some(difference) = proj_diff(want, got, &format!("body[{index}]")) {
            return Some(difference);
        }
    }
    None
}

fn proj_diff(want: &Proj, got: &Proj, path: &str) -> Option<String> {
    match (want, got) {
        (
            Proj::Para {
                props: want_props,
                nodes: want_nodes,
            },
            Proj::Para {
                props: got_props,
                nodes: got_nodes,
            },
        ) => {
            if let Some(difference) = props_diff(want_props, got_props) {
                return Some(format!("{path} {difference}"));
            }
            nodes_diff(want_nodes, got_nodes, path)
        }
        (
            Proj::Table {
                grid: want_grid,
                rows: want_rows,
            },
            Proj::Table {
                grid: got_grid,
                rows: got_rows,
            },
        ) => {
            if want_grid.len() != got_grid.len()
                || want_grid
                    .iter()
                    .zip(got_grid.iter())
                    .any(|(left, right)| grid_pt_differs(*left, *right))
            {
                return Some(format!("{path} grid {want_grid:?} vs {got_grid:?}"));
            }
            if want_rows.len() != got_rows.len() {
                return Some(format!(
                    "{path} row count expected {} found {}",
                    want_rows.len(),
                    got_rows.len()
                ));
            }
            for (index, (want_row, got_row)) in want_rows.iter().zip(got_rows.iter()).enumerate() {
                if want_row.header != got_row.header || want_row.cant_split != got_row.cant_split {
                    return Some(format!("{path} row {index} properties differ"));
                }
                if want_row.cells.len() != got_row.cells.len() {
                    return Some(format!(
                        "{path} row {index} cell count expected {} found {}",
                        want_row.cells.len(),
                        got_row.cells.len()
                    ));
                }
                for (cell_index, (want_cell, got_cell)) in
                    want_row.cells.iter().zip(got_row.cells.iter()).enumerate()
                {
                    if want_cell.span != got_cell.span || want_cell.v_merge != got_cell.v_merge {
                        return Some(format!(
                            "{path} row {index} cell {cell_index} shape differs"
                        ));
                    }
                    if let Some(difference) = projection_diff(&want_cell.blocks, &got_cell.blocks) {
                        return Some(format!("{path} row {index} cell {cell_index} {difference}"));
                    }
                }
            }
            None
        }
        (
            Proj::Opaque {
                label: want_label,
                removable: want_removable,
                preview: want_preview,
            },
            Proj::Opaque {
                label: got_label,
                removable: got_removable,
                preview: got_preview,
            },
        ) => {
            if want_label != got_label || want_removable != got_removable {
                return Some(format!(
                    "{path} opaque {want_label}/{want_removable} vs {got_label}/{got_removable}"
                ));
            }
            projection_diff(want_preview, got_preview)
        }
        _ => Some(format!("{path} block kind differs")),
    }
}

fn nodes_diff(want: &[Node], got: &[Node], path: &str) -> Option<String> {
    if want.len() != got.len() {
        return Some(format!(
            "{path} inline count expected {} found {} ({want:?} vs {got:?})",
            want.len(),
            got.len()
        ));
    }
    for (index, (want, got)) in want.iter().zip(got.iter()).enumerate() {
        if want != got {
            return Some(format!(
                "{path} inline {index} expected {want:?} found {got:?}"
            ));
        }
    }
    None
}

fn props_diff(want: &ParaProps, got: &ParaProps) -> Option<String> {
    if want.style != got.style {
        return Some(format!("style {:?} vs {:?}", want.style, got.style));
    }
    if want.align != got.align {
        return Some(format!("align {:?} vs {:?}", want.align, got.align));
    }
    if !same_pt(want.indent_left, got.indent_left)
        || !same_pt(want.indent_right, got.indent_right)
        || !same_pt(want.first_line, got.first_line)
        || !same_pt(want.hanging, got.hanging)
    {
        return Some(format!(
            "indent {:?} {:?} {:?} {:?} vs {:?} {:?} {:?} {:?}",
            want.indent_left,
            want.indent_right,
            want.first_line,
            want.hanging,
            got.indent_left,
            got.indent_right,
            got.first_line,
            got.hanging
        ));
    }
    if !same_pt(want.space_before, got.space_before) || !same_pt(want.space_after, got.space_after)
    {
        return Some("spacing differs".into());
    }
    if !same_line(&want.line, &got.line) {
        return Some(format!("line {:?} vs {:?}", want.line, got.line));
    }
    if want.numbering != got.numbering {
        return Some(format!(
            "numbering {:?} vs {:?}",
            want.numbering, got.numbering
        ));
    }
    if want.keep_next != got.keep_next
        || want.keep_lines != got.keep_lines
        || want.page_break_before != got.page_break_before
        || want.widow_control != got.widow_control
    {
        return Some("paragraph toggles differ".into());
    }
    None
}

fn same_pt(want: Option<f64>, got: Option<f64>) -> bool {
    match (want, got) {
        (None, None) => true,
        (Some(want), Some(got)) => (want - got).abs() < 0.05,
        _ => false,
    }
}

/// Body content indexes of direct paragraphs. The split/join property check walks these.
pub fn body_paragraph_indexes(doc: &Document) -> Vec<usize> {
    doc.body_items()
        .enumerate()
        .filter_map(|(index, item)| match item {
            BodyItemRef::Paragraph(_) => Some(index),
            _ => None,
        })
        .collect()
}

fn same_line(want: &Option<LineSpacing>, got: &Option<LineSpacing>) -> bool {
    match (want, got) {
        (None, None) => true,
        (Some(LineSpacing::Auto { multiple: want }), Some(LineSpacing::Auto { multiple: got })) => {
            (want - got).abs() < 0.01
        }
        (Some(LineSpacing::Exact { pt: want }), Some(LineSpacing::Exact { pt: got }))
        | (Some(LineSpacing::AtLeast { pt: want }), Some(LineSpacing::AtLeast { pt: got })) => {
            (want - got).abs() < 0.05
        }
        _ => false,
    }
}
