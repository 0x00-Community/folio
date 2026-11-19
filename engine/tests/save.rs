//! Save patches built from each fixture's import.

use std::path::PathBuf;

use rdocx::{Document, ParagraphPropertyKeep};
use rdocx_word_engine::Session;
use rdocx_word_engine::import::{self, Import};
use rdocx_word_engine::verify;
use rdocx_word_engine::wire::{
    Atom, Block, BridgeError, Inline, ListDef, ListLevel, Marks, Para, Patch, PatchBlock, Table,
};

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn opened(name: &str) -> (Session, Import) {
    let bytes = fixture(name);
    let session = Session::from_bytes(&bytes).expect(name);
    let imported = import::import(&Document::from_bytes(&bytes).expect(name));
    (session, imported)
}

fn block_src(block: &Block) -> Option<u32> {
    match block {
        Block::P(para) => para.src,
        Block::Table(table) => table.src,
        Block::Opaque(opaque) => Some(opaque.src),
    }
}

fn keep_patch(imported: &rdocx_word_engine::wire::Imported) -> Patch {
    Patch {
        body: imported
            .body
            .iter()
            .map(|block| PatchBlock::Keep {
                keep: block_src(block).expect("fixture block has a src"),
            })
            .collect(),
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
    }
}

fn patch_replacing(
    imported: &rdocx_word_engine::wire::Imported,
    src: u32,
    blocks: Vec<PatchBlock>,
) -> Patch {
    let mut body = Vec::new();
    let mut replaced = false;
    for block in &imported.body {
        if block_src(block) == Some(src) {
            body.extend(blocks.clone());
            replaced = true;
        } else {
            body.push(PatchBlock::Keep {
                keep: block_src(block).expect("src"),
            });
        }
    }
    assert!(replaced, "block {src} was not in the body");
    Patch {
        body,
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
    }
}

fn changed_para(para: Para) -> PatchBlock {
    PatchBlock::Changed(Block::P(para))
}

fn save(session: &Session, patch: &Patch) -> Vec<u8> {
    session
        .save_result(&serde_json::to_string(patch).expect("patch json"))
        .unwrap_or_else(|error| panic!("save failed: {error:?}"))
}

fn reopen(bytes: &[u8]) -> Import {
    import::import(&Document::from_bytes(bytes).expect("written bytes open"))
}

fn para_by_src(body: &[Block], src: u32) -> &Para {
    body.iter()
        .find_map(|block| match block {
            Block::P(para) if para.src == Some(src) => Some(para),
            _ => None,
        })
        .unwrap_or_else(|| panic!("paragraph {src}"))
}

fn text_of(para: &Para) -> String {
    para.inlines
        .iter()
        .filter_map(|inline| match inline {
            Inline::Text { text, .. } => Some(text.as_str()),
            Inline::Atom { .. } => None,
        })
        .collect()
}

fn set_run_text(para: &mut Para, run: u32, text: &str) {
    for inline in &mut para.inlines {
        if let Inline::Text {
            text: slot, src, ..
        } = inline
            && *src == Some(run)
        {
            *slot = text.to_string();
        }
    }
}

fn edit_run_marks(para: &mut Para, run: u32, edit: impl Fn(&mut Marks)) {
    for inline in &mut para.inlines {
        if let Inline::Text { marks, src, .. } = inline
            && *src == Some(run)
        {
            edit(marks);
        }
    }
}

fn body_para(imported: &Import, src: u32) -> &Para {
    para_by_src(&imported.imported.body, src)
}

#[test]
fn keep_patch_imports_equal() {
    for name in ["basic.docx", "long.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let written = save(&session, &keep_patch(&before.imported));
        let after = reopen(&written);
        assert_eq!(after.imported, before.imported, "{name}");
        assert_eq!(after.ledger.counts, before.ledger.counts, "{name} ledger");
        assert_eq!(
            session.import(),
            serde_json::to_string(&before.imported).unwrap()
        );
    }
}

