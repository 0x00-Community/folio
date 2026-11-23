use std::path::PathBuf;

use rdocx::{
    BodyItemRef, BorderStyle, CellBorderEdge, CellItemRef, ContentLocation, Document, HdrFtrType,
    HeaderFooterKind, Length, StoryId, StoryItemKind, StoryKind, TableBorderEdge,
};
use rdocx_word_engine::Session;
use rdocx_word_engine::wire::{
    Atom, Block, BorderEdge, BorderStyleName, Imported, Inline, LineSpacing,
};
use serde_json::Value;

fn golden(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join(format!("{name}.json"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn open(name: &str) -> (Document, Imported, Session) {
    let bytes = fixture(name);
    let doc = Document::from_bytes(&bytes).expect("fixture opens");
    let session = Session::from_bytes(&bytes).expect("session opens");
    let imported: Imported =
        serde_json::from_str(&session.import()).expect("import JSON matches the wire types");
    (doc, imported, session)
}

fn reference_texts(doc: &Document) -> Vec<String> {
    let mut texts = Vec::new();
    for item in doc.body_items() {
        match item {
            BodyItemRef::Paragraph(paragraph) => texts.push(paragraph.text()),
            BodyItemRef::Table(table) => collect_table(&table, &mut texts),
            BodyItemRef::ContentControl(_) | BodyItemRef::UnsupportedXml(_) => {}
        }
    }
    texts
}

fn collect_table(table: &rdocx::TableRef<'_>, texts: &mut Vec<String>) {
    for row_index in 0..table.row_count() {
        let Some(row) = table.row(row_index) else {
            continue;
        };
        for cell_index in 0..row.cell_count() {
            let Some(cell) = row.cell(cell_index) else {
                continue;
            };
            for item in cell.items() {
                match item {
                    CellItemRef::Paragraph(paragraph) => texts.push(paragraph.text()),
                    CellItemRef::Table(nested) => collect_table(&nested, texts),
                    CellItemRef::ContentControl(_) | CellItemRef::UnsupportedXml(_) => {}
                    _ => {}
                }
            }
        }
    }
}

fn imported_texts(blocks: &[Block]) -> Vec<String> {
    let mut texts = Vec::new();
    for block in blocks {
        match block {
            Block::P(para) => texts.push(flat_text(&para.inlines)),
            Block::Table(table) => {
                for row in &table.rows {
                    for cell in &row.cells {
                        texts.extend(imported_texts(&cell.blocks));
                    }
                }
            }
            Block::Opaque(_) => {}
        }
    }
    texts
}

fn flat_text(inlines: &[Inline]) -> String {
    let mut text = String::new();
    for inline in inlines {
        match inline {
            Inline::Text { text: piece, .. } => text.push_str(piece),
            Inline::Atom {
                atom: Atom::PageBreak {} | Atom::ColumnBreak {},
                ..
            } => text.push('\n'),
            Inline::Atom { .. } => {}
        }
    }
    text
}

fn assert_texts_match(name: &str) {
    let (doc, imported, _) = open(name);
    let expected = reference_texts(&doc);
    let actual = imported_texts(&imported.body);
    assert_eq!(
        actual.len(),
        expected.len(),
        "{name}: imported paragraph count {} != rdocx {}",
        actual.len(),
        expected.len()
    );
    for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(
            actual, expected,
            "{name} paragraph {index} text diverges from ParagraphRef::text()"
        );
    }
    assert!(
        !has_lock(&imported.body, "roundTrip"),
        "{name} locked a paragraph whose text did not round-trip"
    );
}

fn has_lock(blocks: &[Block], reason: &str) -> bool {
    blocks.iter().any(|block| match block {
        Block::P(para) => para.lock.as_deref() == Some(reason),
        Block::Table(table) => table
            .rows
            .iter()
            .any(|row| row.cells.iter().any(|cell| has_lock(&cell.blocks, reason))),
        Block::Opaque(opaque) => opaque
            .preview
            .iter()
            .any(|para| para.lock.as_deref() == Some(reason)),
    })
}

fn walk_atoms(blocks: &[Block], visit: &mut dyn FnMut(&Atom)) {
    for block in blocks {
        match block {
            Block::P(para) => {
                for inline in &para.inlines {
                    if let Inline::Atom { atom, .. } = inline {
                        visit(atom);
                    }
                }
            }
            Block::Table(table) => {
                for row in &table.rows {
                    for cell in &row.cells {
                        walk_atoms(&cell.blocks, visit);
                    }
                }
            }
            Block::Opaque(_) => {}
        }
    }
}

fn numbering_pairs(doc: &Document) -> Vec<(u32, u32)> {
    let mut pairs = Vec::new();
    for item in doc.body_items() {
        if let BodyItemRef::Paragraph(paragraph) = item
            && let Some(pair) = paragraph.numbering()
        {
            pairs.push(pair);
        }
    }
    pairs
}

#[test]
fn basic_long_and_preserve_text_matches_rdocx() {
    assert_texts_match("basic.docx");
    assert_texts_match("long.docx");
    assert_texts_match("preserve.docx");
    assert_texts_match("tables.docx");
}

#[test]
fn basic_docx_has_table_lists_image_stories_and_roles() {
    let (doc, imported, session) = open("basic.docx");
    let tables: Vec<_> = imported
        .body
        .iter()
        .filter_map(|block| match block {
            Block::Table(table) => Some(table),
            _ => None,
        })
        .collect();
    assert_eq!(tables.len(), 1, "basic.docx has one table");
    let table = tables[0];
    assert_eq!(table.rows.len(), 3, "table has 3 rows");
    assert!(
        table.rows.iter().all(|row| row.cells.len() == 3),
        "table has 3 cells in every row"
    );

    let expected = numbering_pairs(&doc);
    let actual: Vec<(i32, u32)> = imported
        .body
        .iter()
        .filter_map(|block| match block {
            Block::P(para) => para.props.numbering.flatten(),
            _ => None,
        })
        .collect();
    assert_eq!(actual.len(), 6, "six list paragraphs");
    assert_eq!(
        actual.len(),
        expected.len(),
        "list paragraph count matches rdocx numbering()"
    );
    for (index, ((num_id, level), (expected_id, expected_level))) in
        actual.iter().zip(expected.iter()).enumerate()
    {
        assert_eq!(
            (*num_id as u32, *level),
            (*expected_id, *expected_level),
            "list paragraph {index} numId/level"
        );
    }

    let mut images = 0;
    walk_atoms(&imported.body, &mut |atom| {
        if matches!(atom, Atom::Image { .. }) {
            images += 1;
        }
    });
    assert_eq!(images, 1, "one image");
    assert_eq!(imported.media.len(), 1, "one media key");
    let (key, content_type) = &imported.media[0];
    assert!(
        content_type.contains("png"),
        "image content type is png, got {content_type}"
    );
    let media = session.media(key).expect("media bytes");
    assert!(
        media.bytes().starts_with(&[0x89, b'P', b'N', b'G']),
        "media bytes are a PNG"
    );

    let story_text = |key_part: &str| {
        imported
            .stories
            .iter()
            .filter(|(key, _)| key.contains(key_part))
            .flat_map(|(_, blocks)| imported_texts(blocks))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(
        story_text("header").contains("rdocx-acde fixture header"),
        "header story text"
    );
    assert!(
        story_text("footer").contains("rdocx-acde fixture footer"),
        "footer story text"
    );

    let roles: Vec<_> = imported
        .styles
        .paragraph
        .iter()
        .filter_map(|style| style.role.clone())
        .collect();
    for role in ["title", "heading1", "heading2", "normal"] {
        assert!(
            roles.iter().any(|item| item == role),
            "role {role} detected"
        );
    }
    assert!(session.block_sources() > 0, "src ids were minted");
}

#[test]
fn preserve_docx_keeps_comment_bookmark_field_and_hyperlink() {
    let (_, imported, _) = open("preserve.docx");
    let mut saw_comment = false;
    let mut saw_bookmark = false;
    let mut saw_field = false;
    walk_atoms(&imported.body, &mut |atom| match atom {
        Atom::Opaque { label, .. } if label == "comment" => saw_comment = true,
        Atom::Opaque { label, display, .. }
            if label == "bookmark" && display.contains("kept_bookmark") =>
        {
            saw_bookmark = true;
        }
        Atom::Field { .. } => saw_field = true,
        _ => {}
    });
    assert!(saw_comment, "comment appears as an atom");
    assert!(saw_bookmark, "bookmark appears as an atom");
    assert!(saw_field, "field appears as an atom");
    let mut saw_link = false;
    for block in &imported.body {
        let Block::P(para) = block else {
            continue;
        };
        for inline in &para.inlines {
            if let Inline::Text { marks, .. } = inline
                && marks.link.as_deref() == Some("https://example.com/")
            {
                saw_link = true;
            }
        }
    }
    assert!(saw_link, "hyperlink mark is the relationship URL");
}

#[test]
fn wire_json_keys_are_declared_in_wire_ts() {
    let (_, imported, _) = open("basic.docx");
    let value = serde_json::to_value(&imported).expect("imported serializes");
    let source = include_str!("../../src/engine/wire.ts");
    let mut missing = Vec::new();
    collect_keys(&value, source, &mut missing);
    assert!(
        missing.is_empty(),
        "wire.ts is missing JSON keys: {}",
        missing.join(", ")
    );
}

fn collect_keys(value: &Value, source: &str, missing: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if !source.contains(&format!("'{key}'"))
                    && !source.contains(&format!("\"{key}\""))
                    && !source.contains(&format!("{key}:"))
                    && !source.contains(&format!("{key}?:"))
                {
                    missing.push(key.clone());
                }
                collect_keys(child, source, missing);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_keys(item, source, missing);
            }
        }
        _ => {}
    }
}

