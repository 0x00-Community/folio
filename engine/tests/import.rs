use std::path::PathBuf;

use rdocx::{
    BodyItemRef, CellItemRef, Document, HdrFtrType, HeaderFooterKind, StoryId, StoryItemKind,
};
use rdocx_word_engine::Session;
use rdocx_word_engine::wire::{Atom, Block, Imported, Inline};
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
        if let Inline::Text { text: piece, .. } = inline {
            text.push_str(piece);
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
    for name in ["basic.docx", "long.docx", "preserve.docx"] {
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