#[test]
fn text_in_one_run() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    set_run_text(&mut para, 11, "Centered paragraph!");
    let written = save(
        &session,
        &patch_replacing(&before.imported, 3, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        text_of(para_by_src(&after.imported.body, 3)),
        "Centered paragraph!"
    );
    assert_eq!(session.ledger().counts, before.ledger.counts);
}

#[test]
fn text_spanning_two_runs() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    set_run_text(&mut para, 2, "Plain, bold, ");
    para.inlines
        .retain(|inline| !matches!(inline, Inline::Text { src: Some(3), .. }));
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        text_of(para_by_src(&after.imported.body, 2)),
        "Plain, bold, italic, underlined, struck, red, large, highlighted, Arial."
    );
}

#[test]
fn new_run_with_marks_in_the_middle() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    para.inlines = vec![
        Inline::Text {
            text: "Centered ".into(),
            marks: Marks::default(),
            src: Some(11),
        },
        Inline::Text {
            text: "NEW".into(),
            marks: Marks {
                bold: Some(true),
                ..Marks::default()
            },
            src: None,
        },
        Inline::Text {
            text: "paragraph.".into(),
            marks: Marks::default(),
            src: Some(11),
        },
    ];
    let written = save(
        &session,
        &patch_replacing(&before.imported, 3, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    let para = para_by_src(&after.imported.body, 3);
    assert_eq!(text_of(para), "Centered NEWparagraph.");
    let bold = para.inlines.iter().any(|inline| {
        matches!(
            inline,
            Inline::Text { text, marks, .. } if text == "NEW" && marks.bold == Some(true)
        )
    });
    assert!(bold, "{:?}", para.inlines);
}

#[test]
fn split_one_paragraph_into_three() {
    let (session, before) = opened("basic.docx");
    let original = body_para(&before, 3).clone();
    let parts = ["Cen", "tered ", "paragraph."];
    let blocks = parts
        .into_iter()
        .map(|text| {
            let mut para = original.clone();
            para.inlines = vec![Inline::Text {
                text: text.into(),
                marks: Marks::default(),
                src: Some(11),
            }];
            changed_para(para)
        })
        .collect();
    let written = save(&session, &patch_replacing(&before.imported, 3, blocks));
    let after = reopen(&written);
    let texts: Vec<String> = after
        .imported
        .body
        .iter()
        .skip(3)
        .take(3)
        .map(text_of_block)
        .collect();
    assert_eq!(texts, vec!["Cen", "tered ", "paragraph."]);
}

#[test]
fn join_three_paragraphs_each_keep_side() {
    let (session, before) = opened("basic.docx");
    for keep in [3u32, 5] {
        let paras: Vec<Para> = (3..=5).map(|src| body_para(&before, src).clone()).collect();
        let mut joined = paras
            .iter()
            .find(|para| para.src == Some(keep))
            .unwrap()
            .clone();
        joined.inlines = paras.iter().flat_map(|para| para.inlines.clone()).collect();
        let mut patch = keep_patch(&before.imported);
        let mut body = Vec::new();
        let mut emitted = false;
        for block in &patch.body {
            let PatchBlock::Keep { keep: src } = block else {
                continue;
            };
            if (3..=5).contains(src) {
                if !emitted {
                    body.push(changed_para(joined.clone()));
                    emitted = true;
                }
            } else {
                body.push(block.clone());
            }
        }
        patch.body = body;
        let written = save(&session, &patch);
        let after = reopen(&written);
        let Block::P(para) = &after.imported.body[3] else {
            panic!("joined paragraph missing");
        };
        let expect: String = paras.iter().map(text_of).collect();
        assert_eq!(text_of(para), expect, "keep {keep}");
        assert_eq!(para.props.align, body_para(&before, keep).props.align);
        assert_eq!(after.imported.body.len(), before.imported.body.len() - 2);
    }
}

#[test]
fn delete_bookmarked_paragraph_keeps_the_bookmark() {
    let (session, before) = opened("preserve.docx");
    let mut patch = keep_patch(&before.imported);
    patch
        .body
        .retain(|block| !matches!(block, PatchBlock::Keep { keep: 4 }));
    let written = save(&session, &patch);
    let after = reopen(&written);
    assert!(
        after
            .imported
            .body
            .iter()
            .all(|block| text_of_block(block) != "Bookmarked paragraph."),
        "the bookmarked paragraph was deleted"
    );
    let neighbor = after
        .imported
        .body
        .iter()
        .find(|block| matches!(block, Block::P(para) if text_of(para).contains("example.com")));
    let Some(Block::P(para)) = neighbor else {
        panic!("link paragraph missing: {:?}", after.imported.body);
    };
    let kept = para.inlines.iter().any(|inline| {
        matches!(
            inline,
            Inline::Atom { atom: Atom::Opaque { label, display, .. }, .. }
                if label == "bookmark" && display == "kept_bookmark"
        )
    });
    assert!(
        kept,
        "bookmark should sit on the previous paragraph: {:?}",
        para.inlines
    );
    assert_eq!(
        after.ledger.counts.get("bookmark:kept_bookmark").copied(),
        Some(1)
    );
}

fn text_of_block(block: &Block) -> String {
    match block {
        Block::P(para) => text_of(para),
        _ => String::new(),
    }
}

#[test]
fn bold_set_and_cleared() {
    mark_roundtrip(
        2,
        |marks| marks.bold = Some(true),
        3,
        |marks| marks.bold = None,
        |marks| marks.bold,
    );
}

#[test]
fn italic_set_and_cleared() {
    mark_roundtrip(
        2,
        |marks| marks.italic = Some(true),
        4,
        |marks| marks.italic = None,
        |marks| marks.italic,
    );
}

#[test]
fn underline_set_and_cleared() {
    mark_roundtrip(
        2,
        |marks| marks.underline = Some(true),
        5,
        |marks| marks.underline = None,
        |marks| marks.underline,
    );
}

#[test]
fn strike_set_and_cleared() {
    mark_roundtrip(
        2,
        |marks| marks.strike = Some(true),
        6,
        |marks| marks.strike = None,
        |marks| marks.strike,
    );
}

fn mark_roundtrip(
    set_run: u32,
    set: impl Fn(&mut Marks),
    clear_run: u32,
    clear: impl Fn(&mut Marks),
    read: impl Fn(&Marks) -> Option<bool>,
) {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    edit_run_marks(&mut para, set_run, set);
    edit_run_marks(&mut para, clear_run, clear);
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    let para = para_by_src(&after.imported.body, 2);
    assert_eq!(read(marks_of(para, set_run)), Some(true));
    assert_eq!(read(marks_of(para, clear_run)), None);
}

fn marks_of(para: &Para, run: u32) -> &Marks {
    para.inlines
        .iter()
        .find_map(|inline| match inline {
            Inline::Text { marks, src, .. } if *src == Some(run) => Some(marks),
            _ => None,
        })
        .unwrap_or_else(|| panic!("run {run}"))
}

#[test]
fn font_set() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    edit_run_marks(&mut para, 10, |marks| marks.font = Some("Calibri".into()));
    edit_run_marks(&mut para, 2, |marks| marks.font = Some("Georgia".into()));
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    let para = para_by_src(&after.imported.body, 2);
    assert_eq!(marks_of(para, 10).font.as_deref(), Some("Calibri"));
    assert_eq!(marks_of(para, 2).font.as_deref(), Some("Georgia"));
}