#[test]
fn header_story_text_matches_story_items() {
    let bytes = fixture("basic.docx");
    let doc = Document::from_bytes(&bytes).expect("fixture opens");
    let session = Session::from_bytes(&bytes).expect("session opens");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let story = doc
        .section_story(0, HeaderFooterKind::Header, HdrFtrType::Default)
        .expect("story lookup")
        .expect("default header");
    let expected = doc
        .story_items(story.story())
        .expect("header items")
        .into_iter()
        .filter(|item| item.kind() == StoryItemKind::Paragraph)
        .map(|item| item.text().ok().flatten().unwrap_or_default())
        .collect::<Vec<_>>();
    let actual = imported
        .stories
        .iter()
        .find(|(key, _)| key.contains("header"))
        .map(|(_, blocks)| imported_texts(blocks))
        .unwrap_or_default();
    assert_eq!(actual, expected, "header paragraphs match story_items");
    let _ = StoryId::body();
}

#[test]
fn fixture_import_matches_recorded_golden_json() {
    for name in ["basic.docx", "long.docx", "preserve.docx", "tables.docx"] {
        let bytes = fixture(name);
        let session = Session::from_bytes(&bytes).expect("session opens");
        let actual = session.import();
        let expected = golden(name);
        if actual == expected {
            continue;
        }
        let actual_bytes = actual.as_bytes();
        let expected_bytes = expected.as_bytes();
        let shared = actual_bytes.len().min(expected_bytes.len());
        let mut index = 0;
        while index < shared && actual_bytes[index] == expected_bytes[index] {
            index += 1;
        }
        let start = index.saturating_sub(60);
        panic!(
            "{name} import JSON differs at byte {index} (actual {}, golden {})\nactual: {:?}\ngolden: {:?}",
            actual_bytes.len(),
            expected_bytes.len(),
            String::from_utf8_lossy(&actual_bytes[start..(index + 60).min(actual_bytes.len())]),
            String::from_utf8_lossy(&expected_bytes[start..(index + 60).min(expected_bytes.len())]),
        );
    }
}

