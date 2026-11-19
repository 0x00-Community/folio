//! Walk a pristine document into the wire model. The document is only read.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rdocx::{
    Alignment, BodyItemRef, BreakKind, CellItemRef, Document, HdrFtrType, HeaderFooterKind,
    HyperlinkItemRef, Length, NumberingFormat, ParagraphItemRef, ParagraphRef, RevisionKind,
    RunFontSlot, RunItemRef, RunRef, ST_DocGrid, SectionRef, StoryId, StoryItemKind, StoryKind,
    StyleType, VMerge,
};

use crate::wire::{
    self, Atom, Block, Inline, LineSpacing, ListDef, ListLevel, Marks, Para, ParaIndent, ParaLook,
    ParaProps, ParaSpacing, ParaStyle, RunFonts, RunLook, StyleSheet,
};

/// Where a minted paragraph src points. Read by a future write pass.
#[derive(Debug)]
#[allow(dead_code)]
pub struct SourceMap {
    pub paras: Vec<Option<ParaOrigin>>,
    pub runs: Vec<RunOrigin>,
    pub blocks: Vec<BlockOrigin>,
    pub rows: Vec<RowOrigin>,
    pub cells: Vec<CellOrigin>,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct ParaOrigin {
    pub addr: ParaAddr,
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum ParaAddr {
    Body {
        content_index: usize,
    },
    Cell {
        table_content_index: usize,
        row: usize,
        cell: usize,
        paragraph: usize,
    },
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct RunOrigin {
    pub para: wire::ParaSrc,
    pub run_index: usize,
    pub mixed: bool,
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum BlockOrigin {
    Paragraph(wire::ParaSrc),
    Table { content_index: usize },
    Opaque { content_index: usize },
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct RowOrigin {
    pub table: wire::BlockSrc,
    pub row: usize,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct CellOrigin {
    pub table: wire::BlockSrc,
    pub row: usize,
    pub cell: usize,
}

pub struct Import {
    pub imported: wire::Imported,
    pub sources: SourceMap,
    pub media_bytes: BTreeMap<String, (String, Vec<u8>)>,
    /// Unmodeled items of this document, counted once for save verification.
    pub ledger: crate::verify::Ledger,
}

struct Ctx {
    sources: SourceMap,
    pairs: BTreeSet<(String, String)>,
    nums: BTreeSet<u32>,
    fonts: BTreeSet<String>,
    media: BTreeMap<String, (String, Vec<u8>)>,
    default_style: String,
    run_counter: usize,
}

pub fn import(doc: &Document) -> Import {
    let read = read_stories(doc);
    let styles = stylesheet(doc);
    let mut ctx = Ctx {
        sources: SourceMap {
            paras: Vec::new(),
            runs: Vec::new(),
            blocks: Vec::new(),
            rows: Vec::new(),
            cells: Vec::new(),
        },
        pairs: BTreeSet::new(),
        nums: BTreeSet::new(),
        fonts: BTreeSet::new(),
        media: BTreeMap::new(),
        default_style: styles.default_paragraph.clone(),
        run_counter: 0,
    };
    for style in &styles.paragraph {
        ctx.pairs.insert((style.id.clone(), String::new()));
    }
    let body = walk_body(doc, &mut ctx);
    // A relationship id shared with a header keeps the main-part image.
    for (key, value) in read.media {
        ctx.media.entry(key).or_insert(value);
    }
    let (sections, stories) = sections_and_stories(
        doc,
        &read.paragraphs,
        &read.header_stories,
        &read.footer_stories,
    );
    let para_looks = para_looks(doc, &styles, &mut ctx);
    let run_looks = run_looks(doc, &ctx);
    for entry in &run_looks {
        for font in [
            &entry.look.fonts.ascii,
            &entry.look.fonts.h_ansi,
            &entry.look.fonts.east_asia,
            &entry.look.fonts.cs,
        ] {
            if !font.is_empty() {
                ctx.fonts.insert(font.clone());
            }
        }
    }
    let lists = lists(doc, &ctx.nums);
    let media = ctx
        .media
        .iter()
        .map(|(key, (content_type, _))| (key.clone(), content_type.clone()))
        .collect();
    let media_bytes = ctx.media;
    let fonts = ctx.fonts.into_iter().collect();
    let ledger = crate::verify::ledger(doc);
    Import {
        imported: wire::Imported {
            body,
            sections,
            stories,
            styles,
            lists,
            media,
            fonts,
            run_looks,
            para_looks,
        },
        sources: ctx.sources,
        media_bytes,
        ledger,
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct StoryKey {
    kind: StoryKind,
    part: String,
    owner: usize,
}

impl StoryKey {
    fn from_story(story: &StoryId) -> Self {
        Self {
            kind: story.kind(),
            part: story.part_name().to_string(),
            owner: story.owner_index(),
        }
    }
}

struct StoryWalk {
    paragraphs: HashMap<StoryKey, Vec<String>>,
    header_stories: Vec<StoryKey>,
    footer_stories: Vec<StoryKey>,
    media: BTreeMap<String, (String, Vec<u8>)>,
}

fn read_stories(doc: &Document) -> StoryWalk {
    // `story_items` serializes the main document on every call, so header and
    // footer paragraphs are taken from one inventory.
    let mut walk = StoryWalk {
        paragraphs: HashMap::new(),
        header_stories: Vec::new(),
        footer_stories: Vec::new(),
        media: BTreeMap::new(),
    };
    let Ok(paragraphs) = doc.story_range_paragraphs() else {
        return walk;
    };
    let mut seen = HashSet::new();
    for (location, xml) in &paragraphs {
        let story = location.story();
        if story.kind() != StoryKind::Body {
            remember_story_media(doc, story, xml, &mut walk.media);
        }
        if !matches!(story.kind(), StoryKind::Header | StoryKind::Footer)
            || location.index_path().len() != 1
        {
            continue;
        }
        let key = StoryKey::from_story(story);
        if seen.insert(key.clone()) {
            if key.kind == StoryKind::Header {
                walk.header_stories.push(key.clone());
            } else if key.kind == StoryKind::Footer {
                walk.footer_stories.push(key.clone());
            }
        }
        walk.paragraphs
            .entry(key)
            .or_default()
            .push(paragraph_text(xml));
    }
    walk
}

fn remember_story_media(
    doc: &Document,
    story: &StoryId,
    xml: &[u8],
    media: &mut BTreeMap<String, (String, Vec<u8>)>,
) {
    for rel in attribute_values(xml, b"embed")
        .into_iter()
        .chain(attribute_values(xml, b"link"))
    {
        if media.contains_key(&rel) {
            continue;
        }
        let Ok(bytes) = doc.image_data_for_story(story, &rel) else {
            continue;
        };
        media.insert(rel, (sniff(&bytes).to_string(), bytes));
    }
}

fn attribute_values(xml: &[u8], local_name: &[u8]) -> Vec<String> {
    let mut values = Vec::new();
    let mut start = 0;
    while let Some(offset) = xml[start..]
        .windows(local_name.len())
        .position(|window| window == local_name)
    {
        let index = start + offset;
        let preceded = index == 0 || matches!(xml[index - 1], b':' | b' ' | b'\t' | b'\n' | b'\r');
        let after = index + local_name.len();
        if preceded && xml.get(after) == Some(&b'=') {
            let quote = *xml.get(after + 1).unwrap_or(&0);
            if quote == b'"' || quote == b'\'' {
                let value_start = after + 2;
                if let Some(end) = xml[value_start..].iter().position(|byte| *byte == quote) {
                    let value = &xml[value_start..value_start + end];
                    if !value.is_empty()
                        && let Ok(value) = String::from_utf8(value.to_vec())
                    {
                        values.push(value);
                    }
                }
            }
        }
        start = index + local_name.len();
    }
    values
}

const WORD_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

#[derive(Clone, Copy)]
enum FieldMark {
    Begin,
    Separate,
    End,
}

struct FieldTrack {
    open: Vec<(usize, bool)>,
    closed: Vec<bool>,
}

impl FieldTrack {
    fn mark(&mut self, mark: FieldMark) {
        match mark {
            FieldMark::Begin => {
                self.open.push((self.closed.len(), false));
                self.closed.push(false);
            }
            FieldMark::Separate => {
                if let Some((_, separated)) = self.open.last_mut() {
                    *separated = true;
                }
            }
            FieldMark::End => {
                if let Some((field, _)) = self.open.pop()
                    && let Some(closed) = self.closed.get_mut(field)
                {
                    *closed = true;
                }
            }
        }
    }

    fn context(&self) -> Vec<(usize, bool)> {
        self.open.clone()
    }

    fn hides(&self, context: &[(usize, bool)]) -> bool {
        context.iter().any(|(field, separated)| {
            self.closed.get(*field).copied().unwrap_or(false) && !separated
        })
    }

    fn in_result(&self, context: &[(usize, bool)]) -> bool {
        context
            .iter()
            .any(|(field, _)| self.closed.get(*field).copied().unwrap_or(false))
    }
}

enum Piece {
    Text(String),
    Tab,
    Break(u8),
}

struct TextRecord {
    context: Vec<(usize, bool)>,
    piece: Piece,
}

struct TextFrame {
    local: String,
    word: bool,
    opaque: bool,
    hides: bool,
    nested: bool,
    opened_text: bool,
}

struct Tag {
    end: bool,
    empty: bool,
    prefix: String,
    local: String,
    decls: Vec<(String, String)>,
    fld: Option<FieldMark>,
    break_form: u8,
}

fn paragraph_text(xml: &[u8]) -> String {
    let mut scopes: Vec<Vec<(String, String)>> = Vec::new();
    let mut frames: Vec<TextFrame> = Vec::new();
    let mut fields = FieldTrack {
        open: Vec::new(),
        closed: Vec::new(),
    };
    let mut records: Vec<TextRecord> = Vec::new();
    let mut text_open: Vec<usize> = Vec::new();
    let mut index = 0;
    while index < xml.len() {
        if xml[index] != b'<' {
            let end = xml[index..]
                .iter()
                .position(|byte| *byte == b'<')
                .map(|offset| index + offset)
                .unwrap_or(xml.len());
            if let Some(&slot) = text_open.last()
                && let Piece::Text(text) = &mut records[slot].piece
            {
                text.push_str(&xml_unescape(&xml[index..end]));
            }
            index = end;
            continue;
        }
        if xml[index..].starts_with(b"<!--") {
            index = xml[index..]
                .windows(3)
                .position(|window| window == b"-->")
                .map(|offset| index + offset + 3)
                .unwrap_or(xml.len());
            continue;
        }
        if xml[index..].starts_with(b"<![CDATA[") {
            let start = index + 9;
            let end = xml[start..]
                .windows(3)
                .position(|window| window == b"]]>")
                .map(|offset| start + offset)
                .unwrap_or(xml.len());
            if let Some(&slot) = text_open.last()
                && let Piece::Text(text) = &mut records[slot].piece
                && let Ok(raw) = std::str::from_utf8(&xml[start..end])
            {
                text.push_str(raw);
            }
            index = (end + 3).min(xml.len());
            continue;
        }
        if xml[index..].starts_with(b"<?") {
            index = xml[index..]
                .windows(2)
                .position(|window| window == b"?>")
                .map(|offset| index + offset + 2)
                .unwrap_or(xml.len());
            continue;
        }
        if xml[index..].starts_with(b"<! ") || xml[index..].starts_with(b"<!") {
            index = xml[index..]
                .iter()
                .position(|byte| *byte == b'>')
                .map(|offset| index + offset + 1)
                .unwrap_or(xml.len());
            continue;
        }
        let Some(end) = tag_end(xml, index) else {
            break;
        };
        let tag = parse_tag(&xml[index + 1..end]);
        index = end + 1;
        if tag.end {
            if let Some(frame) = frames.pop()
                && frame.opened_text
            {
                text_open.pop();
            }
            scopes.pop();
            continue;
        }
        scopes.push(tag.decls.clone());
        let ancestors_opaque = frames.last().is_some_and(|frame| frame.opaque);
        let ancestors_hidden = frames.iter().any(|frame| frame.hides);
        let ancestors_nested = frames.iter().any(|frame| frame.nested);
        let word = namespace_is(&scopes, &tag.prefix, WORD_NS);
        let modeled =
            word && word_child_modeled(frames.last().map(|frame| frame.local.as_str()), &tag.local);
        let fallback =
            tag.local == "Fallback" && frames.iter().any(|frame| frame.local == "AlternateContent");
        let opaque = ancestors_opaque || !modeled || fallback;
        let visible = !opaque && !ancestors_hidden && !ancestors_nested;
        let parent_run = frames
            .last()
            .is_some_and(|frame| frame.word && frame.local == "r");
        if visible
            && tag.local == "fldChar"
            && let Some(mark) = tag.fld
        {
            fields.mark(mark);
        }
        let opened_text = visible && tag.local == "t";
        if opened_text {
            records.push(TextRecord {
                context: fields.context(),
                piece: Piece::Text(String::new()),
            });
            text_open.push(records.len() - 1);
        } else if visible && parent_run && tag.local == "tab" {
            records.push(TextRecord {
                context: fields.context(),
                piece: Piece::Tab,
            });
        } else if visible && parent_run && (tag.local == "br" || tag.local == "cr") {
            let form = if tag.local == "cr" { 3 } else { tag.break_form };
            records.push(TextRecord {
                context: fields.context(),
                piece: Piece::Break(form),
            });
        }
        if tag.empty {
            if opened_text {
                text_open.pop();
            }
            scopes.pop();
            continue;
        }
        let nested =
            !opaque && !frames.is_empty() && (tag.local == "tc" || tag.local == "txbxContent");
        let hides = !opaque && (tag.local == "del" || tag.local == "moveFrom");
        frames.push(TextFrame {
            local: tag.local,
            word,
            opaque,
            hides,
            nested,
            opened_text,
        });
    }
    let mut text = String::new();
    for record in records {
        if fields.hides(&record.context) {
            continue;
        }
        match record.piece {
            Piece::Text(value) => text.push_str(&value),
            Piece::Tab => text.push('\t'),
            Piece::Break(3) => text.push('\n'),
            Piece::Break(form) => {
                let character = if fields.in_result(&record.context) {
                    match form {
                        1 => '\u{000c}',
                        2 => '\u{000b}',
                        _ => '\n',
                    }
                } else {
                    '\n'
                };
                text.push(character);
            }
        }
    }
    text
}

fn namespace_is(scopes: &[Vec<(String, String)>], prefix: &str, uri: &str) -> bool {
    for scope in scopes.iter().rev() {
        for (key, value) in scope.iter().rev() {
            if key == prefix {
                return value == uri;
            }
        }
    }
    prefix == "w" && uri == WORD_NS
}

fn word_child_modeled(parent: Option<&str>, child: &str) -> bool {
    let Some(parent) = parent else {
        return true;
    };
    match parent {
        "sdtContent" => matches!(child, "r" | "ins" | "del" | "moveFrom" | "moveTo" | "sdt"),
        "p" => matches!(
            child,
            "pPr"
                | "r"
                | "sdt"
                | "hyperlink"
                | "fldSimple"
                | "ins"
                | "del"
                | "moveFrom"
                | "moveTo"
                | "bookmarkStart"
                | "bookmarkEnd"
                | "commentRangeStart"
                | "commentRangeEnd"
                | "proofErr"
        ),
        "r" => matches!(
            child,
            "rPr"
                | "t"
                | "delText"
                | "instrText"
                | "delInstrText"
                | "fldChar"
                | "drawing"
                | "pict"
                | "object"
                | "tab"
                | "br"
                | "cr"
                | "sym"
                | "noBreakHyphen"
                | "softHyphen"
                | "footnoteReference"
                | "endnoteReference"
                | "commentReference"
                | "lastRenderedPageBreak"
        ),
        "hyperlink" => matches!(child, "r" | "ins" | "del" | "moveFrom" | "moveTo"),
        "ins" | "del" | "moveFrom" | "moveTo" => matches!(
            child,
            "r" | "sdt" | "hyperlink" | "ins" | "del" | "moveFrom" | "moveTo"
        ),
        "fldSimple" => child == "r",
        "sdt" => matches!(child, "sdtPr" | "sdtEndPr" | "sdtContent"),
        _ => false,
    }
}

fn tag_end(xml: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    let mut quote = 0u8;
    while index < xml.len() {
        let byte = xml[index];
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'>' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn parse_tag(inner: &[u8]) -> Tag {
    let mut index = 0;
    let mut end = false;
    if inner.first() == Some(&b'/') {
        end = true;
        index = 1;
    }
    while inner.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    let name_start = index;
    while inner
        .get(index)
        .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'/')
    {
        index += 1;
    }
    let name = String::from_utf8_lossy(&inner[name_start..index]).into_owned();
    let (prefix, local) = match name.split_once(':') {
        Some((prefix, local)) => (prefix.to_string(), local.to_string()),
        None => (String::new(), name),
    };
    let mut decls = Vec::new();
    let mut fld = None;
    let mut break_form = 0u8;
    let mut empty = false;
    while index < inner.len() {
        while inner.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if index >= inner.len() {
            break;
        }
        if inner[index] == b'/' {
            empty = true;
            index += 1;
            continue;
        }
        let attr_start = index;
        while inner
            .get(index)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'=' && *byte != b'/')
        {
            index += 1;
        }
        let attr_name = String::from_utf8_lossy(&inner[attr_start..index]).into_owned();
        while inner.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if inner.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while inner.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        let Some(quote) = inner.get(index).copied() else {
            break;
        };
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        index += 1;
        let value_start = index;
        while inner.get(index).is_some_and(|byte| *byte != quote) {
            index += 1;
        }
        let value = xml_unescape(&inner[value_start..index]);
        if inner.get(index) == Some(&quote) {
            index += 1;
        }
        if let Some(declared) = attr_name.strip_prefix("xmlns:") {
            decls.push((declared.to_string(), value));
        } else if attr_name == "xmlns" {
            decls.push((String::new(), value));
        } else {
            let attr_local = attr_name
                .split_once(':')
                .map(|(_, local)| local)
                .unwrap_or(attr_name.as_str());
            if attr_local == "fldCharType" {
                fld = match value.as_str() {
                    "begin" => Some(FieldMark::Begin),
                    "separate" => Some(FieldMark::Separate),
                    "end" => Some(FieldMark::End),
                    _ => None,
                };
            } else if attr_local == "type" {
                break_form = match value.as_str() {
                    "page" => 1,
                    "column" => 2,
                    _ => 0,
                };
            }
        }
    }
    Tag {
        end,
        empty,
        prefix,
        local,
        decls,
        fld,
        break_form,
    }
}

fn xml_unescape(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut rest: &str = &text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start + 1..];
        let Some(end) = rest.find(';') else {
            out.push('&');
            out.push_str(rest);
            return out;
        };
        let entity = &rest[..end];
        rest = &rest[end + 1..];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ => {
                if let Some(character) = char_entity(entity) {
                    out.push(character);
                } else {
                    out.push('&');
                    out.push_str(entity);
                    out.push(';');
                }
            }
        }
    }
    out.push_str(rest);
    out
}

fn char_entity(entity: &str) -> Option<char> {
    let code = if let Some(hex) = entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        entity.strip_prefix('#')?.parse().ok()?
    };
    char::from_u32(code)
}

fn stylesheet(doc: &Document) -> StyleSheet {
    let mut paragraph = Vec::new();
    let mut character = Vec::new();
    let mut default_paragraph = None;
    for style in doc.styles() {
        match style.style_type() {
            StyleType::Paragraph => {
                if style.is_default() && default_paragraph.is_none() {
                    default_paragraph = Some(style.style_id().to_string());
                }
                let name = style.name().unwrap_or(style.style_id()).to_string();
                paragraph.push(ParaStyle {
                    id: style.style_id().to_string(),
                    name: name.clone(),
                    role: role_of(&name).map(str::to_string),
                    next: style.next_style().map(str::to_string),
                });
            }
            StyleType::Character => character.push((
                style.style_id().to_string(),
                style.name().unwrap_or(style.style_id()).to_string(),
            )),
            _ => {}
        }
    }
    StyleSheet {
        paragraph,
        character,
        default_paragraph: default_paragraph.unwrap_or_else(|| "Normal".into()),
    }
}

fn role_of(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "normal" => Some("normal"),
        "title" => Some("title"),
        "heading 1" => Some("heading1"),
        "heading 2" => Some("heading2"),
        "heading 3" => Some("heading3"),
        _ => None,
    }
}

fn walk_body(doc: &Document, ctx: &mut Ctx) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut next_section = 0u32;
    for (content_index, item) in doc.body_items().enumerate() {
        match item {
            BodyItemRef::Paragraph(paragraph) => {
                let section_end = if paragraph.has_section_break() {
                    let ordinal = next_section;
                    next_section += 1;
                    Some(ordinal)
                } else {
                    None
                };
                blocks.push(Block::P(import_paragraph(
                    doc,
                    ctx,
                    &paragraph,
                    ParaAddr::Body { content_index },
                    section_end,
                )));
            }
            BodyItemRef::Table(table) => {
                blocks.push(import_table(doc, ctx, &table, content_index));
            }
            BodyItemRef::ContentControl(control) => {
                let label = control
                    .alias()
                    .or(control.tag())
                    .unwrap_or("contentControl")
                    .to_string();
                blocks.push(Block::Opaque(opaque_block(
                    ctx,
                    content_index,
                    label,
                    &control.text(),
                    true,
                )));
            }
            BodyItemRef::UnsupportedXml(raw) => {
                let text = xml_text(raw);
                let removable = !mentions_comment(raw);
                blocks.push(Block::Opaque(opaque_block(
                    ctx,
                    content_index,
                    "xml".into(),
                    &text,
                    removable,
                )));
            }
        }
    }
    blocks
}

fn import_table(
    doc: &Document,
    ctx: &mut Ctx,
    table: &rdocx::TableRef<'_>,
    content_index: usize,
) -> Block {
    let src = alloc_block(ctx, BlockOrigin::Table { content_index }, None);
    let grid_pt = table
        .grid_widths()
        .iter()
        .copied()
        .map(Length::to_pt)
        .collect();
    let mut rows = Vec::new();
    for row_index in 0..table.row_count() {
        let Some(row) = table.row(row_index) else {
            continue;
        };
        let row_src = alloc_row(ctx, src, row_index);
        let mut cells = Vec::new();
        for cell_index in 0..row.cell_count() {
            let Some(cell) = row.cell(cell_index) else {
                continue;
            };
            let cell_src = alloc_cell(ctx, src, row_index, cell_index);
            let mut cell_blocks = Vec::new();
            let mut paragraph_index = 0;
            for item in cell.items() {
                match item {
                    CellItemRef::Paragraph(paragraph) => {
                        cell_blocks.push(Block::P(import_paragraph(
                            doc,
                            ctx,
                            &paragraph,
                            ParaAddr::Cell {
                                table_content_index: content_index,
                                row: row_index,
                                cell: cell_index,
                                paragraph: paragraph_index,
                            },
                            None,
                        )));
                        paragraph_index += 1;
                    }
                    CellItemRef::Table(nested) => {
                        cell_blocks.push(import_table(doc, ctx, &nested, content_index));
                    }
                    CellItemRef::ContentControl(control) => {
                        let label = control
                            .alias()
                            .or(control.tag())
                            .unwrap_or("contentControl")
                            .to_string();
                        cell_blocks.push(Block::Opaque(opaque_block(
                            ctx,
                            content_index,
                            label,
                            &control.text(),
                            true,
                        )));
                    }
                    CellItemRef::UnsupportedXml(raw) => {
                        cell_blocks.push(Block::Opaque(opaque_block(
                            ctx,
                            content_index,
                            "xml".into(),
                            &xml_text(raw),
                            !mentions_comment(raw),
                        )));
                    }
                    _ => {}
                }
            }
            if cell_blocks.is_empty() || !matches!(cell_blocks.last(), Some(Block::P(_))) {
                cell_blocks.push(Block::P(empty_paragraph()));
            }
            cells.push(wire::Cell {
                src: Some(cell_src),
                span: cell.grid_span().filter(|span| *span > 0).unwrap_or(1),
                v_merge: cell.v_merge().map(|merge| match merge {
                    VMerge::Restart => "restart".into(),
                    VMerge::Continue => "continue".into(),
                }),
                blocks: cell_blocks,
            });
        }
        rows.push(wire::Row {
            src: Some(row_src),
            header: row.is_header(),
            cant_split: row.cant_split_value().unwrap_or(false),
            cells,
        });
    }
    Block::Table(wire::Table::new(Some(src), grid_pt, rows))
}

fn import_paragraph(
    doc: &Document,
    ctx: &mut Ctx,
    paragraph: &ParagraphRef<'_>,
    addr: ParaAddr,
    section_end: Option<u32>,
) -> Para {
    let src = alloc_block(ctx, BlockOrigin::Paragraph(0), Some(ParaOrigin { addr }));
    if let Some(BlockOrigin::Paragraph(slot)) = ctx.sources.blocks.get_mut(src as usize) {
        *slot = src;
    }
    let style_id = paragraph
        .style_id()
        .unwrap_or(ctx.default_style.as_str())
        .to_string();
    ctx.pairs.insert((style_id.clone(), String::new()));
    if let Some((num_id, _)) = paragraph.numbering()
        && num_id != 0
    {
        ctx.nums.insert(num_id);
    }
    let mut inlines = Vec::new();
    let mut revisions = false;
    let mut field_depth: i32 = 0;
    ctx.run_counter = 0;
    walk_items(
        doc,
        ctx,
        paragraph,
        None,
        src,
        &style_id,
        &mut inlines,
        &mut revisions,
        &mut field_depth,
    );
    let inlines = merge_inlines(inlines);
    let mut lock = None;
    if revisions {
        lock = Some("revisions".into());
    } else if field_depth != 0 {
        lock = Some("unbalancedField".into());
    } else if model_text(&inlines) != paragraph.text() {
        lock = Some("roundTrip".into());
    }
    Para::new(
        Some(src),
        direct_props(paragraph),
        inlines,
        lock,
        section_end,
    )
}

#[allow(clippy::too_many_arguments)]
fn walk_items(
    doc: &Document,
    ctx: &mut Ctx,
    paragraph: &ParagraphRef<'_>,
    link: Option<&str>,
    para_src: u32,
    style_id: &str,
    inlines: &mut Vec<Inline>,
    revisions: &mut bool,
    field_depth: &mut i32,
) {
    for item in paragraph.items() {
        match item {
            ParagraphItemRef::Run(run) => emit_run(
                doc,
                ctx,
                &run,
                link,
                para_src,
                style_id,
                inlines,
                field_depth,
            ),
            ParagraphItemRef::Hyperlink(hyperlink) => {
                let target = link_target(doc, hyperlink);
                for child in hyperlink.items() {
                    match child {
                        HyperlinkItemRef::Run(run) => emit_run(
                            doc,
                            ctx,
                            &run,
                            target.as_deref(),
                            para_src,
                            style_id,
                            inlines,
                            field_depth,
                        ),
                        HyperlinkItemRef::Revision(revision) => note_revision(
                            doc,
                            ctx,
                            &revision,
                            target.as_deref(),
                            para_src,
                            style_id,
                            inlines,
                            revisions,
                            field_depth,
                        ),
                        HyperlinkItemRef::UnsupportedXml(raw) => {
                            note_field_xml(raw, field_depth);
                            inlines.push(opaque_atom(None, "xml", &xml_text(raw), true));
                        }
                        _ => {}
                    }
                }
            }
            ParagraphItemRef::Equation(_) => {
                inlines.push(opaque_atom(None, "equation", "", false));
            }
            ParagraphItemRef::ContentControl(control) => {
                let display = control.text();
                if !display.is_empty() {
                    // The control's text is part of ParagraphRef::text and is not a separate run.
                    inlines.push(Inline::Text {
                        text: display.clone(),
                        marks: Marks::default(),
                        src: None,
                    });
                }
                inlines.push(opaque_atom(None, "contentControl", &display, false));
            }
            ParagraphItemRef::Revision(revision) => note_revision(
                doc,
                ctx,
                &revision,
                link,
                para_src,
                style_id,
                inlines,
                revisions,
                field_depth,
            ),
            ParagraphItemRef::CommentRangeStart { id, .. } => {
                inlines.push(opaque_atom(None, "comment", &id.to_string(), false));
            }
            ParagraphItemRef::BookmarkStart { name, .. } => {
                inlines.push(opaque_atom(None, "bookmark", name.unwrap_or(""), false));
            }
            ParagraphItemRef::CommentRangeEnd { .. } | ParagraphItemRef::BookmarkEnd { .. } => {}
            ParagraphItemRef::UnsupportedXml(raw) => {
                note_field_xml(raw, field_depth);
                if !is_ignorable_marker(raw) {
                    inlines.push(opaque_atom(
                        None,
                        "xml",
                        &xml_text(raw),
                        !mentions_comment(raw),
                    ));
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn note_revision(
    doc: &Document,
    ctx: &mut Ctx,
    revision: &rdocx::RevisionRef<'_>,
    link: Option<&str>,
    para_src: u32,
    style_id: &str,
    inlines: &mut Vec<Inline>,
    revisions: &mut bool,
    field_depth: &mut i32,
) {
    *revisions = true;
    if matches!(
        revision.kind(),
        RevisionKind::Insertion | RevisionKind::MoveTo
    ) && let Some(inner) = revision.insertion_paragraph()
    {
        walk_items(
            doc,
            ctx,
            &inner,
            link,
            para_src,
            style_id,
            inlines,
            revisions,
            field_depth,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_run(
    doc: &Document,
    ctx: &mut Ctx,
    run: &RunRef<'_>,
    link: Option<&str>,
    para_src: u32,
    style_id: &str,
    inlines: &mut Vec<Inline>,
    field_depth: &mut i32,
) {
    let items: Vec<RunItemRef<'_>> = run.items().collect();
    let run_index = ctx.run_counter;
    ctx.run_counter += 1;
    let text_items = items
        .iter()
        .filter(|item| matches!(item, RunItemRef::Text(_) | RunItemRef::DeletedText(_)))
        .count();
    let other_items = items.len() - text_items;
    let src = alloc_run(ctx, para_src, run_index, text_items > 0 && other_items > 0);
    let mut marks = direct_marks(run);
    if let Some(link) = link {
        marks.link = Some(link.to_string());
    }
    if let Some(char_style) = marks.char_style.clone() {
        ctx.pairs.insert((style_id.to_string(), char_style));
    } else {
        ctx.pairs.insert((style_id.to_string(), String::new()));
    }
    if let Some(font) = marks.font.clone() {
        ctx.fonts.insert(font);
    }
    if let Some(font) = marks.font_east_asia.clone() {
        ctx.fonts.insert(font);
    }
    let mut buf = String::new();
    for item in &items {
        match item {
            RunItemRef::Text(text) | RunItemRef::DeletedText(text) => buf.push_str(text),
            RunItemRef::Tab => buf.push('\t'),
            RunItemRef::Break(BreakKind::Line) => buf.push('\n'),
            // ParagraphRef::text counts every break as "\n"; the atom records page and column breaks.
            RunItemRef::Break(BreakKind::Page) => {
                buf.push('\n');
                flush(&mut buf, inlines, &marks, src);
                inlines.push(Inline::Atom {
                    atom: Atom::PageBreak {},
                    src: Some(src),
                });
            }
            RunItemRef::Break(BreakKind::Column) => {
                buf.push('\n');
                flush(&mut buf, inlines, &marks, src);
                inlines.push(Inline::Atom {
                    atom: Atom::ColumnBreak {},
                    src: Some(src),
                });
            }
            RunItemRef::Drawing(drawing) => {
                flush(&mut buf, inlines, &marks, src);
                match drawing.relationship_id() {
                    Some(rel) if !rel.is_empty() => {
                        remember_media(doc, ctx, rel);
                        inlines.push(Inline::Atom {
                            atom: Atom::Image {
                                media: rel.to_string(),
                                width_pt: drawing.width().map(Length::to_pt).unwrap_or(0.0),
                                height_pt: drawing.height().map(Length::to_pt).unwrap_or(0.0),
                            },
                            src: Some(src),
                        });
                    }
                    _ => inlines.push(opaque_atom(Some(src), "drawing", "", true)),
                }
            }
            RunItemRef::Field(field) => {
                // A simple field's cached result is the text ParagraphRef::text reads from its inner runs.
                buf.push_str(field.cached_result());
                flush(&mut buf, inlines, &marks, src);
                inlines.push(Inline::Atom {
                    atom: Atom::Field {
                        field: field_kind(field.name()),
                        display: field.cached_result().to_string(),
                    },
                    src: Some(src),
                });
            }
            RunItemRef::FootnoteReference(id) => {
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(Some(src), "footnote", &id.to_string(), false));
            }
            RunItemRef::EndnoteReference(id) => {
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(Some(src), "endnote", &id.to_string(), false));
            }
            RunItemRef::CommentReference(id) => {
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(Some(src), "comment", &id.to_string(), false));
            }
            RunItemRef::Symbol { font, char_code } => {
                flush(&mut buf, inlines, &marks, src);
                ctx.fonts.insert((*font).to_string());
                inlines.push(opaque_atom(
                    Some(src),
                    "symbol",
                    &format!("{font} U+{char_code:04X}"),
                    true,
                ));
            }
            RunItemRef::SpecialCharacter(rdocx::SpecialCharacter::CarriageReturn) => {
                buf.push('\n');
            }
            RunItemRef::SpecialCharacter(_) => {
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(Some(src), "special", "", true));
            }
            RunItemRef::LastRenderedPageBreak(_) => {}
            RunItemRef::LegacyHorizontalRule(_) => {
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(Some(src), "rule", "", true));
            }
            RunItemRef::UnsupportedXml(raw) => {
                note_field_xml(raw, field_depth);
                if is_ignorable_marker(raw) {
                    continue;
                }
                flush(&mut buf, inlines, &marks, src);
                inlines.push(opaque_atom(
                    Some(src),
                    "xml",
                    &xml_text(raw),
                    !mentions_comment(raw),
                ));
            }
            _ => {}
        }
    }
    flush(&mut buf, inlines, &marks, src);
}

fn flush(buf: &mut String, inlines: &mut Vec<Inline>, marks: &Marks, src: u32) {
    if buf.is_empty() {
        return;
    }
    inlines.push(Inline::Text {
        text: std::mem::take(buf),
        marks: marks.clone(),
        src: Some(src),
    });
}

fn remember_media(doc: &Document, ctx: &mut Ctx, key: &str) {
    if ctx.media.contains_key(key) {
        return;
    }
    if let Some(bytes) = doc.image_data(key) {
        let content_type = sniff(&bytes).to_string();
        ctx.media.insert(key.to_string(), (content_type, bytes));
    }
}

pub(crate) fn direct_marks(run: &RunRef<'_>) -> Marks {
    let mut marks = Marks {
        bold: run.bold_value(),
        italic: run.italic_value(),
        underline: run.underline_code_value().map(|code| code != 0),
        strike: run.strike_value(),
        font: run.font_name().map(str::to_string),
        size_pt: run.size(),
        color: run
            .color()
            .filter(|color| !color.eq_ignore_ascii_case("auto"))
            .map(|color| color.trim_start_matches('#').to_ascii_uppercase()),
        highlight: run
            .highlight_color()
            .and_then(known_highlight)
            .map(str::to_string),
        vert_align: run.vert_align().and_then(vert_align).map(str::to_string),
        char_style: run.style_id().map(str::to_string),
        ..Marks::default()
    };
    if let Some(east_asia) = run.slot_font(RunFontSlot::EastAsia)
        && marks.font.as_deref() != Some(east_asia)
    {
        marks.font_east_asia = Some(east_asia.to_string());
    }
    marks
}

pub(crate) fn direct_props(paragraph: &ParagraphRef<'_>) -> ParaProps {
    let (first_line, hanging) = match paragraph.first_line_indent().map(Length::to_pt) {
        Some(value) if value < 0.0 => (None, Some(-value)),
        Some(value) => (Some(value), None),
        None => (None, None),
    };
    let line = if let Some(multiple) = paragraph.line_spacing_multiple() {
        Some(LineSpacing::Auto { multiple })
    } else {
        paragraph.line_spacing().map(|length| {
            // The public getter does not split exact from atLeast; exact is the rarer rule
            // and atLeast matches Word's "at least" line box. Resolved looks carry the rule.
            LineSpacing::AtLeast { pt: length.to_pt() }
        })
    };
    ParaProps {
        style: paragraph.style_id().map(str::to_string),
        align: paragraph.alignment().map(align_name),
        indent_left: paragraph
            .indent_left()
            .or_else(|| paragraph.indent_start())
            .map(Length::to_pt),
        indent_right: paragraph
            .indent_right()
            .or_else(|| paragraph.indent_end())
            .map(Length::to_pt),
        first_line,
        hanging,
        first_line_chars: None,
        space_before: paragraph.space_before().map(Length::to_pt),
        space_after: paragraph.space_after().map(Length::to_pt),
        line,
        numbering: match paragraph.numbering() {
            Some((0, _)) => Some(None),
            Some((num_id, level)) => Some(Some((num_id as i32, level))),
            None => None,
        },
        keep_next: paragraph.keep_with_next_value(),
        keep_lines: paragraph.keep_together_value(),
        page_break_before: paragraph.page_break_before_value(),
        widow_control: paragraph.widow_control_value(),
    }
}

fn align_name(align: Alignment) -> String {
    match align {
        Alignment::Left => "left",
        Alignment::Center => "center",
        Alignment::Right => "right",
        Alignment::Justify => "justify",
    }
    .into()
}

fn link_target(doc: &Document, link: rdocx::HyperlinkRef<'_>) -> Option<String> {
    if let Some(rel) = link.relationship_id() {
        return Some(doc.hyperlink_url(rel).unwrap_or_else(|| rel.to_string()));
    }
    link.anchor().map(|anchor| format!("#{anchor}"))
}

fn field_kind(name: &str) -> String {
    match name.trim().to_ascii_uppercase().as_str() {
        "PAGE" => "page",
        "NUMPAGES" => "numPages",
        _ => "other",
    }
    .into()
}

fn known_highlight(name: &str) -> Option<&str> {
    match name {
        "yellow" | "green" | "cyan" | "magenta" | "blue" | "red" | "darkBlue" | "darkCyan"
        | "darkGreen" | "darkMagenta" | "darkRed" | "darkYellow" | "darkGray" | "lightGray"
        | "black" => Some(name),
        _ => None,
    }
}

fn vert_align(value: &str) -> Option<&str> {
    match value {
        "superscript" | "super" => Some("super"),
        "subscript" | "sub" => Some("sub"),
        _ => None,
    }
}

fn model_text(inlines: &[Inline]) -> String {
    let mut text = String::new();
    for inline in inlines {
        if let Inline::Text { text: piece, .. } = inline {
            text.push_str(piece);
        }
    }
    text
}

fn merge_inlines(inlines: Vec<Inline>) -> Vec<Inline> {
    let mut merged = Vec::new();
    for inline in inlines {
        match (&mut merged.last_mut(), &inline) {
            (
                Some(Inline::Text { text, marks, src }),
                Inline::Text {
                    text: more,
                    marks: more_marks,
                    src: more_src,
                },
            ) if marks == more_marks && src == more_src => text.push_str(more),
            _ => merged.push(inline),
        }
    }
    merged
}

fn opaque_atom(src: Option<u32>, label: &str, display: &str, removable: bool) -> Inline {
    Inline::Atom {
        atom: Atom::Opaque {
            label: label.into(),
            display: display.into(),
            removable,
        },
        src,
    }
}

fn opaque_block(
    ctx: &mut Ctx,
    content_index: usize,
    label: String,
    text: &str,
    removable: bool,
) -> wire::Opaque {
    let src = alloc_block(ctx, BlockOrigin::Opaque { content_index }, None);
    let inlines = if text.is_empty() {
        Vec::new()
    } else {
        vec![Inline::Text {
            text: text.to_string(),
            marks: Marks::default(),
            src: None,
        }]
    };
    wire::Opaque::new(
        src,
        label,
        vec![Para::new(
            None,
            ParaProps::default(),
            inlines,
            Some("preview".into()),
            None,
        )],
        removable,
    )
}

fn empty_paragraph() -> Para {
    Para::new(None, ParaProps::default(), Vec::new(), None, None)
}

fn alloc_block(ctx: &mut Ctx, origin: BlockOrigin, para: Option<ParaOrigin>) -> u32 {
    let src = ctx.sources.blocks.len() as u32;
    ctx.sources.blocks.push(origin);
    ctx.sources.paras.push(para);
    src
}

fn alloc_run(ctx: &mut Ctx, para: u32, run_index: usize, mixed: bool) -> u32 {
    let src = ctx.sources.runs.len() as u32;
    ctx.sources.runs.push(RunOrigin {
        para,
        run_index,
        mixed,
    });
    src
}

fn alloc_row(ctx: &mut Ctx, table: u32, row: usize) -> u32 {
    let src = ctx.sources.rows.len() as u32;
    ctx.sources.rows.push(RowOrigin { table, row });
    src
}

fn alloc_cell(ctx: &mut Ctx, table: u32, row: usize, cell: usize) -> u32 {
    let src = ctx.sources.cells.len() as u32;
    ctx.sources.cells.push(CellOrigin { table, row, cell });
    src
}

fn sections_and_stories(
    doc: &Document,
    paragraphs: &HashMap<StoryKey, Vec<String>>,
    header_stories: &[StoryKey],
    footer_stories: &[StoryKey],
) -> (Vec<wire::Section>, Vec<(String, Vec<Block>)>) {
    let mut sections = Vec::new();
    let mut stories = Vec::new();
    let mut seen = BTreeSet::new();
    // section_story reparses every earlier header. Inventory order matches the
    // order section properties first mention each relationship.
    let header_of = align_stories(doc, header_stories, true);
    let footer_of = align_stories(doc, footer_stories, false);
    if let (Some(header_of), Some(footer_of)) = (header_of, footer_of) {
        let mut effective_headers: [Option<(usize, String)>; 3] = [None, None, None];
        let mut effective_footers: [Option<(usize, String)>; 3] = [None, None, None];
        for section in doc.sections() {
            note_refs(
                &mut effective_headers,
                section.ordinal(),
                section
                    .properties()
                    .header_refs
                    .iter()
                    .map(|reference| (reference.hdr_ftr_type, reference.rel_id.as_str())),
                &header_of,
            );
            note_refs(
                &mut effective_footers,
                section.ordinal(),
                section
                    .properties()
                    .footer_refs
                    .iter()
                    .map(|reference| (reference.hdr_ftr_type, reference.rel_id.as_str())),
                &footer_of,
            );
            let headers = linked_stories(
                &mut stories,
                &mut seen,
                paragraphs,
                &effective_headers,
                &header_of,
                "header",
            );
            let footers = linked_stories(
                &mut stories,
                &mut seen,
                paragraphs,
                &effective_footers,
                &footer_of,
                "footer",
            );
            sections.push(wire_section(&section, headers, footers));
        }
        return (sections, stories);
    }
    let kinds = [
        (HeaderFooterKind::Header, "header"),
        (HeaderFooterKind::Footer, "footer"),
    ];
    let types = [
        (HdrFtrType::Default, "default"),
        (HdrFtrType::First, "first"),
        (HdrFtrType::Even, "even"),
    ];
    let ordinals: Vec<usize> = doc.sections().map(|section| section.ordinal()).collect();
    for ordinal in ordinals {
        let mut headers = Vec::new();
        let mut footers = Vec::new();
        for (kind, kind_name) in kinds {
            for (hdr_type, type_name) in types {
                let Ok(Some(story)) = doc.section_story(ordinal, kind, hdr_type) else {
                    continue;
                };
                let key = format!("s{}/{kind_name}/{type_name}", story.source_section());
                if kind == HeaderFooterKind::Header {
                    headers.push((type_name.to_string(), key.clone()));
                } else {
                    footers.push((type_name.to_string(), key.clone()));
                }
                if seen.insert(key.clone()) {
                    let blocks = match paragraphs.get(&StoryKey::from_story(story.story())) {
                        Some(items) => import_story(items),
                        None => import_story(&story_paragraphs(doc, story.story())),
                    };
                    stories.push((key, blocks));
                }
            }
        }
        let Some(section) = doc.section(ordinal) else {
            continue;
        };
        sections.push(wire_section(&section, headers, footers));
    }
    (sections, stories)
}

fn align_stories(
    doc: &Document,
    stories: &[StoryKey],
    header: bool,
) -> Option<HashMap<String, StoryKey>> {
    let mut rels = Vec::new();
    let mut seen = HashSet::new();
    for section in doc.sections() {
        let refs = if header {
            &section.properties().header_refs
        } else {
            &section.properties().footer_refs
        };
        for reference in refs {
            if seen.insert(reference.rel_id.clone()) {
                rels.push(reference.rel_id.clone());
            }
        }
    }
    if rels.len() != stories.len() {
        return None;
    }
    Some(rels.into_iter().zip(stories.iter().cloned()).collect())
}

fn note_refs<'a>(
    effective: &mut [Option<(usize, String)>; 3],
    ordinal: usize,
    refs: impl IntoIterator<Item = (HdrFtrType, &'a str)>,
    available: &HashMap<String, StoryKey>,
) {
    let refs: Vec<(HdrFtrType, &str)> = refs.into_iter().collect();
    for (index, hdr_type) in [HdrFtrType::Default, HdrFtrType::First, HdrFtrType::Even]
        .into_iter()
        .enumerate()
    {
        let Some((_, rel)) = refs
            .iter()
            .find(|(kind, rel)| *kind == hdr_type && available.contains_key(*rel))
        else {
            continue;
        };
        effective[index] = Some((ordinal, (*rel).to_string()));
    }
}

fn linked_stories(
    stories: &mut Vec<(String, Vec<Block>)>,
    seen: &mut BTreeSet<String>,
    paragraphs: &HashMap<StoryKey, Vec<String>>,
    effective: &[Option<(usize, String)>; 3],
    stories_of: &HashMap<String, StoryKey>,
    kind_name: &str,
) -> Vec<(String, String)> {
    let mut links = Vec::new();
    for (index, type_name) in ["default", "first", "even"].into_iter().enumerate() {
        let Some((source, rel)) = &effective[index] else {
            continue;
        };
        let Some(story) = stories_of.get(rel) else {
            continue;
        };
        let key = format!("s{source}/{kind_name}/{type_name}");
        links.push((type_name.to_string(), key.clone()));
        if seen.insert(key.clone()) {
            let blocks = paragraphs
                .get(story)
                .map(|items| import_story(items))
                .unwrap_or_default();
            stories.push((key, blocks));
        }
    }
    links
}

fn wire_section(
    section: &SectionRef<'_>,
    headers: Vec<(String, String)>,
    footers: Vec<(String, String)>,
) -> wire::Section {
    let (width, height) = section
        .page_size()
        .map(|(width, height)| (width.to_pt(), height.to_pt()))
        .unwrap_or((612.0, 792.0));
    let (top, right, bottom, left) = section
        .margins()
        .map(|(top, right, bottom, left)| {
            (top.to_pt(), right.to_pt(), bottom.to_pt(), left.to_pt())
        })
        .unwrap_or((72.0, 72.0, 72.0, 72.0));
    let (header, footer) = section
        .header_footer_distance()
        .map(|(header, footer)| (header.to_pt(), footer.to_pt()))
        .unwrap_or((36.0, 36.0));
    let gutter = section.gutter().map(Length::to_pt).unwrap_or(0.0);
    wire::Section {
        src: Some(section.ordinal() as u32),
        width_pt: width,
        height_pt: height,
        margins_pt: [top, right, bottom, left, header, footer, gutter],
        break_type: break_name(
            section
                .break_type()
                .map(|value| format!("{value:?}"))
                .as_deref(),
        ),
        title_page: section.different_first_page().unwrap_or(false),
        headers,
        footers,
        grid: section_grid(section),
    }
}

fn break_name(value: Option<&str>) -> String {
    match value {
        Some("Continuous") => "continuous",
        Some("EvenPage") => "evenPage",
        Some("OddPage") => "oddPage",
        _ => "nextPage",
    }
    .into()
}

fn section_grid(section: &rdocx::SectionRef<'_>) -> Option<(String, f64, Option<i32>)> {
    let grid = section.doc_grid()?;
    let kind = match grid.grid_type {
        Some(ST_DocGrid::Lines) => "lines",
        Some(ST_DocGrid::LinesAndChars) => "linesAndChars",
        Some(ST_DocGrid::SnapToChars) => "snapToChars",
        _ => return None,
    };
    Some((
        kind.into(),
        grid.line_pitch.map(|pitch| pitch.to_pt()).unwrap_or(0.0),
        // The wire slot is an integer; the model stores this grid value in points.
        grid.char_space.map(|space| space / 20),
    ))
}

fn story_paragraphs(doc: &Document, story: &StoryId) -> Vec<String> {
    let Ok(items) = doc.story_items(story) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter(|item| item.kind() == StoryItemKind::Paragraph)
        .map(|item| item.text().ok().flatten().unwrap_or_default())
        .collect()
}

fn import_story(paragraphs: &[String]) -> Vec<Block> {
    let mut blocks = Vec::new();
    for text in paragraphs {
        let inlines = if text.is_empty() {
            Vec::new()
        } else {
            vec![Inline::Text {
                text: text.clone(),
                marks: Marks::default(),
                src: None,
            }]
        };
        // Header and footer stories are read-only, so they do not take a write-back src.
        blocks.push(Block::P(Para::new(
            None,
            ParaProps::default(),
            inlines,
            None,
            None,
        )));
    }
    blocks
}

fn para_looks(doc: &Document, styles: &StyleSheet, ctx: &mut Ctx) -> Vec<wire::ParaLookEntry> {
    let mut looks = Vec::new();
    let ids: Vec<String> = if styles.paragraph.is_empty() {
        vec![styles.default_paragraph.clone()]
    } else {
        styles
            .paragraph
            .iter()
            .map(|style| style.id.clone())
            .collect()
    };
    for style in ids {
        let mut props = doc.resolve_paragraph_properties(Some(&style));
        if let Some(num_id) = props.num_id
            && num_id != 0
        {
            ctx.nums.insert(num_id);
            let level = props.num_ilvl.unwrap_or(0);
            if let Some(definition) = doc.numbering_level(num_id, level) {
                if props.ind_left.is_none() {
                    props.ind_left = definition.indent_left;
                }
                if props.ind_hanging.is_none() {
                    props.ind_hanging = definition.indent_hanging;
                }
                if props.ind_first_line.is_none() {
                    props.ind_first_line = definition.indent_first_line;
                }
            }
        }
        looks.push(wire::ParaLookEntry {
            style,
            look: para_look_from(&props),
        });
    }
    looks
}

fn para_look_from(props: &rdocx::CT_PPr) -> ParaLook {
    let line = match (props.line_spacing, props.line_rule.as_deref()) {
        (Some(line), Some("exact")) => LineSpacing::Exact { pt: line.to_pt() },
        (Some(line), Some("atLeast")) => LineSpacing::AtLeast { pt: line.to_pt() },
        (Some(line), _) => LineSpacing::Auto {
            multiple: line.0 as f64 / 240.0,
        },
        (None, _) => LineSpacing::Auto { multiple: 1.0 },
    };
    ParaLook {
        align: align_debug(&format!("{:?}", props.jc)).into(),
        indent: ParaIndent {
            left: props
                .ind_left
                .or(props.ind_start)
                .map(|value| value.to_pt())
                .unwrap_or(0.0),
            right: props
                .ind_right
                .or(props.ind_end)
                .map(|value| value.to_pt())
                .unwrap_or(0.0),
            first_line: props
                .ind_first_line
                .map(|value| value.to_pt())
                .unwrap_or(0.0),
            hanging: props.ind_hanging.map(|value| value.to_pt()).unwrap_or(0.0),
            first_line_chars: None,
        },
        spacing: ParaSpacing {
            before: props.space_before.map(|value| value.to_pt()).unwrap_or(0.0),
            after: props.space_after.map(|value| value.to_pt()).unwrap_or(0.0),
            line,
            contextual: props.contextual_spacing.unwrap_or(false),
        },
        numbering: match props.num_id {
            Some(0) | None => None,
            Some(num_id) => Some((num_id as i32, props.num_ilvl.unwrap_or(0))),
        },
        keep_next: props.keep_next.unwrap_or(false),
        keep_lines: props.keep_lines.unwrap_or(false),
        page_break_before: props.page_break_before.unwrap_or(false),
        widow_control: props.widow_control.unwrap_or(true),
    }
}

fn align_debug(value: &str) -> &'static str {
    match value {
        "Some(Center)" => "center",
        "Some(Right)" | "Some(End)" => "right",
        "Some(Both)" => "justify",
        "Some(Distribute)" => "distribute",
        _ => "left",
    }
}

fn run_looks(doc: &Document, ctx: &Ctx) -> Vec<wire::RunLookEntry> {
    let theme = doc.theme();
    let mut looks = Vec::new();
    for (para, character) in &ctx.pairs {
        let char_style = if character.is_empty() {
            None
        } else {
            Some(character.as_str())
        };
        let props = doc.resolve_run_properties(Some(para), char_style);
        looks.push(wire::RunLookEntry {
            para: para.clone(),
            character: char_style.map(str::to_string),
            look: run_look_from(&props, theme),
        });
    }
    looks
}

fn run_look_from(props: &rdocx::CT_RPr, theme: Option<&rdocx::CT_OfficeStyleSheet>) -> RunLook {
    let ascii = font_of(
        props.font_ascii.as_deref(),
        props.font_ascii_theme.as_deref(),
        theme,
        "Calibri",
    );
    let h_ansi = match props.font_hansi.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => name.to_string(),
        None => match props.font_hansi_theme.as_deref() {
            Some(slot) => theme_font(theme, slot).unwrap_or_else(|| ascii.clone()),
            None => ascii.clone(),
        },
    };
    let east_asia = font_of(
        props.font_east_asia.as_deref(),
        props.font_east_asia_theme.as_deref(),
        theme,
        &ascii,
    );
    let cs = font_of(
        props.font_cs.as_deref(),
        props.font_cs_theme.as_deref(),
        theme,
        &ascii,
    );
    RunLook {
        fonts: RunFonts {
            ascii,
            h_ansi,
            east_asia,
            cs,
            hint: props.font_hint.as_deref().and_then(|hint| match hint {
                "eastAsia" => Some("eastAsia".into()),
                "cs" => Some("cs".into()),
                _ => None,
            }),
        },
        size_pt: props.sz.map(|size| size.to_pt()).unwrap_or(11.0),
        bold: props.bold.unwrap_or(false),
        italic: props.italic.unwrap_or(false),
        underline: props
            .underline
            .as_ref()
            .is_some_and(|style| format!("{style:?}") != "None"),
        strike: props.strike.unwrap_or(false) || props.dstrike.unwrap_or(false),
        color: norm_color(props.color.as_deref()),
        highlight: props
            .highlight
            .map(|color| color.to_str())
            .and_then(known_highlight)
            .map(str::to_string),
        caps: props.caps.unwrap_or(false),
        char_spacing_pt: props.spacing.map(|spacing| spacing.to_pt()).unwrap_or(0.0),
    }
}

fn font_of(
    explicit: Option<&str>,
    theme_slot: Option<&str>,
    theme: Option<&rdocx::CT_OfficeStyleSheet>,
    fallback: &str,
) -> String {
    if let Some(name) = explicit.filter(|name| !name.is_empty()) {
        return name.to_string();
    }
    if let Some(slot) = theme_slot
        && let Some(name) = theme_font(theme, slot)
    {
        return name;
    }
    fallback.to_string()
}

fn theme_font(theme: Option<&rdocx::CT_OfficeStyleSheet>, slot: &str) -> Option<String> {
    let theme = theme?;
    let scheme = &theme.theme_elements.font_scheme;
    let (major, script) = match slot {
        "majorAscii" | "majorHAnsi" => (true, "latin"),
        "minorAscii" | "minorHAnsi" => (false, "latin"),
        "majorEastAsia" => (true, "ea"),
        "minorEastAsia" => (false, "ea"),
        "majorBidi" | "majorCs" => (true, "cs"),
        "minorBidi" | "minorCs" => (false, "cs"),
        _ => return None,
    };
    let collection = if major {
        &scheme.major_font
    } else {
        &scheme.minor_font
    };
    let face = match script {
        "latin" => collection.latin.typeface.clone(),
        "ea" => collection.east_asian.typeface.clone(),
        _ => collection.complex_script.typeface.clone(),
    };
    if !face.is_empty() {
        return Some(face);
    }
    let scripts: &[&str] = match script {
        "ea" => &["Hans", "Hant", "Jpan", "Hang"],
        "cs" => &["Arab", "Hebr"],
        _ => &[],
    };
    for script_name in scripts {
        if let Some(font) = collection
            .supplemental_fonts
            .iter()
            .find(|font| font.script.eq_ignore_ascii_case(script_name))
            && !font.typeface.is_empty()
        {
            return Some(font.typeface.clone());
        }
    }
    None
}

fn norm_color(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => "auto".into(),
        Some(value) if value.eq_ignore_ascii_case("auto") => "auto".into(),
        Some(value) => value.trim_start_matches('#').to_ascii_uppercase(),
    }
}

fn lists(doc: &Document, nums: &BTreeSet<u32>) -> Vec<(i32, ListDef)> {
    let mut lists = Vec::new();
    for num_id in nums {
        let mut levels = Vec::new();
        for level in 0..9 {
            let Some(definition) = doc.numbering_level(*num_id, level) else {
                continue;
            };
            levels.push(ListLevel {
                format: list_format(&definition.format, definition.format_name),
                text: definition.level_text.unwrap_or("").to_string(),
                start: definition.start,
                indent_left_pt: definition
                    .indent_left
                    .map(|value| value.to_pt())
                    .unwrap_or(0.0),
                hanging_pt: definition
                    .indent_hanging
                    .map(|value| value.to_pt())
                    .unwrap_or(0.0),
            });
        }
        lists.push((
            *num_id as i32,
            ListDef {
                fresh: false,
                levels,
            },
        ));
    }
    lists
}

fn list_format(format: &NumberingFormat<'_>, name: &str) -> String {
    match format {
        NumberingFormat::Bullet => "bullet",
        NumberingFormat::Decimal => "decimal",
        NumberingFormat::ChineseCounting => "chineseCounting",
        NumberingFormat::IdeographTraditional => "ideographTraditional",
        NumberingFormat::DecimalEnclosedCircle | NumberingFormat::DecimalEnclosedCircleChinese => {
            "decimalEnclosedCircle"
        }
        NumberingFormat::LowerLetter => "lowerLetter",
        NumberingFormat::UpperLetter => "upperLetter",
        NumberingFormat::LowerRoman => "lowerRoman",
        NumberingFormat::UpperRoman => "upperRoman",
        NumberingFormat::None => "none",
        NumberingFormat::Other(_) => return name.to_string(),
        _ => return name.to_string(),
    }
    .into()
}

fn note_field_xml(raw: &[u8], depth: &mut i32) {
    let text = String::from_utf8_lossy(raw);
    let begins =
        text.matches("fldCharType=\"begin\"").count() + text.matches("fldCharType='begin'").count();
    let ends =
        text.matches("fldCharType=\"end\"").count() + text.matches("fldCharType='end'").count();
    *depth += begins as i32;
    *depth -= ends as i32;
}

fn is_ignorable_marker(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    text.contains("permStart") || text.contains("permEnd") || text.contains("proofErr")
}

fn mentions_comment(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    text.contains("commentRange") || text.contains("commentReference")
}

fn xml_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut in_tag = false;
    for character in text.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(character),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sniff(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}