#[test]
fn size_set() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    edit_run_marks(&mut para, 8, |marks| marks.size_pt = Some(18.0));
    edit_run_marks(&mut para, 2, |marks| marks.size_pt = Some(14.0));
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    let para = para_by_src(&after.imported.body, 2);
    assert_eq!(marks_of(para, 8).size_pt, Some(18.0));
    assert_eq!(marks_of(para, 2).size_pt, Some(14.0));
}

#[test]
fn paragraph_style() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 1).clone();
    para.props.style = Some("Title".into());
    let written = save(
        &session,
        &patch_replacing(&before.imported, 1, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        para_by_src(&after.imported.body, 1).props.style.as_deref(),
        Some("Title")
    );
}

#[test]
fn paragraph_alignment() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 0).clone();
    para.props.align = Some("center".into());
    let written = save(
        &session,
        &patch_replacing(&before.imported, 0, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        para_by_src(&after.imported.body, 0).props.align.as_deref(),
        Some("center")
    );
}

#[test]
fn new_list() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    para.props.numbering = Some(Some((-1, 0)));
    let mut patch = patch_replacing(&before.imported, 3, vec![changed_para(para)]);
    patch.new_lists.push((
        -1,
        ListDef {
            fresh: true,
            levels: vec![ListLevel {
                format: "bullet".into(),
                text: "•".into(),
                start: 1,
                indent_left_pt: 36.0,
                hanging_pt: 18.0,
            }],
        },
    ));
    let written = save(&session, &patch);
    let after = reopen(&written);
    let numbering = para_by_src(&after.imported.body, 3).props.numbering;
    let Some(Some((id, 0))) = numbering else {
        panic!("numbering {numbering:?}");
    };
    assert!(id > 0, "fresh list id {id}");
    assert!(
        after
            .imported
            .lists
            .iter()
            .any(|(list_id, _)| *list_id == id)
    );
}