#[test]
fn tables_docx_borders_follow_direct_style_and_cell() {
    let (_, imported, _) = open("tables.docx");
    let mut headings = Vec::new();
    let mut tables = Vec::new();
    for block in &imported.body {
        match block {
            Block::P(para) => headings.push(flat_text(&para.inlines)),
            Block::Table(table) => tables.push(table),
            Block::Opaque(_) => {}
        }
    }
    assert_eq!(
        headings,
        [
            "No borders",
            "Direct borders",
            "Table Grid",
            "Cell override",
            "Insert here.",
        ]
    );
    assert_eq!(tables.len(), 4);

    assert!(
        tables[0].borders.is_none(),
        "a table with no borders omits them"
    );
    assert!(cells_omit_borders(tables[0]));

    let direct = line(BorderStyleName::Single, 1.0, "FF0000");
    assert_eq!(
        tables[1].borders.as_ref().map(edges_of),
        Some(vec![direct.clone(); 6])
    );
    assert!(cells_omit_borders(tables[1]));

    let grid = line(BorderStyleName::Single, 0.5, "000000");
    assert_eq!(
        tables[2].borders.as_ref().map(edges_of),
        Some(vec![grid.clone(); 6])
    );
    assert!(
        cells_omit_borders(tables[2]),
        "Table Grid borders stay on the table"
    );

    let blue = line(BorderStyleName::Single, 1.5, "0000FF");
    assert_eq!(
        tables[3].borders.as_ref().map(edges_of),
        Some(vec![blue; 6])
    );
    let over = tables[3].rows[0].cells[0]
        .borders
        .as_ref()
        .expect("cell override");
    assert!(over.top.is_none() && over.left.is_none() && over.bottom.is_none());
    assert_eq!(over.right, Some(None), "a nil right edge is no line");
    assert!(tables[3].rows[0].cells[1].borders.is_none());
    assert!(
        tables[3].rows[1]
            .cells
            .iter()
            .all(|cell| cell.borders.is_none())
    );
}