#[test]
fn text_inside_a_table_cell() {
    let (session, before) = opened("basic.docx");
    let mut body = Vec::new();
    for block in &before.imported.body {
        if block_src(block) == Some(14) {
            let Block::Table(table) = block else {
                panic!("src 14 is not a table");
            };
            let mut table: Table = table.clone();
            let cell = &mut table.rows[1].cells[0];
            let Block::P(para) = &mut cell.blocks[0] else {
                panic!("cell");
            };
            set_run_text(
                para,
                para.inlines
                    .iter()
                    .find_map(|inline| match inline {
                        Inline::Text { src, .. } => *src,
                        _ => None,
                    })
                    .unwrap(),
                "Oranges",
            );
            body.push(PatchBlock::Changed(Block::Table(table)));
        } else {
            body.push(PatchBlock::Keep {
                keep: block_src(block).unwrap(),
            });
        }
    }
    let patch = Patch {
        body,
        sections: before.imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
    };
    let written = save(&session, &patch);
    let after = reopen(&written);
    let Block::Table(table) = after
        .imported
        .body
        .iter()
        .find(|block| block_src(block) == Some(14))
        .unwrap()
    else {
        panic!("table");
    };
    let Block::P(para) = &table.rows[1].cells[0].blocks[0] else {
        panic!("cell");
    };
    assert_eq!(text_of(para), "Oranges");
}

#[test]
fn remove_removable_opaque_block() {
    let bytes = opaque_docx();
    let session = Session::from_bytes(&bytes).expect("synthetic content control opens");
    let before = import::import(&Document::from_bytes(&bytes).unwrap());
    let opaque = before
        .imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::Opaque(opaque) if opaque.removable => Some(opaque.src),
            _ => None,
        })
        .expect("synthetic document has a removable opaque block");
    let mut patch = keep_patch(&before.imported);
    patch
        .body
        .retain(|block| !matches!(block, PatchBlock::Keep { keep } if *keep == opaque));
    let written = save(&session, &patch);
    let after = reopen(&written);
    assert!(
        after
            .imported
            .body
            .iter()
            .all(|block| !matches!(block, Block::Opaque(_)))
    );
    let removed_keys: Vec<_> = before
        .ledger
        .counts
        .keys()
        .filter(|key| key.starts_with("sdt:") && !after.ledger.counts.contains_key(*key))
        .collect();
    assert!(
        !removed_keys.is_empty(),
        "ledger should drop the content control: before {:?} after {:?}",
        before.ledger.counts,
        after.ledger.counts
    );
}