#[test]
fn nil_is_null_none_is_unset_and_an_unnamed_style_is_single() {
    let mut doc = Document::new();
    {
        let mut table = doc.add_table(1, 2);
        table
            .set_border_checked(TableBorderEdge::Top, BorderStyle::Thick, 8, "auto")
            .expect("top");
        table
            .set_border_checked(TableBorderEdge::Left, BorderStyle::None, 0, "auto")
            .expect("left");
        if let Some(mut cell) = table.cell(0, 0) {
            cell.set_border_checked(CellBorderEdge::Right, BorderStyle::None, 0, "00ff00")
                .expect("nil cell");
        }
        if let Some(mut cell) = table.cell(0, 1) {
            cell.set_border_checked(CellBorderEdge::Right, BorderStyle::None, 0, "auto")
                .expect("none cell");
            cell.set_border_checked(CellBorderEdge::Top, BorderStyle::Single, 8, "FF0000")
                .expect("none cell top");
        }
    }
    set_cell_edge_nil(&mut doc, 0, 0);
    let bytes = doc.to_bytes().expect("bytes");
    let session = Session::from_bytes(&bytes).expect("session");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let Block::Table(table) = &imported.body[0] else {
        panic!("table");
    };
    let borders = table.borders.as_ref().expect("direct borders");
    let top = borders.top.as_ref().expect("thick becomes a line");
    assert_eq!(top.style, BorderStyleName::Single);
    assert_eq!(top.width_pt, 1.0);
    assert_eq!(top.color, "000000");
    assert!(borders.left.is_none(), "a table edge of none is no line");
    assert!(
        borders.bottom.is_none(),
        "an omitted edge of a present set is no line"
    );
    let nil_cell = table.rows[0].cells[0].borders.as_ref().expect("nil edge");
    assert_eq!(nil_cell.right, Some(None), "nil stays no line");
    assert!(nil_cell.top.is_none() && nil_cell.left.is_none() && nil_cell.bottom.is_none());
    let none_cell = table.rows[0].cells[1]
        .borders
        .as_ref()
        .expect("the top edge is still an override");
    assert!(
        none_cell.right.is_none(),
        "none is unset so the table edge shows"
    );
    let none_top = none_cell
        .top
        .as_ref()
        .and_then(|edge| edge.as_ref())
        .expect("top line");
    assert_eq!(none_top.color, "FF0000");
}

#[test]
fn direct_exact_line_spacing_imports_as_exact() {
    let mut doc = Document::new();
    doc.add_paragraph("exact").set_line_spacing(16.0);
    doc.add_paragraph("least").set_line_spacing_at_least(14.0);
    doc.add_paragraph("auto").set_line_spacing_multiple(1.5);
    doc.add_paragraph("plain");
    let bytes = doc.to_bytes().expect("bytes");
    let session = Session::from_bytes(&bytes).expect("session");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let Block::P(exact) = &imported.body[0] else {
        panic!("exact paragraph");
    };
    assert_eq!(exact.props.line, Some(LineSpacing::Exact { pt: 16.0 }));
    let Block::P(least) = &imported.body[1] else {
        panic!("at least paragraph");
    };
    assert_eq!(least.props.line, Some(LineSpacing::AtLeast { pt: 14.0 }));
    let Block::P(auto) = &imported.body[2] else {
        panic!("auto paragraph");
    };
    assert_eq!(auto.props.line, Some(LineSpacing::Auto { multiple: 1.5 }));
    let Block::P(plain) = &imported.body[3] else {
        panic!("plain paragraph");
    };
    assert!(
        plain.props.line.is_none(),
        "a style rule is not a direct rule"
    );
}

/// `BorderStyle` has no nil. The cell edge is written as `none`, then the attribute is rewritten.
fn set_cell_edge_nil(doc: &mut Document, row: usize, cell: usize) {
    let location = last_table_location(doc);
    let xml = doc
        .cell_element_xml(&location, row, cell)
        .expect("cell xml");
    let text = String::from_utf8(xml).expect("cell xml is utf-8");
    let next = text.replacen("w:val=\"none\"", "w:val=\"nil\"", 1);
    assert_ne!(next, text, "the cell edge was not w:val=\"none\": {text}");
    doc.replace_cell_xml(&location, row, cell, &next)
        .expect("replace nil edge");
}

fn last_table_location(doc: &Document) -> ContentLocation {
    let stories = doc.stories().expect("stories");
    let body = stories
        .iter()
        .find(|story| story.kind() == StoryKind::Body)
        .expect("body story");
    let items = doc.story_items(body).expect("story items");
    items
        .iter()
        .rev()
        .find(|item| item.kind() == StoryItemKind::Table)
        .expect("table")
        .location()
        .clone()
}

fn line(style: BorderStyleName, width_pt: f64, color: &str) -> BorderEdge {
    BorderEdge {
        style,
        width_pt,
        color: color.to_string(),
    }
}

fn edges_of(borders: &rdocx_word_engine::wire::TableBorders) -> Vec<BorderEdge> {
    [
        borders.top.clone(),
        borders.left.clone(),
        borders.bottom.clone(),
        borders.right.clone(),
        borders.inside_h.clone(),
        borders.inside_v.clone(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn cells_omit_borders(table: &rdocx_word_engine::wire::Table) -> bool {
    table
        .rows
        .iter()
        .all(|row| row.cells.iter().all(|cell| cell.borders.is_none()))
}

#[test]
fn footer_field_text_matches_story_items() {
    let mut doc = Document::new();
    doc.set_raw_footer_with_images(footer_with_fields(), &[], HdrFtrType::Default);
    doc.add_paragraph("body");
    let bytes = doc.to_bytes().expect("serialize");
    let doc = Document::from_bytes(&bytes).expect("reopen");
    let session = Session::from_bytes(&bytes).expect("session opens");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let story = doc
        .section_story(0, HeaderFooterKind::Footer, HdrFtrType::Default)
        .expect("story lookup")
        .expect("default footer");
    let expected = doc
        .story_items(story.story())
        .expect("footer items")
        .into_iter()
        .filter(|item| item.kind() == StoryItemKind::Paragraph)
        .map(|item| item.text().ok().flatten().unwrap_or_default())
        .collect::<Vec<_>>();
    let actual = imported
        .stories
        .iter()
        .filter(|(key, _)| key.contains("footer"))
        .flat_map(|(_, blocks)| imported_texts(blocks))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected, "footer paragraphs match story_items");
}

fn footer_with_fields() -> Vec<u8> {
    r#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚 Footer</w:t></w:r></w:p><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t> PAGE </w:t></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:r><w:t>n=</w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>9</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:t>keep</w:t></w:r><w:del><w:r><w:t>gone</w:t></w:r></w:del></w:p></w:ftr>"#.as_bytes().to_vec()
}

#[test]
fn section_break_paragraph_carries_section_end() {
    let mut doc = Document::new();
    doc.add_paragraph("before");
    doc.insert_section(doc.section_count())
        .expect("section break");
    doc.add_paragraph("after");
    let bytes = doc.to_bytes().expect("serialize");
    let session = Session::from_bytes(&bytes).expect("session opens");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let marked: Vec<(String, u32)> = imported
        .body
        .iter()
        .filter_map(|block| {
            let Block::P(para) = block else {
                return None;
            };
            para.section_end.map(|end| (flat_text(&para.inlines), end))
        })
        .collect();
    assert_eq!(
        marked,
        vec![("".to_string(), 0)],
        "the paragraph that carries sectPr ends section 0"
    );
}

#[test]
fn each_section_keeps_its_own_header() {
    let mut doc = Document::new();
    doc.set_header("页眉 Header 0");
    doc.add_paragraph("one");
    doc.insert_section(doc.section_count())
        .expect("section break");
    doc.set_header("页眉 Header 1");
    doc.add_paragraph("two");
    let bytes = doc.to_bytes().expect("serialize");
    let session = Session::from_bytes(&bytes).expect("session opens");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let texts = imported
        .stories
        .iter()
        .filter(|(key, _)| key.contains("header"))
        .map(|(key, blocks)| (key.clone(), imported_texts(blocks).join("\n")))
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            ("s0/header/default".to_string(), "页眉 Header 0".to_string()),
            ("s1/header/default".to_string(), "页眉 Header 1".to_string()),
        ],
        "each section's header story keeps its own text"
    );
}