#[test]
fn preserve_edits_one_character_in_every_paragraph() {
    let bytes = fixture("preserve.docx");
    let session = Session::from_bytes(&bytes).unwrap();
    let before = import::import(&Document::from_bytes(&bytes).unwrap());
    let before_doc = Document::from_bytes(&bytes).unwrap();
    let before_marks = preserved_marks(&before_doc);
    let mut patch = keep_patch(&before.imported);
    for block in &mut patch.body {
        let PatchBlock::Keep { keep } = block else {
            continue;
        };
        let Block::P(para) = before
            .imported
            .body
            .iter()
            .find(|candidate| block_src(candidate) == Some(*keep))
            .unwrap()
            .clone()
        else {
            continue;
        };
        let mut para = para;
        assert!(
            edit_one_character(&mut para),
            "paragraph {} has no character",
            keep
        );
        *block = changed_para(para);
    }
    let written = save(&session, &patch);
    let after_doc = Document::from_bytes(&written).unwrap();
    let after = import::import(&after_doc);
    assert_eq!(after.ledger.counts, before.ledger.counts);
    assert_eq!(preserved_marks(&after_doc), before_marks);
    assert_ne!(after.imported, before.imported);
}

fn edit_one_character(para: &mut Para) -> bool {
    for inline in &mut para.inlines {
        let Inline::Text { text, .. } = inline else {
            continue;
        };
        let mut chars: Vec<char> = text.chars().collect();
        let Some(index) = chars.iter().position(|ch| *ch != '\t' && *ch != '\n') else {
            continue;
        };
        chars[index] = if chars[index] == 'X' { 'Y' } else { 'X' };
        *text = chars.into_iter().collect();
        return true;
    }
    false
}

fn preserved_marks(doc: &Document) -> (Vec<String>, Vec<String>) {
    let mut parts = vec![
        "/word/document.xml".to_string(),
        "/word/comments.xml".to_string(),
        "/word/footnotes.xml".to_string(),
        "/word/endnotes.xml".to_string(),
    ];
    if let Ok(stories) = doc.stories() {
        for story in stories {
            parts.push(story.part_name().to_string());
        }
    }
    parts.sort();
    parts.dedup();
    let mut chars = Vec::new();
    let mut colors = Vec::new();
    for part in parts {
        let Ok(xml) = doc.part_xml(&part) else {
            continue;
        };
        chars.extend(attr_values(&xml, "firstLineChars"));
        colors.extend(underline_colors(&xml));
    }
    chars.sort();
    colors.sort();
    (chars, colors)
}

fn attr_values(xml: &str, name: &str) -> Vec<String> {
    let key = format!("{name}=\"");
    let mut values = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find(&key) {
        let after = &rest[pos + key.len()..];
        let Some(end) = after.find('"') else { break };
        values.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    values
}

fn underline_colors(xml: &str) -> Vec<String> {
    let mut colors = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find(":u") {
        let after = &rest[pos + 2..];
        let boundary = after
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        if !boundary {
            rest = &rest[pos + 2..];
            continue;
        }
        let Some(end) = after.find('>') else { break };
        let tag = &after[..end];
        for name in ["color", "themeColor", "themeTint", "themeShade"] {
            if let Some(value) = attr_values(tag, name).into_iter().next() {
                colors.push(format!("{name}={value}"));
            }
        }
        rest = &after[end + 1..];
    }
    colors
}

#[test]
fn saving_twice_imports_equal_and_leaves_the_session() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    set_run_text(&mut para, 11, "Centered paragraph!");
    let patch = patch_replacing(&before.imported, 3, vec![changed_para(para)]);
    let first = save(&session, &patch);
    let second = save(&session, &patch);
    assert_eq!(reopen(&first).imported, reopen(&second).imported);
    assert_eq!(
        session.import(),
        serde_json::to_string(&before.imported).unwrap()
    );
    assert_eq!(session.ledger().counts, before.ledger.counts);
}

#[test]
fn broken_contract_returns_write() {
    let (session, before) = opened("basic.docx");
    let table = Table::new(None, vec![120.0], Vec::new());
    let patch = Patch {
        body: vec![PatchBlock::Changed(Block::Table(table))],
        sections: before.imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
    };
    let error = session
        .save_result(&serde_json::to_string(&patch).unwrap())
        .expect_err("inserted table");
    match error {
        BridgeError::Write { detail } => assert!(
            detail.to_ascii_lowercase().contains("inserted table"),
            "{detail}"
        ),
        other => panic!("expected Write, got {other:?}"),
    }
    assert_eq!(
        session.import(),
        serde_json::to_string(&before.imported).unwrap()
    );
}

#[test]
fn dropped_bookmark_returns_verify() {
    let (session, before) = opened("preserve.docx");
    let patch = keep_patch(&before.imported);
    let error = session
        .save_result_tampered(&serde_json::to_string(&patch).unwrap(), |doc| {
            let id = doc
                .bookmarks()
                .into_iter()
                .find_map(|bookmark| {
                    (bookmark.name() == Some("kept_bookmark"))
                        .then(|| bookmark.id())
                        .flatten()
                })
                .expect("kept_bookmark");
            doc.remove_story_bookmark(id).expect("drop bookmark");
        })
        .expect_err("verify");
    match error {
        BridgeError::Verify { first_difference } => {
            assert!(
                first_difference.contains("kept_bookmark"),
                "{first_difference}"
            );
        }
        other => panic!("expected Verify, got {other:?}"),
    }
}

#[test]
fn split_then_join_restores_the_import() {
    for name in ["basic.docx", "long.docx", "preserve.docx"] {
        let bytes = fixture(name);
        let base = Document::from_bytes(&bytes).expect(name);
        let indexes = verify::body_paragraph_indexes(&base);
        let workers = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1)
            .clamp(1, indexes.len().max(1));
        let mut chunks = vec![Vec::new(); workers];
        for (offset, index) in indexes.into_iter().enumerate() {
            chunks[offset % workers].push(index);
        }
        std::thread::scope(|scope| {
            for chunk in chunks {
                if chunk.is_empty() {
                    continue;
                }
                let bytes = bytes.clone();
                scope.spawn(move || split_join_indexes(name, &bytes, &chunk));
            }
        });
    }
}

fn split_join_indexes(name: &str, bytes: &[u8], indexes: &[usize]) {
    let base = Document::from_bytes(bytes).expect(name);
    let first = import::import(&base);
    for index in indexes {
        let run_count = {
            let paragraph_index = base.paragraph_index_of_content(*index).unwrap();
            base.paragraph(paragraph_index).unwrap().run_count()
        };
        for boundary in 0..=run_count {
            let mut trial = base.clone_for_staging();
            if trial.split_paragraph(*index, boundary).is_err() {
                continue;
            }
            trial
                .join_paragraphs(*index, ParagraphPropertyKeep::First)
                .unwrap_or_else(|error| {
                    panic!("{name} paragraph {index} boundary {boundary} join failed: {error}")
                });
            let again = import::import(&trial);
            assert_eq!(
                again.imported, first.imported,
                "{name} paragraph {index} boundary {boundary}"
            );
            assert_eq!(
                again.ledger.counts, first.ledger.counts,
                "{name} ledger paragraph {index} boundary {boundary}"
            );
        }
    }
}

fn opaque_docx() -> Vec<u8> {
    let document = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Before</w:t></w:r></w:p>
    <w:sdt>
      <w:sdtPr>
        <w:alias w:val="Note"/>
        <w:tag w:val="note"/>
        <w:id w:val="7"/>
      </w:sdtPr>
      <w:sdtContent>
        <w:p><w:r><w:t>Inside</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>
    <w:p><w:r><w:t>After</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>"#;
    let types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    let document_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#;
    stored_zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("word/_rels/document.xml.rels", document_rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ])
}

fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let offset = u32::try_from(out.len()).unwrap();
        let crc = crc32(data);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&u16::try_from(name_bytes.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        central.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        central.extend_from_slice(&u16::try_from(name_bytes.len()).unwrap().to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }
    let central_start = u32::try_from(out.len()).unwrap();
    let central_len = u32::try_from(central.len()).unwrap();
    let count = u16::try_from(files.len()).unwrap();
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_len.to_le_bytes());
    out.extend_from_slice(&central_start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}