#[test]
fn row_height_and_cell_margins_import() {
    let mut doc = Document::new();
    {
        let mut table = doc.add_table(3, 1);
        table
            .row(0)
            .expect("exact row")
            .set_height_exact(Length::pt(24.0));
        table
            .row(1)
            .expect("at least row")
            .set_height(Length::pt(18.0));
        table.set_cell_margins(
            Length::pt(2.0),
            Length::pt(4.0),
            Length::pt(6.0),
            Length::pt(8.0),
        );
        table
            .cell(0, 0)
            .expect("cell")
            .set_margins_checked(
                Length::pt(1.0),
                Length::pt(3.0),
                Length::pt(5.0),
                Length::pt(7.0),
            )
            .expect("cell margins");
    }
    doc.add_table(1, 1);
    let bytes = doc.to_bytes().expect("bytes");
    let session = Session::from_bytes(&bytes).expect("session");
    let imported: Imported = serde_json::from_str(&session.import()).expect("wire");
    let Block::Table(table) = &imported.body[0] else {
        panic!("table");
    };
    assert_eq!(table.rows[0].height_pt, Some(24.0));
    assert_eq!(table.rows[0].height_rule.as_deref(), Some("exact"));
    assert_eq!(table.rows[1].height_pt, Some(18.0));
    assert_eq!(table.rows[1].height_rule.as_deref(), Some("atLeast"));
    assert_eq!(table.rows[2].height_pt, None, "auto is no height");
    assert_eq!(table.rows[2].height_rule, None);
    let margins = table.margins.as_ref().expect("table margins");
    assert_eq!(margins.top, Some(2.0));
    assert_eq!(margins.right, Some(4.0));
    assert_eq!(margins.bottom, Some(6.0));
    assert_eq!(margins.left, Some(8.0));
    let cell = table.rows[0].cells[0]
        .margins
        .as_ref()
        .expect("cell margins");
    assert_eq!(cell.top, Some(1.0));
    assert_eq!(cell.right, Some(3.0));
    assert_eq!(cell.bottom, Some(5.0));
    assert_eq!(cell.left, Some(7.0));
    assert!(table.rows[1].cells[0].margins.is_none());
    let Block::Table(plain) = &imported.body[1] else {
        panic!("plain table");
    };
    assert!(
        plain.margins.is_none(),
        "a table that sets no margins omits them"
    );
    assert!(plain.rows[0].height_pt.is_none());
}
