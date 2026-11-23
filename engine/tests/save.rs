//! Save patches built from each fixture's import.

use std::path::PathBuf;

use rdocx::{Document, ParagraphPropertyKeep, TableBorderEdge};
use rdocx_word_engine::Session;
use rdocx_word_engine::import::{self, Import};
use rdocx_word_engine::verify;
use rdocx_word_engine::wire::{
    Atom, Block, BorderEdge, BorderStyleName, BridgeError, Cell, Inline, ListDef, ListLevel, Marks,
    MediaPart, Para, ParaProps, Patch, PatchBlock, Row, Section, Table, TableBorders,
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
        media: Vec::new(),
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
        media: Vec::new(),
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
fn enter_after_typing_splits_a_run_whose_pieces_are_not_slices() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    let blocks = vec![
        changed_para(para_text(&title, &[(0, "Hello 你好")])),
        changed_para(para_text(&title, &[(0, "Quarterly report")])),
    ];
    let written = save(&session, &patch_replacing(&before.imported, 0, blocks));
    let after = reopen(&written);
    assert_eq!(
        paragraph_texts(&after, 0, 2),
        vec!["Hello 你好", "Quarterly report"]
    );
    assert!(after.imported.body[..2].iter().all(|block| {
        matches!(block, Block::P(para) if para.props.style.as_deref() == Some("Title"))
    }));
}

#[test]
fn first_piece_longer_than_the_source_run() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    let longer = "Hello 你好 and more text";
    assert!(longer.chars().count() > "Quarterly report".chars().count());
    let mut same = title.clone();
    same.inlines = vec![piece(&title, 0, longer), piece(&title, 0, "!")];
    let written = save(
        &session,
        &patch_replacing(&before.imported, 0, vec![changed_para(same)]),
    );
    assert_eq!(
        text_of(para_by_src(&reopen(&written).imported.body, 0)),
        format!("{longer}!")
    );

    let blocks = vec![
        changed_para(para_text(&title, &[(0, longer)])),
        changed_para(para_text(&title, &[(0, "tail")])),
    ];
    let written = save(&session, &patch_replacing(&before.imported, 0, blocks));
    assert_eq!(
        paragraph_texts(&reopen(&written), 0, 2),
        vec![longer, "tail"]
    );
}

#[test]
fn empty_piece_of_a_source_run() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    for (first, second) in [("", "Quarterly report"), ("Hello 你好", "")] {
        let blocks = vec![
            changed_para(para_text(&title, &[(0, first)])),
            changed_para(para_text(&title, &[(0, second)])),
        ];
        let written = save(&session, &patch_replacing(&before.imported, 0, blocks));
        assert_eq!(
            paragraph_texts(&reopen(&written), 0, 2),
            vec![first, second]
        );
    }
}

#[test]
fn replaced_pieces_of_a_source_run() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    let blocks = vec![
        changed_para(para_text(&title, &[(0, "完全不同")])),
        changed_para(para_text(&title, &[(0, "totally-replaced-body-text")])),
    ];
    let written = save(&session, &patch_replacing(&before.imported, 0, blocks));
    assert_eq!(
        paragraph_texts(&reopen(&written), 0, 2),
        vec!["完全不同", "totally-replaced-body-text"]
    );
}

#[test]
fn three_pieces_of_one_run_in_three_paragraphs() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    let parts = [
        "12345678901234567",
        "abcdefghijklmnopq",
        "ABCDEFGHIJKLMNOPQ",
    ];
    let blocks = parts
        .iter()
        .map(|text| changed_para(para_text(&title, &[(0, text)])))
        .collect();
    let written = save(&session, &patch_replacing(&before.imported, 0, blocks));
    assert_eq!(
        paragraph_texts(&reopen(&written), 0, 3),
        parts.map(str::to_string).to_vec()
    );
}

#[test]
fn delete_across_a_table_joins_the_paragraphs() {
    let (session, before) = opened("basic.docx");
    let step = body_para(&before, 11).clone();
    let picture = body_para(&before, 24).clone();
    assert_eq!(text_of(&step), "Step two");
    assert_eq!(text_of(&picture), "Picture");
    let mut merged = step.clone();
    merged.inlines = vec![
        piece(&step, text_src(&step), "Step "),
        piece(&picture, text_src(&picture), "icture"),
    ];
    let written = save(
        &session,
        &patch_swapping(&before.imported, 11, 24, vec![changed_para(merged)]),
    );
    let after = reopen(&written);
    assert!(
        after
            .imported
            .body
            .iter()
            .all(|block| !matches!(block, Block::Table(_)))
    );
    assert_eq!(paragraph_texts(&after, 11, 1), vec!["Step icture"]);
    assert_eq!(after.imported.body.len(), before.imported.body.len() - 4);
    assert!(matches!(
        after.imported.body.get(12),
        Some(Block::P(para))
            if para.inlines.iter().any(|inline| matches!(inline, Inline::Atom { atom: Atom::Image { .. }, .. }))
    ));
}

#[test]
fn delete_across_an_image_and_a_page_break_joins_the_text() {
    let (session, before) = opened("basic.docx");
    let bullet = body_para(&before, 9).clone();
    let prose = body_para(&before, 28).clone();
    let mut merged = bullet.clone();
    let mut inlines = vec![piece(&bullet, text_src(&bullet), "Second ")];
    inlines.extend(prose.inlines.iter().cloned());
    merged.inlines = inlines;
    let written = save(
        &session,
        &patch_swapping(&before.imported, 9, 28, vec![changed_para(merged)]),
    );
    let after = reopen(&written);
    assert!(
        after
            .imported
            .body
            .iter()
            .all(|block| !matches!(block, Block::Table(_)))
    );
    assert!(after.imported.body.iter().all(|block| {
        let Block::P(para) = block else {
            return true;
        };
        para.inlines.iter().all(|inline| {
            !matches!(
                inline,
                Inline::Atom {
                    atom: Atom::PageBreak {},
                    ..
                }
            )
        })
    }));
    assert_eq!(
        paragraph_texts(&after, 9, 1),
        vec![
            "Second 这是一段宋体正文，用来检查中文排版、换行和光标定位是否正确。这一句是黑体加粗。Mixed 中英文 text 混排。"
        ]
    );
    assert_eq!(after.imported.body.len(), before.imported.body.len() - 10);
}

#[test]
fn joined_piece_moves_into_the_neighbor_paragraph() {
    let (session, before) = opened("basic.docx");
    let title = body_para(&before, 0).clone();
    let overview = body_para(&before, 1);
    let mut merged = title.clone();
    merged.inlines = vec![
        piece(&title, 0, "Quarterly report"),
        overview.inlines[0].clone(),
    ];
    let blocks = vec![
        changed_para(para_text(&title, &[(0, "Hello 你好")])),
        changed_para(merged),
    ];
    let written = save(&session, &patch_swapping(&before.imported, 0, 1, blocks));
    let after = reopen(&written);
    assert_eq!(
        paragraph_texts(&after, 0, 2),
        vec!["Hello 你好", "Quarterly reportOverview"]
    );
    assert_eq!(after.imported.body.len(), before.imported.body.len());
}

fn text_src(para: &Para) -> u32 {
    para.inlines
        .iter()
        .find_map(|inline| match inline {
            Inline::Text { src: Some(src), .. } => Some(*src),
            _ => None,
        })
        .expect("text run")
}

fn piece(para: &Para, src: u32, text: &str) -> Inline {
    let mut inline = para
        .inlines
        .iter()
        .find(|inline| matches!(inline, Inline::Text { src: Some(run), .. } if *run == src))
        .unwrap_or_else(|| panic!("run {src}"))
        .clone();
    let Inline::Text { text: slot, .. } = &mut inline else {
        unreachable!("run {src} is text");
    };
    *slot = text.to_string();
    inline
}

fn para_text(template: &Para, parts: &[(u32, &str)]) -> Para {
    let mut para = template.clone();
    para.inlines = parts
        .iter()
        .map(|(src, text)| piece(template, *src, text))
        .collect();
    para
}

fn paragraph_texts(imported: &Import, start: usize, count: usize) -> Vec<String> {
    imported
        .imported
        .body
        .iter()
        .skip(start)
        .take(count)
        .map(text_of_block)
        .collect()
}

fn patch_swapping(
    imported: &rdocx_word_engine::wire::Imported,
    from: u32,
    to: u32,
    blocks: Vec<PatchBlock>,
) -> Patch {
    let mut body = Vec::new();
    let mut placed = false;
    for block in &imported.body {
        let src = block_src(block).expect("src");
        if (from..=to).contains(&src) {
            if !placed {
                body.extend(blocks.clone());
                placed = true;
            }
        } else {
            body.push(PatchBlock::Keep { keep: src });
        }
    }
    assert!(placed, "paragraphs {from}..={to} were not in the body");
    Patch {
        body,
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: Vec::new(),
    }
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
fn two_fresh_decimal_lists_keep_distinct_ids() {
    let (session, before) = opened("basic.docx");
    let mut later = body_para(&before, 41).clone();
    later.props.numbering = Some(Some((-1, 0)));
    let bullet = body_para(&before, 9).clone();
    let prose = body_para(&before, 28).clone();
    let mut merged = bullet.clone();
    let mut inlines = vec![piece(&bullet, text_src(&bullet), "Second ")];
    inlines.extend(prose.inlines.iter().cloned());
    merged.inlines = inlines;
    // The list on the joined paragraph is not referenced until after the image
    // in the span is removed. That removal must not reuse the other list's id.
    merged.props.numbering = Some(Some((-2, 0)));
    let mut patch = patch_swapping(&before.imported, 9, 28, vec![changed_para(merged)]);
    for block in &mut patch.body {
        if let PatchBlock::Keep { keep: 41 } = block {
            *block = changed_para(later.clone());
        }
    }
    let level = ListLevel {
        format: "decimal".into(),
        text: "%1.".into(),
        start: 1,
        indent_left_pt: 36.0,
        hanging_pt: 18.0,
    };
    let definition = ListDef {
        fresh: true,
        levels: vec![level],
    };
    patch.new_lists = vec![(-2, definition.clone()), (-1, definition)];
    let written = save(&session, &patch);
    let after = reopen(&written);
    let numbering_of = |needle: &str| {
        after
            .imported
            .body
            .iter()
            .find_map(|block| match block {
                Block::P(para) if text_of(para).contains(needle) => Some(para.props.numbering),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing {needle}"))
    };
    let joined = numbering_of("Second 这是一段");
    let later_numbering = numbering_of("第12段");
    assert_ne!(joined, later_numbering, "lists collapsed: {joined:?}");
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
        media: Vec::new(),
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
fn cleared_table_cell_keeps_an_empty_paragraph() {
    let (session, before) = opened("basic.docx");
    let mut body = Vec::new();
    for block in &before.imported.body {
        if block_src(block) == Some(14) {
            let Block::Table(table) = block else {
                panic!("src 14 is not a table");
            };
            let mut table: Table = table.clone();
            let cell = &mut table.rows[1].cells[0];
            cell.blocks = vec![Block::P(Para::new(
                None,
                ParaProps::default(),
                Vec::new(),
                None,
                None,
            ))];
            body.push(PatchBlock::Changed(Block::Table(table)));
        } else {
            body.push(PatchBlock::Keep {
                keep: block_src(block).unwrap(),
            });
        }
    }
    let written = save(
        &session,
        &Patch {
            body,
            sections: before.imported.sections.clone(),
            new_lists: Vec::new(),
            added_styles: Vec::new(),
            media: Vec::new(),
        },
    );
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
    assert_eq!(text_of(para), "");
    assert_eq!(table.rows[1].cells[0].blocks.len(), 1);
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
fn reordered_rows_return_write() {
    let (session, before) = opened("basic.docx");
    let mut table = fixture_table(&before.imported).clone();
    table.rows.swap(0, 2);
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, table),
        "reordered rows",
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

fn patch_sections(imported: &rdocx_word_engine::wire::Imported, sections: Vec<Section>) -> Patch {
    let mut patch = keep_patch(imported);
    patch.sections = sections;
    patch
}

fn near(want: f64, got: f64) -> bool {
    (want - got).abs() < 0.05
}

fn assert_near(want: f64, got: f64, label: &str) {
    assert!(near(want, got), "{label}: want {want} got {got}");
}

fn assert_kept_section(got: &Section, had: &Section) {
    for index in 4..7 {
        assert_near(
            had.margins_pt[index],
            got.margins_pt[index],
            &format!("margin {index}"),
        );
    }
    assert_eq!(got.break_type, had.break_type);
    assert_eq!(got.title_page, had.title_page);
    assert_eq!(got.headers, had.headers);
    assert_eq!(got.footers, had.footers);
    assert_eq!(got.grid, had.grid);
    assert_eq!(got.src, had.src);
}

fn document_xml(bytes: &[u8]) -> String {
    Document::from_bytes(bytes)
        .expect("written bytes")
        .part_xml("/word/document.xml")
        .expect("document.xml")
}

fn assert_orient(xml: &str, value: &str) {
    let quoted = format!("orient=\"{value}\"");
    let apos = format!("orient='{value}'");
    assert!(
        xml.contains(&quoted) || xml.contains(&apos),
        "missing {value} orientation\n{}",
        xml_around(xml, "pgSz")
    );
}

fn xml_around(xml: &str, needle: &str) -> String {
    let Some(index) = xml.find(needle) else {
        return xml.chars().take(400).collect();
    };
    let start = index.saturating_sub(80);
    let end = (index + 160).min(xml.len());
    xml.get(start..end).unwrap_or("").to_string()
}

#[test]
fn page_setup_writes_margins() {
    for name in ["basic.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let had = before.imported.sections[0].clone();
        let mut sections = before.imported.sections.clone();
        sections[0].margins_pt[0] = 50.0;
        sections[0].margins_pt[1] = 60.0;
        sections[0].margins_pt[2] = 70.0;
        sections[0].margins_pt[3] = 80.0;
        let written = save(&session, &patch_sections(&before.imported, sections));
        let after = reopen(&written);
        let got = &after.imported.sections[0];
        assert_near(50.0, got.margins_pt[0], "top");
        assert_near(60.0, got.margins_pt[1], "right");
        assert_near(70.0, got.margins_pt[2], "bottom");
        assert_near(80.0, got.margins_pt[3], "left");
        assert_near(had.width_pt, got.width_pt, "width");
        assert_near(had.height_pt, got.height_pt, "height");
        assert_kept_section(got, &had);
        assert_eq!(after.ledger.counts, before.ledger.counts, "{name} ledger");
    }
}

#[test]
fn page_setup_writes_page_size() {
    for name in ["basic.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let had = before.imported.sections[0].clone();
        let mut sections = before.imported.sections.clone();
        let width = 11906.0 / 20.0;
        let height = 16838.0 / 20.0;
        sections[0].width_pt = width;
        sections[0].height_pt = height;
        let written = save(&session, &patch_sections(&before.imported, sections));
        let after = reopen(&written);
        let got = &after.imported.sections[0];
        assert_near(width, got.width_pt, "width");
        assert_near(height, got.height_pt, "height");
        for index in 0..4 {
            assert_near(had.margins_pt[index], got.margins_pt[index], "margin");
        }
        assert_kept_section(got, &had);
        assert_eq!(after.ledger.counts, before.ledger.counts, "{name} ledger");
    }
}

#[test]
fn page_setup_writes_landscape() {
    for name in ["basic.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let had = before.imported.sections[0].clone();
        let mut sections = before.imported.sections.clone();
        let width = 16838.0 / 20.0;
        let height = 11906.0 / 20.0;
        sections[0].width_pt = width;
        sections[0].height_pt = height;
        let written = save(&session, &patch_sections(&before.imported, sections));
        let after = reopen(&written);
        let got = &after.imported.sections[0];
        assert_near(width, got.width_pt, "width");
        assert_near(height, got.height_pt, "height");
        assert!(got.width_pt > got.height_pt, "{name} is landscape");
        assert_kept_section(got, &had);
        assert_eq!(after.ledger.counts, before.ledger.counts, "{name} ledger");
        assert_orient(&document_xml(&written), "landscape");
    }
}

fn plain_paragraph(body: &[Block]) -> &Para {
    body.iter()
        .find_map(|block| {
            let Block::P(para) = block else {
                return None;
            };
            if para.inlines.len() != 1 {
                return None;
            }
            let Inline::Text { text, .. } = &para.inlines[0] else {
                return None;
            };
            if text.chars().count() < 4 {
                return None;
            }
            Some(para)
        })
        .expect("plain paragraph")
}

fn with_mid_break(para: &Para) -> (Para, String, String) {
    let Inline::Text { text, marks, src } = &para.inlines[0] else {
        panic!("plain paragraph");
    };
    let mid = text.chars().count() / 2;
    let head: String = text.chars().take(mid).collect();
    let tail: String = text.chars().skip(mid).collect();
    let mut next = para.clone();
    next.inlines = vec![
        Inline::Text {
            text: head.clone(),
            marks: marks.clone(),
            src: *src,
        },
        Inline::Atom {
            atom: Atom::PageBreak {},
            src: None,
        },
        Inline::Text {
            text: tail.clone(),
            marks: marks.clone(),
            src: *src,
        },
    ];
    (next, head, tail)
}

#[test]
fn page_break_in_the_middle_of_a_paragraph_round_trips() {
    for name in ["basic.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let para = plain_paragraph(&before.imported.body);
        let src = para.src.expect("paragraph src");
        let original = text_of(para);
        let (next, head, tail) = with_mid_break(para);
        let patch = patch_replacing(&before.imported, src, vec![changed_para(next)]);
        let written = save(&session, &patch);
        let again = save(&session, &patch);
        assert_eq!(reopen(&written).imported, reopen(&again).imported);
        let after = reopen(&written);
        let got = para_by_src(&after.imported.body, src);
        match &got.inlines[..] {
            [
                Inline::Text { text: got_head, .. },
                Inline::Atom {
                    atom: Atom::PageBreak {},
                    ..
                },
                Inline::Text { text: got_tail, .. },
            ] => {
                assert_eq!(got_head, &head, "{name} head");
                assert_eq!(got_tail, &tail, "{name} tail");
                assert_eq!(format!("{got_head}{got_tail}"), original, "{name} text");
            }
            other => panic!("{name} page break inlines {other:?}"),
        }
        assert_eq!(after.ledger.counts, before.ledger.counts, "{name} ledger");
    }
}

#[test]
fn page_setup_changes_only_the_named_section() {
    let mut doc = Document::from_bytes(&fixture("basic.docx")).expect("basic");
    doc.insert_section(1).expect("second section");
    let bytes = doc.to_bytes().expect("bytes");
    let session = Session::from_bytes(&bytes).expect("session");
    let before = import::import(&Document::from_bytes(&bytes).expect("import"));
    assert_eq!(before.imported.sections.len(), 2, "two sections");
    let mut sections = before.imported.sections.clone();
    let second = sections[1].clone();
    let width = 16838.0 / 20.0;
    let height = 11906.0 / 20.0;
    sections[0].width_pt = width;
    sections[0].height_pt = height;
    sections[0].margins_pt[0] = 50.0;
    let written = save(&session, &patch_sections(&before.imported, sections));
    let after = reopen(&written);
    let first = &after.imported.sections[0];
    assert_near(width, first.width_pt, "section 0 width");
    assert_near(height, first.height_pt, "section 0 height");
    assert!(first.width_pt > first.height_pt, "section 0 is landscape");
    let reread = Document::from_bytes(&written).expect("written");
    let orientation = reread.section(0).expect("section 0").orientation();
    assert!(
        format!("{orientation:?}").contains("Landscape"),
        "section 0 writes w:orient, got {orientation:?}"
    );
    assert_near(50.0, first.margins_pt[0], "section 0 top");
    assert_eq!(after.imported.sections[1], second);
    assert_eq!(after.ledger.counts, before.ledger.counts);
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

fn fixture_table(imported: &rdocx_word_engine::wire::Imported) -> &Table {
    imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::Table(table) if table.src == Some(14) => Some(table),
            _ => None,
        })
        .expect("basic.docx table")
}

fn table_patch(imported: &rdocx_word_engine::wire::Imported, table: Table) -> Patch {
    let mut body = Vec::new();
    let mut replaced = false;
    for block in &imported.body {
        if block_src(block) == Some(14) {
            body.push(PatchBlock::Changed(Block::Table(table.clone())));
            replaced = true;
        } else {
            body.push(PatchBlock::Keep {
                keep: block_src(block).expect("src"),
            });
        }
    }
    assert!(replaced, "the fixture table was not in the body");
    Patch {
        body,
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: Vec::new(),
    }
}

fn empty_para() -> Para {
    Para::new(None, ParaProps::default(), Vec::new(), None, None)
}

fn text_para(text: &str) -> Para {
    Para::new(
        None,
        ParaProps::default(),
        vec![Inline::Text {
            text: text.to_string(),
            marks: Marks::default(),
            src: None,
        }],
        None,
        None,
    )
}

fn blank_row(template: &Row) -> Row {
    Row {
        src: None,
        header: false,
        cant_split: false,
        height_pt: None,
        height_rule: None,
        cells: template
            .cells
            .iter()
            .map(|cell| Cell {
                src: None,
                span: cell.span,
                v_merge: None,
                blocks: vec![Block::P(empty_para())],
                borders: None,
                margins: None,
            })
            .collect(),
    }
}

fn row_with_text(template: &Row, text: &str) -> Row {
    let mut row = blank_row(template);
    row.cells[0].blocks = vec![Block::P(text_para(text))];
    row
}

fn fresh_table(rows: usize, cols: usize, width: f64) -> Table {
    let mut table_rows = Vec::new();
    for _ in 0..rows {
        table_rows.push(Row {
            src: None,
            header: false,
            cant_split: false,
            height_pt: None,
            height_rule: None,
            cells: (0..cols)
                .map(|_| Cell {
                    src: None,
                    span: 1,
                    v_merge: None,
                    blocks: vec![Block::P(empty_para())],
                    borders: None,
                    margins: None,
                })
                .collect(),
        });
    }
    let mut table = Table::new(None, vec![width; cols], table_rows);
    table.borders = Some(inserted_borders());
    table
}

fn inserted_line() -> BorderEdge {
    BorderEdge {
        style: BorderStyleName::Single,
        width_pt: 0.5,
        color: "000000".to_string(),
    }
}

fn inserted_borders() -> TableBorders {
    let edge = inserted_line();
    TableBorders {
        top: Some(edge.clone()),
        left: Some(edge.clone()),
        bottom: Some(edge.clone()),
        right: Some(edge.clone()),
        inside_h: Some(edge.clone()),
        inside_v: Some(edge),
    }
}

fn insert_block(
    imported: &rdocx_word_engine::wire::Imported,
    after: Option<u32>,
    block: Block,
) -> Patch {
    let mut body = Vec::new();
    if after.is_none() {
        body.push(PatchBlock::Changed(block.clone()));
    }
    for item in &imported.body {
        let src = block_src(item).expect("src");
        body.push(PatchBlock::Keep { keep: src });
        if after == Some(src) {
            body.push(PatchBlock::Changed(block.clone()));
        }
    }
    Patch {
        body,
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: Vec::new(),
    }
}

fn saved_twice(session: &Session, patch: &Patch) -> (Vec<u8>, Import) {
    let first = save(session, patch);
    let second = save(session, patch);
    let opened = reopen(&first);
    assert_eq!(opened.imported, reopen(&second).imported, "saving twice");
    (first, opened)
}

fn cell_text(table: &Table, row: usize, cell: usize) -> String {
    table.rows[row].cells[cell]
        .blocks
        .iter()
        .map(text_of_block)
        .collect()
}

fn row_texts(table: &Table, row: usize) -> Vec<String> {
    (0..table.rows[row].cells.len())
        .map(|cell| cell_text(table, row, cell))
        .collect()
}

fn only_table(imported: &rdocx_word_engine::wire::Imported) -> &Table {
    let tables: Vec<_> = imported
        .body
        .iter()
        .filter_map(|block| match block {
            Block::Table(table) => Some(table),
            _ => None,
        })
        .collect();
    assert_eq!(tables.len(), 1, "one body table");
    tables[0]
}

fn assert_grid(got: &[f64], want: &[f64]) {
    assert_eq!(got.len(), want.len(), "grid {got:?} vs {want:?}");
    for (index, (left, right)) in got.iter().zip(want).enumerate() {
        assert!(
            (left - right).abs() <= 0.05,
            "column {index}: {left} vs {right}"
        );
    }
}

fn assert_single_borders(bytes: &[u8], content_index: usize) {
    let doc = Document::from_bytes(bytes).expect("written bytes");
    let ordinal = doc
        .body_items()
        .take(content_index)
        .filter(|item| matches!(item, rdocx::BodyItemRef::Table(_)))
        .count();
    let table = doc.table(ordinal).expect("inserted table");
    for edge in [
        TableBorderEdge::Top,
        TableBorderEdge::Bottom,
        TableBorderEdge::Left,
        TableBorderEdge::Right,
        TableBorderEdge::InsideHorizontal,
        TableBorderEdge::InsideVertical,
    ] {
        assert_eq!(
            table.border(edge).map(|border| border.style()),
            Some("single"),
            "inserted table border"
        );
    }
}

fn assert_contract(session: &Session, before: &Import, patch: &Patch, needle: &str) {
    let error = session
        .save_result(&serde_json::to_string(patch).unwrap())
        .expect_err(needle);
    match error {
        BridgeError::Write { detail } => {
            assert!(detail.contains(needle), "{detail}");
            assert!(
                !detail.contains("inserted tables"),
                "old refusal leaked: {detail}"
            );
        }
        other => panic!("expected Write, got {other:?}"),
    }
    assert_eq!(
        session.import(),
        serde_json::to_string(&before.imported).unwrap()
    );
    assert_eq!(session.ledger().counts, before.ledger.counts);
}

fn set_cell_text(table: &mut Table, row: usize, cell: usize, text: &str) {
    let Block::P(para) = &mut table.rows[row].cells[cell].blocks[0] else {
        panic!("cell");
    };
    let src = para
        .inlines
        .iter()
        .find_map(|inline| match inline {
            Inline::Text { src, .. } => *src,
            _ => None,
        })
        .expect("run");
    set_run_text(para, src, text);
}

fn insert_grid_column(table: &mut Table, at: usize) {
    let width = table
        .grid_pt
        .get(at)
        .or_else(|| table.grid_pt.last())
        .copied()
        .unwrap_or(72.0);
    let at = at.min(table.grid_pt.len());
    table.grid_pt.insert(at, width);
    for row in &mut table.rows {
        let cell = Cell {
            src: None,
            span: 1,
            v_merge: None,
            blocks: vec![Block::P(empty_para())],
            borders: None,
            margins: None,
        };
        row.cells.insert(at.min(row.cells.len()), cell);
    }
}

#[test]
fn inserted_table_sits_between_paragraphs_at_the_edges_and_inside_a_split() {
    let (session, before) = opened("basic.docx");
    let width = 120.0;

    let (left_src, left_text, right_text) = before
        .imported
        .body
        .windows(2)
        .find_map(|pair| match pair {
            [Block::P(left), Block::P(right)] => {
                Some((left.src.expect("src"), text_of(left), text_of(right)))
            }
            _ => None,
        })
        .expect("two adjacent paragraphs");
    let between = insert_block(
        &before.imported,
        Some(left_src),
        Block::Table(fresh_table(1, 2, width)),
    );
    let (bytes, after) = saved_twice(&session, &between);
    let index = table_between(&after.imported.body, &left_text, &right_text);
    let Block::Table(table) = &after.imported.body[index] else {
        unreachable!("table");
    };
    assert_grid(&table.grid_pt, &[width, width]);
    assert_eq!(table.borders, Some(inserted_borders()));
    assert_single_borders(&bytes, index);

    let first_text = text_of_block(&before.imported.body[0]);
    let at_start = insert_block(
        &before.imported,
        None,
        Block::Table(fresh_table(1, 1, width)),
    );
    let (bytes, after) = saved_twice(&session, &at_start);
    assert!(matches!(after.imported.body[0], Block::Table(_)));
    assert_eq!(text_of_block(&after.imported.body[1]), first_text);
    assert_single_borders(&bytes, 0);

    let last_src = block_src(before.imported.body.last().expect("body")).expect("src");
    let last_text = text_of_block(before.imported.body.last().expect("body"));
    let at_end = insert_block(
        &before.imported,
        Some(last_src),
        Block::Table(fresh_table(1, 1, width)),
    );
    let (bytes, after) = saved_twice(&session, &at_end);
    let end = after.imported.body.len() - 1;
    assert!(matches!(after.imported.body[end], Block::Table(_)));
    assert_eq!(text_of_block(&after.imported.body[end - 1]), last_text);
    assert_single_borders(&bytes, end);

    let original = body_para(&before, 3).clone();
    let mut head = original.clone();
    head.inlines = vec![Inline::Text {
        text: "Cen".into(),
        marks: Marks::default(),
        src: Some(11),
    }];
    let mut tail = original;
    tail.inlines = vec![Inline::Text {
        text: "tered paragraph.".into(),
        marks: Marks::default(),
        src: Some(11),
    }];
    let mut table = fresh_table(2, 2, width);
    table.rows[0].cells[0].blocks = vec![Block::P(text_para("Inside"))];
    let split = patch_replacing(
        &before.imported,
        3,
        vec![
            changed_para(head),
            PatchBlock::Changed(Block::Table(table)),
            changed_para(tail),
        ],
    );
    let (bytes, after) = saved_twice(&session, &split);
    let index = table_between(&after.imported.body, "Cen", "tered paragraph.");
    let Block::Table(table) = &after.imported.body[index] else {
        unreachable!("table");
    };
    assert_eq!(cell_text(table, 0, 0), "Inside");
    assert_grid(&table.grid_pt, &[width, width]);
    assert_eq!(table.rows.len(), 2);
    assert_single_borders(&bytes, index);
}

fn table_between(body: &[Block], before: &str, after: &str) -> usize {
    body.iter()
        .enumerate()
        .find_map(|(index, block)| {
            if !matches!(block, Block::Table(_)) {
                return None;
            }
            let previous = index.checked_sub(1).map(|at| text_of_block(&body[at]));
            let next = body.get(index + 1).map(text_of_block);
            (previous.as_deref() == Some(before) && next.as_deref() == Some(after)).then_some(index)
        })
        .unwrap_or_else(|| {
            panic!(
                "table not between {before:?} and {after:?}: {:?}",
                body.iter().map(text_of_block).collect::<Vec<_>>()
            )
        })
}

#[test]
fn table_rows_insert_above_below_and_in_the_middle_and_delete() {
    let (session, before) = opened("basic.docx");
    let original = fixture_table(&before.imported);

    let mut above = original.clone();
    above
        .rows
        .insert(0, row_with_text(&original.rows[0], "Above"));
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, above));
    let table = only_table(&after.imported);
    assert_eq!(table.rows.len(), 4);
    assert_eq!(row_texts(table, 0), vec!["Above", "", ""]);
    assert_eq!(cell_text(table, 1, 0), "Item");
    assert_grid(&table.grid_pt, &original.grid_pt);

    let mut below = original.clone();
    below
        .rows
        .push(row_with_text(original.rows.last().expect("row"), "Below"));
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, below));
    let table = only_table(&after.imported);
    assert_eq!(table.rows.len(), 4);
    assert_eq!(cell_text(table, 2, 0), "Pears");
    assert_eq!(row_texts(table, 3), vec!["Below", "", ""]);

    let mut middle = original.clone();
    middle
        .rows
        .insert(1, row_with_text(&original.rows[1], "Middle"));
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, middle));
    let table = only_table(&after.imported);
    assert_eq!(cell_text(table, 0, 0), "Item");
    assert_eq!(row_texts(table, 1), vec!["Middle", "", ""]);
    assert_eq!(cell_text(table, 2, 0), "Apples");

    let mut deleted = original.clone();
    deleted.rows.remove(1);
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, deleted));
    let table = only_table(&after.imported);
    assert_eq!(table.rows.len(), 2);
    assert_eq!(cell_text(table, 0, 0), "Item");
    assert_eq!(cell_text(table, 1, 0), "Pears");
    assert_eq!(after.ledger.counts, before.ledger.counts);
}

#[test]
fn table_columns_insert_at_each_edge_and_in_the_middle_and_delete() {
    let (session, before) = opened("basic.docx");
    let original = fixture_table(&before.imported);

    let mut left = original.clone();
    insert_grid_column(&mut left, 0);
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, left.clone()));
    let table = only_table(&after.imported);
    assert_eq!(row_texts(table, 0), vec!["", "Item", "Qty", "Price"]);
    assert_eq!(row_texts(table, 1), vec!["", "Apples", "3", "1.20"]);
    assert_grid(&table.grid_pt, &left.grid_pt);

    let mut right = original.clone();
    insert_grid_column(&mut right, original.grid_pt.len());
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, right.clone()));
    let table = only_table(&after.imported);
    assert_eq!(row_texts(table, 0), vec!["Item", "Qty", "Price", ""]);
    assert_grid(&table.grid_pt, &right.grid_pt);

    let mut middle = original.clone();
    insert_grid_column(&mut middle, 1);
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, middle.clone()));
    let table = only_table(&after.imported);
    assert_eq!(row_texts(table, 0), vec!["Item", "", "Qty", "Price"]);
    assert_eq!(row_texts(table, 2), vec!["Pears", "", "5", "2.40"]);
    assert_grid(&table.grid_pt, &middle.grid_pt);

    let mut deleted = original.clone();
    deleted.grid_pt.remove(1);
    for row in &mut deleted.rows {
        row.cells.remove(1);
    }
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, deleted.clone()));
    let table = only_table(&after.imported);
    assert_eq!(row_texts(table, 0), vec!["Item", "Price"]);
    assert_eq!(row_texts(table, 1), vec!["Apples", "1.20"]);
    assert_eq!(row_texts(table, 2), vec!["Pears", "2.40"]);
    assert_grid(&table.grid_pt, &deleted.grid_pt);
    assert_eq!(after.ledger.counts, before.ledger.counts);
}

#[test]
fn table_row_column_and_text_save_together() {
    let (session, before) = opened("basic.docx");
    let mut table = fixture_table(&before.imported).clone();
    table.grid_pt.remove(1);
    for row in &mut table.rows {
        row.cells.remove(1);
    }
    set_cell_text(&mut table, 1, 0, "Oranges");
    table
        .rows
        .push(row_with_text(table.rows.last().expect("row"), "Mix"));
    let (_, after) = saved_twice(&session, &table_patch(&before.imported, table.clone()));
    let written = only_table(&after.imported);
    assert_eq!(row_texts(written, 0), vec!["Item", "Price"]);
    assert_eq!(row_texts(written, 1), vec!["Oranges", "1.20"]);
    assert_eq!(row_texts(written, 2), vec!["Pears", "2.40"]);
    assert_eq!(row_texts(written, 3), vec!["Mix", ""]);
    assert_grid(&written.grid_pt, &table.grid_pt);
}

#[test]
fn deleting_the_table_round_trips() {
    let (session, before) = opened("basic.docx");
    let mut patch = keep_patch(&before.imported);
    patch
        .body
        .retain(|block| !matches!(block, PatchBlock::Keep { keep } if *keep == 14));
    let (_, after) = saved_twice(&session, &patch);
    assert!(
        after
            .imported
            .body
            .iter()
            .all(|block| !matches!(block, Block::Table(_)))
    );
    assert_eq!(after.ledger.counts, before.ledger.counts);
}

#[test]
fn nested_table_before_the_edited_table_does_not_shift_the_edit() {
    let mut doc = Document::new();
    doc.add_paragraph("Before");
    {
        let mut outer = doc.add_table(1, 1);
        let mut cell = outer.cell(0, 0).expect("outer cell");
        cell.try_set_text("outer").expect("outer text");
        let mut nested = cell.add_table(1, 1);
        nested
            .cell(0, 0)
            .expect("nested cell")
            .try_set_text("nested-marker")
            .expect("nested text");
    }
    doc.add_paragraph("Between");
    {
        let mut second = doc.add_table(2, 1);
        second
            .cell(0, 0)
            .expect("second cell")
            .try_set_text("second-marker")
            .expect("second text");
        second
            .cell(1, 0)
            .expect("second row")
            .try_set_text("second-row")
            .expect("second row text");
    }
    // Finding 7 said table_mut counts nested tables. body.tables() does not:
    // the nested table is inside a cell, so the second body table is index 1.
    assert_eq!(
        doc.table_count(),
        2,
        "a nested table is not a table_mut index"
    );
    assert!(doc.table(2).is_none());
    let marker = doc
        .table(1)
        .expect("second table")
        .cell(0, 0)
        .expect("cell")
        .text();
    assert!(
        marker.contains("second-marker"),
        "table_mut(1) is the second body table, got {marker}"
    );
    let bytes = doc.to_bytes().expect("bytes");
    let session = Session::from_bytes(&bytes).expect("synthetic document");
    let before = import::import(&Document::from_bytes(&bytes).expect("reopen"));
    let mut edited = before
        .imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::Table(table) if table_text(table).contains("second-marker") => {
                Some(table.clone())
            }
            _ => None,
        })
        .expect("second table");
    let template = edited.rows.last().expect("row").clone();
    edited.rows.push(row_with_text(&template, "Added"));
    let src = edited.src.expect("table src");
    let patch = patch_replacing(
        &before.imported,
        src,
        vec![PatchBlock::Changed(Block::Table(edited))],
    );
    let (_, after) = saved_twice(&session, &patch);
    let second = after
        .imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::Table(table) if table_text(table).contains("second-marker") => Some(table),
            _ => None,
        })
        .expect("edited table");
    assert_eq!(second.rows.len(), 3, "the second body table gained the row");
    assert_eq!(cell_text(second, 2, 0), "Added");
    let outer = after
        .imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::Table(table) if table_text(table).contains("nested-marker") => Some(table),
            _ => None,
        })
        .expect("outer table");
    assert_eq!(
        outer.rows.len(),
        1,
        "the nested table did not take the edit"
    );
    let nested = nested_table(outer);
    assert_eq!(nested.rows.len(), 1);
    assert!(table_text(nested).contains("nested-marker"));
}

fn table_text(table: &Table) -> String {
    let mut text = String::new();
    for row in &table.rows {
        for cell in &row.cells {
            for block in &cell.blocks {
                match block {
                    Block::P(para) => text.push_str(&text_of(para)),
                    Block::Table(nested) => text.push_str(&table_text(nested)),
                    Block::Opaque(_) => {}
                }
            }
        }
    }
    text
}

fn nested_table(table: &Table) -> &Table {
    table
        .rows
        .iter()
        .flat_map(|row| row.cells.iter())
        .flat_map(|cell| cell.blocks.iter())
        .find_map(|block| match block {
            Block::Table(nested) => Some(nested),
            _ => None,
        })
        .expect("nested table")
}

#[test]
fn reordered_cells_merged_cells_and_a_fresh_nested_table_return_write() {
    let (session, before) = opened("basic.docx");
    let original = fixture_table(&before.imported);

    let mut cells = original.clone();
    cells.rows[0].cells.swap(0, 2);
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, cells),
        "reordered cells",
    );

    let mut span = original.clone();
    span.rows[0].cells[0].span = 2;
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, span),
        "merged cell span",
    );

    let mut merged = original.clone();
    merged.rows[1].cells[0].v_merge = Some("restart".to_string());
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, merged),
        "merged cell vMerge",
    );

    let mut both = original.clone();
    both.rows[0].cells[0].span = 2;
    both.rows[0].cells[0].v_merge = Some("continue".to_string());
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, both),
        "merged cell span and vMerge",
    );

    let mut nested = original.clone();
    nested.rows[0].cells[0]
        .blocks
        .insert(0, Block::Table(fresh_table(1, 1, 72.0)));
    assert_contract(
        &session,
        &before,
        &table_patch(&before.imported, nested),
        "fresh table inside a table cell",
    );

    let empty = Table::new(None, vec![120.0], Vec::new());
    assert_contract(
        &session,
        &before,
        &Patch {
            body: vec![PatchBlock::Changed(Block::Table(empty))],
            sections: before.imported.sections.clone(),
            new_lists: Vec::new(),
            added_styles: Vec::new(),
            media: Vec::new(),
        },
        "inserted table has no cells",
    );
}

#[test]
fn inserting_twenty_rows_prints_the_save_time() {
    let (session, before) = opened("basic.docx");
    let mut table = fixture_table(&before.imported).clone();
    let template = table.rows.last().expect("row").clone();
    for index in 0..20 {
        table
            .rows
            .push(row_with_text(&template, &format!("Row {index}")));
    }
    let patch = table_patch(&before.imported, table);
    let started = std::time::Instant::now();
    let written = save(&session, &patch);
    let elapsed = started.elapsed();
    println!("20 row insert save: {} ms", elapsed.as_millis());
    let after = reopen(&written);
    let table = only_table(&after.imported);
    assert_eq!(table.rows.len(), 23);
    assert_eq!(cell_text(table, 22, 0), "Row 19");
    let again = save(&session, &patch);
    assert_eq!(after.imported, reopen(&again).imported);
}

const PNG_W: f64 = 36.41;
const PNG_H: f64 = 18.205;
const JPEG_W: f64 = 20.2;
const JPEG_H: f64 = 15.7;

const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a,
    0x73, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x44, 0x0c, 0x10, 0x0a, 0x00, 0x1f, 0xee, 0x03, 0xfd, 0x8b, 0x5f, 0x14, 0xd4, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

const JPEG_BYTES: &[u8] = &[
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x0f, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x33, 0x2e, 0x31,
    0x2e, 0x31, 0x30, 0x32, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x0a, 0x0a, 0x0b, 0x0a, 0x0b,
    0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x10, 0x0f, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
    0x10, 0x10, 0x10, 0x12, 0x12, 0x12, 0x15, 0x15, 0x15, 0x12, 0x12, 0x12, 0x10, 0x10, 0x12, 0x12,
    0x14, 0x14, 0x15, 0x15, 0x17, 0x17, 0x17, 0x15, 0x15, 0x15, 0x15, 0x17, 0x17, 0x19, 0x19, 0x19,
    0x1e, 0x1e, 0x1c, 0x1c, 0x23, 0x23, 0x24, 0x2b, 0x2b, 0x33, 0xff, 0xc4, 0x00, 0x4c, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x06, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x06, 0x07, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00,
    0x08, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x8b, 0x00, 0x4d, 0x7f, 0x7f, 0xff, 0xd9,
];

#[test]
fn images_embed_once_in_a_paragraph_and_a_cell() {
    let (session, before) = opened("basic.docx");
    let title = with_image(&body_para(&before, 0).clone(), "jpeg", JPEG_W, JPEG_H);
    let centered = with_images(&body_para(&before, 3).clone(), "png", PNG_W, PNG_H, 2);
    let mut table = fixture_table(&before.imported).clone();
    let Block::P(cell_para) = &table.rows[0].cells[0].blocks[0] else {
        panic!("cell");
    };
    table.rows[0].cells[0].blocks[0] = Block::P(with_image(cell_para, "jpeg", JPEG_W, JPEG_H));
    let fresh = fresh_image_table();
    let mut patch = Patch {
        body: Vec::new(),
        sections: before.imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: vec![
            media_part("png", "pic.png", PNG_BYTES),
            media_part("jpeg", "pic.jpg", JPEG_BYTES),
            media_part("spare", "spare.png", PNG_BYTES),
        ],
    };
    for block in &before.imported.body {
        let src = block_src(block).expect("src");
        let changed = if src == 0 {
            Some(changed_para(title.clone()))
        } else if src == 3 {
            Some(changed_para(centered.clone()))
        } else if src == 14 {
            Some(PatchBlock::Changed(Block::Table(table.clone())))
        } else {
            None
        };
        patch
            .body
            .push(changed.unwrap_or(PatchBlock::Keep { keep: src }));
        if src == 3 {
            patch
                .body
                .push(PatchBlock::Changed(Block::Table(fresh.clone())));
        }
    }
    let (_bytes, after) = saved_twice(&session, &patch);
    assert_eq!(session.ledger().counts, before.ledger.counts);
    assert_eq!(
        after.media_bytes.len(),
        before.media_bytes.len() + 2,
        "one part per distinct key, and an unused part is not embedded"
    );

    let pngs = images_near(&after.imported.body, PNG_W);
    let jpegs = images_near(&after.imported.body, JPEG_W);
    assert_eq!(
        pngs.len(),
        3,
        "two uses in a paragraph and one in a fresh cell"
    );
    assert_eq!(jpegs.len(), 2, "a body paragraph and an existing cell");
    assert!(pngs.iter().all(|image| image.media == pngs[0].media));
    assert!(jpegs.iter().all(|image| image.media == jpegs[0].media));
    assert_ne!(pngs[0].media, jpegs[0].media);
    assert_eq!(part_bytes(&after, &pngs[0].media), PNG_BYTES);
    assert_eq!(part_bytes(&after, &jpegs[0].media), JPEG_BYTES);
    for image in &pngs {
        assert!(
            size_near(image.width, PNG_W) && size_near(image.height, PNG_H),
            "png {}x{} ",
            image.width,
            image.height
        );
    }
    for image in &jpegs {
        assert!(
            size_near(image.width, JPEG_W) && size_near(image.height, JPEG_H),
            "jpeg {}x{}",
            image.width,
            image.height
        );
    }

    assert_eq!(
        inline_shape(para_by_text(&after.imported.body, "Centered paragraph.")),
        "T I I T"
    );
    assert_eq!(
        inline_shape(para_by_text(&after.imported.body, "Quarterly report")),
        "T I T"
    );
    let index = table_between(
        &after.imported.body,
        "Centered paragraph.",
        "Right aligned paragraph.",
    );
    let Block::Table(inserted) = &after.imported.body[index] else {
        unreachable!("fresh table");
    };
    assert_eq!(cell_text(inserted, 0, 0), "LR");
    let Block::P(para) = &inserted.rows[0].cells[0].blocks[0] else {
        panic!("fresh cell");
    };
    assert_eq!(inline_shape(para), "T I T");

    let fixture = table_with_cell(&after.imported.body, "Apples");
    assert_eq!(cell_text(fixture, 0, 0), "Item");
    let Block::P(para) = &fixture.rows[0].cells[0].blocks[0] else {
        panic!("fixture cell");
    };
    assert_eq!(inline_shape(para), "T I T");

    let original = images_near(&after.imported.body, 144.0);
    assert_eq!(original.len(), 1, "the picture basic.docx already had");
    let previous = images_near(&before.imported.body, 144.0);
    assert_eq!(
        part_bytes(&after, &original[0].media),
        part_bytes(&before, &previous[0].media)
    );
}

#[test]
fn a_missing_image_key_names_the_key() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    para.inlines.push(image_inline("missing-pic", 10.0, 10.0));
    assert_contract(
        &session,
        &before,
        &patch_replacing(&before.imported, 3, vec![changed_para(para)]),
        "missing-pic",
    );
}

#[test]
fn deleting_an_imported_image_keeps_the_ledger() {
    let (session, before) = opened("basic.docx");
    let para = before
        .imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::P(para)
                if para.inlines.iter().any(|inline| {
                    matches!(
                        inline,
                        Inline::Atom {
                            atom: Atom::Image { .. },
                            ..
                        }
                    )
                }) =>
            {
                Some(para)
            }
            _ => None,
        })
        .expect("image");
    let src = para.src.expect("src");
    let mut edited = para.clone();
    edited.inlines.retain(|inline| {
        !matches!(
            inline,
            Inline::Atom {
                atom: Atom::Image { .. },
                ..
            }
        )
    });
    let written = save(
        &session,
        &patch_replacing(&before.imported, src, vec![changed_para(edited)]),
    );
    let after = reopen(&written);
    assert!(images_near(&after.imported.body, 144.0).is_empty());
    assert_eq!(after.ledger.counts, before.ledger.counts);
    assert_eq!(session.ledger().counts, before.ledger.counts);
}

#[test]
fn inserting_an_image_in_preserve_keeps_the_ledger() {
    let (session, before) = opened("preserve.docx");
    let mut patch = insert_block(
        &before.imported,
        None,
        Block::P(Para::new(
            None,
            ParaProps::default(),
            vec![image_inline("png", 12.0, 8.0)],
            None,
            None,
        )),
    );
    patch.media = vec![media_part("png", "pic.png", PNG_BYTES)];
    let written = save(&session, &patch);
    let after = reopen(&written);
    assert_eq!(after.ledger.counts, before.ledger.counts);
    assert_eq!(session.ledger().counts, before.ledger.counts);
    assert_eq!(images_near(&after.imported.body, 12.0).len(), 1);
    let again = save(&session, &patch);
    assert_eq!(after.imported, reopen(&again).imported);
}

struct SeenImage {
    media: String,
    width: f64,
    height: f64,
}

fn with_image(para: &Para, key: &str, width: f64, height: f64) -> Para {
    with_images(para, key, width, height, 1)
}

fn with_images(para: &Para, key: &str, width: f64, height: f64, count: usize) -> Para {
    let mut next = para.clone();
    let mut inlines = Vec::new();
    let mut done = false;
    for inline in &para.inlines {
        if !done
            && let Inline::Text { text, marks, src } = inline
            && text.chars().count() >= 2
        {
            let mid = text.chars().count() / 2;
            let left: String = text.chars().take(mid).collect();
            let right: String = text.chars().skip(mid).collect();
            inlines.push(Inline::Text {
                text: left,
                marks: marks.clone(),
                src: *src,
            });
            for _ in 0..count {
                inlines.push(image_inline(key, width, height));
            }
            inlines.push(Inline::Text {
                text: right,
                marks: marks.clone(),
                src: *src,
            });
            done = true;
        } else {
            inlines.push(inline.clone());
        }
    }
    assert!(done, "no text to split");
    next.inlines = inlines;
    next
}

fn fresh_image_table() -> Table {
    let mut table = fresh_table(1, 1, 80.0);
    table.rows[0].cells[0].blocks = vec![Block::P(Para::new(
        None,
        ParaProps::default(),
        vec![
            Inline::Text {
                text: "L".into(),
                marks: Marks::default(),
                src: None,
            },
            image_inline("png", PNG_W, PNG_H),
            Inline::Text {
                text: "R".into(),
                marks: Marks::default(),
                src: None,
            },
        ],
        None,
        None,
    ))];
    table
}

fn image_inline(key: &str, width: f64, height: f64) -> Inline {
    Inline::Atom {
        atom: Atom::Image {
            media: key.to_string(),
            width_pt: width,
            height_pt: height,
        },
        src: None,
    }
}

fn media_part(key: &str, file_name: &str, bytes: &[u8]) -> MediaPart {
    MediaPart {
        key: key.to_string(),
        file_name: file_name.to_string(),
        base64: base64_encode(bytes),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let value = (u32::from(bytes[index]) << 16)
            | (u32::from(bytes[index + 1]) << 8)
            | u32::from(bytes[index + 2]);
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push(TABLE[(value & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let value = u32::from(bytes[index]) << 16;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let value = (u32::from(bytes[index]) << 16) | (u32::from(bytes[index + 1]) << 8);
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

fn images_near(blocks: &[Block], width: f64) -> Vec<SeenImage> {
    let mut found = Vec::new();
    walk_images(blocks, &mut found);
    found.retain(|image| (image.width - width).abs() < 0.05);
    found
}

fn walk_images(blocks: &[Block], out: &mut Vec<SeenImage>) {
    for block in blocks {
        match block {
            Block::P(para) => {
                for inline in &para.inlines {
                    if let Inline::Atom {
                        atom:
                            Atom::Image {
                                media,
                                width_pt,
                                height_pt,
                            },
                        ..
                    } = inline
                    {
                        out.push(SeenImage {
                            media: media.clone(),
                            width: *width_pt,
                            height: *height_pt,
                        });
                    }
                }
            }
            Block::Table(table) => {
                for row in &table.rows {
                    for cell in &row.cells {
                        walk_images(&cell.blocks, out);
                    }
                }
            }
            Block::Opaque(_) => {}
        }
    }
}

fn part_bytes<'a>(import: &'a Import, rel: &str) -> &'a [u8] {
    import
        .media_bytes
        .get(rel)
        .unwrap_or_else(|| panic!("missing media {rel}"))
        .1
        .as_slice()
}

fn size_near(got: f64, want: f64) -> bool {
    let written = (want * 12_700.0).round() / 12_700.0;
    (got - written).abs() < 1e-4 && (got - want).abs() < 0.05
}

fn para_by_text<'a>(body: &'a [Block], text: &str) -> &'a Para {
    body.iter()
        .find_map(|block| match block {
            Block::P(para) if text_of(para) == text => Some(para),
            _ => None,
        })
        .unwrap_or_else(|| panic!("paragraph {text}"))
}

fn inline_shape(para: &Para) -> String {
    para.inlines
        .iter()
        .map(|inline| match inline {
            Inline::Text { .. } => "T",
            Inline::Atom {
                atom: Atom::Image { .. },
                ..
            } => "I",
            _ => "?",
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn table_with_cell<'a>(body: &'a [Block], needle: &str) -> &'a Table {
    body.iter()
        .find_map(|block| match block {
            Block::Table(table)
                if table.rows.iter().any(|row| {
                    row.cells.iter().any(|cell| {
                        cell.blocks
                            .iter()
                            .any(|inner| text_of_block(inner).contains(needle))
                    })
                }) =>
            {
                Some(table)
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("table containing {needle}"))
}

fn paragraph_xml(xml: &str, text: &str) -> String {
    let at = xml
        .find(text)
        .unwrap_or_else(|| panic!("document has no {text:?}"));
    let start = xml[..at]
        .rfind("<w:p")
        .unwrap_or_else(|| panic!("no paragraph element before {text:?}"));
    let end = xml[at..]
        .find("</w:p>")
        .unwrap_or_else(|| panic!("no paragraph end after {text:?}"))
        + at
        + "</w:p>".len();
    xml[start..end].to_string()
}

fn paragraph_count(body: &[Block]) -> usize {
    body.iter()
        .filter(|block| matches!(block, Block::P(_)))
        .count()
}

/// A kept body paragraph followed by, or following, an empty changed paragraph of the same src.
fn keep_with_empty(
    imported: &rdocx_word_engine::wire::Imported,
    src: u32,
    empty_first: bool,
) -> Patch {
    let para = para_by_src(&imported.body, src);
    let empty = Para::new(para.src, para.props.clone(), Vec::new(), None, None);
    let mut blocks = vec![PatchBlock::Keep { keep: src }, changed_para(empty)];
    if empty_first {
        blocks.reverse();
    }
    patch_replacing(imported, src, blocks)
}

fn assert_keep_with_empty_saves(empty_first: bool) {
    let (session, before) = opened("basic.docx");
    let src = 3;
    let text = "Centered paragraph.";
    assert_eq!(text_of(body_para(&before, src)), text);
    let patch = keep_with_empty(&before.imported, src, empty_first);
    let written = save(&session, &patch);
    let original = paragraph_xml(&document_xml(&fixture("basic.docx")), text);
    let saved = paragraph_xml(&document_xml(&written), text);
    assert_eq!(saved, original, "kept paragraph xml");
    let after = reopen(&written);
    assert_eq!(
        paragraph_count(&after.imported.body),
        paragraph_count(&before.imported.body) + 1
    );
    let index = after
        .imported
        .body
        .iter()
        .position(|block| text_of_block(block) == text)
        .expect("kept paragraph");
    let neighbor = if empty_first {
        index
            .checked_sub(1)
            .expect("empty paragraph precedes the kept one")
    } else {
        index + 1
    };
    assert_eq!(text_of_block(&after.imported.body[neighbor]), "");
    assert_eq!(
        after.ledger.counts, before.ledger.counts,
        "an empty paragraph adds no unmodeled item"
    );
}

#[test]
fn kept_paragraph_followed_by_empty_paragraph_of_the_same_src() {
    assert_keep_with_empty_saves(false);
}

#[test]
fn empty_paragraph_of_the_same_src_precedes_kept_paragraph() {
    assert_keep_with_empty_saves(true);
}

#[test]
fn first_line_chars_round_trip() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    para.props.first_line_chars = Some(200);
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        para_by_src(&after.imported.body, 2).props.first_line_chars,
        Some(200)
    );

    let session = Session::from_bytes(&written).expect("reopen session");
    let imported = reopen(&written);
    let mut cleared = para_by_src(&imported.imported.body, 2).clone();
    cleared.props.first_line_chars = None;
    let again = save(
        &session,
        &patch_replacing(&imported.imported, 2, vec![changed_para(cleared)]),
    );
    let restored = reopen(&again);
    assert_eq!(
        para_by_src(&restored.imported.body, 2)
            .props
            .first_line_chars,
        None
    );
}

#[test]
fn line_spacing_at_least_round_trips() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 2).clone();
    para.props.line = Some(rdocx_word_engine::wire::LineSpacing::AtLeast { pt: 14.0 });
    let written = save(
        &session,
        &patch_replacing(&before.imported, 2, vec![changed_para(para)]),
    );
    let after = reopen(&written);
    assert_eq!(
        para_by_src(&after.imported.body, 2).props.line,
        Some(rdocx_word_engine::wire::LineSpacing::AtLeast { pt: 14.0 })
    );
}

#[test]
fn two_keeps_of_one_src_are_refused() {
    let (session, before) = opened("basic.docx");
    let src = 3;
    let mut patch = keep_patch(&before.imported);
    let index = patch
        .body
        .iter()
        .position(|block| matches!(block, PatchBlock::Keep { keep } if *keep == src))
        .expect("keep");
    patch.body.insert(index, PatchBlock::Keep { keep: src });
    assert_contract(&session, &before, &patch, "block 3 appears twice");
}

#[test]
fn fresh_resized_picture_saves_and_reopens() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    para.inlines.push(image_inline("png", 40.2, 15.7));
    let mut patch = patch_replacing(&before.imported, 3, vec![changed_para(para)]);
    patch.media = vec![media_part("png", "pic.png", PNG_BYTES)];
    let written = save(&session, &patch);
    let after = reopen(&written);
    let found = images_near(&after.imported.body, 40.2);
    assert_eq!(
        found.len(),
        1,
        "the resized picture is in the reopened file"
    );
    assert!(size_near(found[0].height, 15.7), "{}", found[0].height);
    assert_eq!(after.ledger.counts, before.ledger.counts);
    assert!(
        inline_shape(para_by_src(&after.imported.body, 3)).contains('I'),
        "the picture stays in its paragraph"
    );
}

#[test]
fn fresh_moved_picture_saves_in_the_target_paragraph() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 4).clone();
    para.inlines.insert(0, image_inline("png", 36.41, 18.205));
    let mut patch = patch_replacing(&before.imported, 4, vec![changed_para(para)]);
    patch.media = vec![media_part("png", "pic.png", PNG_BYTES)];
    let written = save(&session, &patch);
    let after = reopen(&written);
    let host = para_by_src(&after.imported.body, 4);
    assert!(
        inline_shape(host).starts_with('I'),
        "shape {}",
        inline_shape(host)
    );
    let found = images_near(&after.imported.body, 36.41);
    assert_eq!(found.len(), 1);
    assert!(size_near(found[0].height, 18.205), "{}", found[0].height);
    assert_eq!(after.ledger.counts, before.ledger.counts);
}

#[test]
fn file_picture_resize_changes_only_that_drawing_extent() {
    let (session, before) = opened("basic.docx");
    let media = part_bytes(&before, "rId1").to_vec();
    let original = drawings(&document_xml(&fixture("basic.docx")));
    let pictures = body_images(&before.imported.body);
    assert_eq!(pictures.len(), 1, "basic.docx has one picture");
    let picture = &pictures[0];
    let para_src = picture.para.expect("paragraph");
    let mut para = para_by_src(&before.imported.body, para_src).clone();
    resize_run(
        &mut para,
        picture.run.expect("run"),
        picture.width + 12.0,
        picture.height + 6.0,
    );
    let patch = patch_replacing(&before.imported, para_src, vec![changed_para(para)]);
    let written = save(&session, &patch);
    let after = reopen(&written);
    assert_eq!(after.ledger.counts, before.ledger.counts);
    assert_eq!(part_bytes(&after, "rId1"), media.as_slice());
    let saved = body_images(&after.imported.body);
    assert_eq!(saved.len(), 1);
    assert_eq!(
        saved[0].para, picture.para,
        "the picture stays in its paragraph"
    );
    assert!(
        size_near(saved[0].width, picture.width + 12.0),
        "{}",
        saved[0].width
    );
    assert!(
        size_near(saved[0].height, picture.height + 6.0),
        "{}",
        saved[0].height
    );
    let saved_drawings = drawings(&document_xml(&written));
    assert_eq!(saved_drawings.len(), original.len());
    assert_eq!(original.len(), 1);
    assert_ne!(saved_drawings[0], original[0], "the extent changed");
    assert_eq!(
        mask_drawing_sizes(&saved_drawings[0]),
        mask_drawing_sizes(&original[0]),
        "only the extent changed"
    );
}

#[test]
fn resizing_one_use_of_shared_media_keeps_the_other() {
    let (session, before) = opened("basic.docx");
    let mut para = body_para(&before, 3).clone();
    para.inlines.push(image_inline("png", 40.0, 20.0));
    para.inlines.push(image_inline("png", 30.0, 10.0));
    let mut seed = patch_replacing(&before.imported, 3, vec![changed_para(para)]);
    seed.media = vec![media_part("png", "pic.png", PNG_BYTES)];
    let written = save(&session, &seed);
    let held = Session::from_bytes(&written).expect("reopen");
    let imported = import::import(&Document::from_bytes(&written).expect("reopen"));
    let before_drawings = drawings(&document_xml(&written));
    let mut para = para_by_src(&imported.imported.body, 3).clone();
    let images = images_of(&para);
    let first = images
        .iter()
        .find(|image| (image.width - 40.0).abs() < 0.05)
        .expect("40pt picture");
    let second = images
        .iter()
        .find(|image| (image.width - 30.0).abs() < 0.05)
        .expect("30pt picture");
    assert_eq!(
        first.media, second.media,
        "the two pictures share one media part"
    );
    let media = part_bytes(&imported, &second.media).to_vec();
    resize_run(&mut para, first.run.expect("run"), 50.0, 25.0);
    let patch = patch_replacing(&imported.imported, 3, vec![changed_para(para)]);
    let resized = save(&held, &patch);
    let after = reopen(&resized);
    assert_eq!(part_bytes(&after, &second.media), media.as_slice());
    let again = images_of(para_by_src(&after.imported.body, 3));
    let wide = again
        .iter()
        .find(|image| size_near(image.width, 50.0))
        .expect("resized picture");
    let kept = again
        .iter()
        .find(|image| size_near(image.width, 30.0))
        .expect("the other use keeps its size");
    assert!(size_near(wide.height, 25.0), "{}", wide.height);
    assert!(size_near(kept.height, 10.0), "{}", kept.height);
    let kept_cx = emu_of(30.0);
    let kept_cy = emu_of(10.0);
    let after_drawings = drawings(&document_xml(&resized));
    let before_kept = drawing_sized(&before_drawings, kept_cx, kept_cy);
    let after_kept = drawing_sized(&after_drawings, kept_cx, kept_cy);
    assert_eq!(
        after_kept, before_kept,
        "the other drawing is byte for byte"
    );
    let before_changed = drawing_sized(&before_drawings, emu_of(40.0), emu_of(20.0));
    let after_changed = drawing_sized(&after_drawings, emu_of(50.0), emu_of(25.0));
    assert_ne!(after_changed, before_changed);
    assert_eq!(
        mask_drawing_sizes(after_changed),
        mask_drawing_sizes(before_changed)
    );
}

#[test]
fn file_picture_move_inside_its_paragraph_is_refused() {
    let (session, before) = opened("basic.docx");
    let mut seeded = body_para(&before, 3).clone();
    seeded.inlines.push(image_inline("png", 40.2, 15.7));
    let mut seed = patch_replacing(&before.imported, 3, vec![changed_para(seeded)]);
    seed.media = vec![media_part("png", "pic.png", PNG_BYTES)];
    let written = save(&session, &seed);
    let held = Session::from_bytes(&written).expect("reopen");
    let imported = import::import(&Document::from_bytes(&written).expect("reopen"));
    let mut para = para_by_src(&imported.imported.body, 3).clone();
    let taken = take_image(&mut para.inlines);
    para.inlines.insert(0, taken);
    let patch = patch_replacing(&imported.imported, 3, vec![changed_para(para)]);
    assert_contract(&held, &imported, &patch, "source order");
}

#[test]
fn file_picture_move_to_another_paragraph_or_cell_is_refused() {
    let (session, before) = opened("basic.docx");
    let pictures = body_images(&before.imported.body);
    let picture = pictures.first().expect("picture");
    let src = picture.para.expect("para");
    let mut source = para_by_src(&before.imported.body, src).clone();
    let taken = take_image(&mut source.inlines);
    let mut other = body_para(&before, 3).clone();
    other.inlines.push(taken.clone());
    let mut table = fixture_table(&before.imported).clone();
    let Block::P(cell_para) = &mut table.rows[0].cells[0].blocks[0] else {
        panic!("cell");
    };
    cell_para.inlines.push(taken);
    let mut body = Vec::new();
    for block in &before.imported.body {
        let block_src = block_src(block).expect("src");
        if block_src == src {
            body.push(changed_para(source.clone()));
        } else if block_src == 3 {
            body.push(changed_para(other.clone()));
        } else if block_src == 14 {
            body.push(PatchBlock::Changed(Block::Table(table.clone())));
        } else {
            body.push(PatchBlock::Keep { keep: block_src });
        }
    }
    let patch = Patch {
        body,
        sections: before.imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: Vec::new(),
    };
    assert_contract(&session, &before, &patch, "source order");
}

#[test]
fn resize_and_move_leave_the_fixture_ledgers_unchanged() {
    for name in ["basic.docx", "preserve.docx"] {
        let (session, before) = opened(name);
        let srcs = para_srcs(&before.imported.body);
        let src = *srcs.first().expect(name);
        let mut para = para_by_src(&before.imported.body, src).clone();
        para.inlines.push(image_inline("png", 40.2, 15.7));
        let mut patch = patch_replacing(&before.imported, src, vec![changed_para(para)]);
        patch.media = vec![media_part("png", "pic.png", PNG_BYTES)];
        let written = save(&session, &patch);
        let after = reopen(&written);
        assert_eq!(
            after.ledger.counts, before.ledger.counts,
            "{name} fresh resize"
        );
        assert_eq!(images_near(&after.imported.body, 40.2).len(), 1, "{name}");

        let target = srcs.get(1).copied().unwrap_or(src);
        let mut moved = para_by_src(&before.imported.body, target).clone();
        moved.inlines.insert(0, image_inline("png", 36.41, 18.205));
        let mut move_patch = patch_replacing(&before.imported, target, vec![changed_para(moved)]);
        move_patch.media = vec![media_part("png", "pic.png", PNG_BYTES)];
        let moved_bytes = save(&session, &move_patch);
        let moved_doc = reopen(&moved_bytes);
        assert_eq!(
            moved_doc.ledger.counts, before.ledger.counts,
            "{name} fresh move"
        );
        assert_eq!(
            images_near(&moved_doc.imported.body, 36.41).len(),
            1,
            "{name}"
        );

        if let Some(picture) = body_images(&before.imported.body).into_iter().next() {
            let para_src = picture.para.expect("para");
            let mut edited = para_by_src(&before.imported.body, para_src).clone();
            resize_run(
                &mut edited,
                picture.run.expect("run"),
                picture.width + 4.0,
                picture.height + 2.0,
            );
            let file_patch =
                patch_replacing(&before.imported, para_src, vec![changed_para(edited)]);
            let file_bytes = save(&session, &file_patch);
            let file_doc = reopen(&file_bytes);
            assert_eq!(
                file_doc.ledger.counts, before.ledger.counts,
                "{name} file resize"
            );
            let saved = body_images(&file_doc.imported.body)
                .into_iter()
                .find(|image| image.run == picture.run)
                .expect("resized file picture");
            assert!(size_near(saved.width, picture.width + 4.0), "{name}");
            assert!(size_near(saved.height, picture.height + 2.0), "{name}");
        }
    }
}

struct BodyImage {
    para: Option<u32>,
    run: Option<u32>,
    media: String,
    width: f64,
    height: f64,
}

fn body_images(blocks: &[Block]) -> Vec<BodyImage> {
    let mut out = Vec::new();
    fn walk(blocks: &[Block], out: &mut Vec<BodyImage>) {
        for block in blocks {
            match block {
                Block::P(para) => out.extend(images_of(para)),
                Block::Table(table) => {
                    for row in &table.rows {
                        for cell in &row.cells {
                            walk(&cell.blocks, out);
                        }
                    }
                }
                Block::Opaque(_) => {}
            }
        }
    }
    walk(blocks, &mut out);
    out
}

fn images_of(para: &Para) -> Vec<BodyImage> {
    para.inlines
        .iter()
        .filter_map(|inline| match inline {
            Inline::Atom {
                atom:
                    Atom::Image {
                        media,
                        width_pt,
                        height_pt,
                    },
                src,
            } => Some(BodyImage {
                para: para.src,
                run: *src,
                media: media.clone(),
                width: *width_pt,
                height: *height_pt,
            }),
            _ => None,
        })
        .collect()
}

fn para_srcs(blocks: &[Block]) -> Vec<u32> {
    blocks
        .iter()
        .filter_map(|block| match block {
            Block::P(para) => para.src,
            _ => None,
        })
        .collect()
}

fn emu_of(pt: f64) -> i64 {
    (pt * 12_700.0).round() as i64
}

fn drawings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<w:drawing") {
        let tail = &rest[start..];
        let Some(end) = tail.find("</w:drawing>") else {
            break;
        };
        out.push(tail[..end + "</w:drawing>".len()].to_string());
        rest = &tail[end + "</w:drawing>".len()..];
    }
    out
}

fn drawing_sized(drawings: &[String], cx: i64, cy: i64) -> &str {
    let width = format!("cx=\"{cx}\"");
    let height = format!("cy=\"{cy}\"");
    drawings
        .iter()
        .find(|drawing| drawing.contains(&width) && drawing.contains(&height))
        .map(String::as_str)
        .unwrap_or_else(|| panic!("no drawing {cx} by {cy}"))
}

fn mask_drawing_sizes(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('>') else {
            out.push_str(tail);
            break;
        };
        let tag = &tail[..=end];
        let local = tag_local_name(tag);
        if local == "extent" || local == "ext" || local == "effectExtent" {
            out.push('<');
            out.push_str(local);
            out.push('>');
        } else {
            out.push_str(tag);
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

fn tag_local_name(tag: &str) -> &str {
    let body = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_end_matches('>')
        .trim_end_matches('/');
    let name = body.split_whitespace().next().unwrap_or("");
    name.rsplit(':').next().unwrap_or(name)
}

fn resize_run(para: &mut Para, run: u32, width: f64, height: f64) {
    for inline in &mut para.inlines {
        if let Inline::Atom {
            atom:
                Atom::Image {
                    width_pt,
                    height_pt,
                    ..
                },
            src,
        } = inline
            && *src == Some(run)
        {
            *width_pt = width;
            *height_pt = height;
        }
    }
}

fn take_image(inlines: &mut Vec<Inline>) -> Inline {
    let index = inlines
        .iter()
        .position(|inline| {
            matches!(
                inline,
                Inline::Atom {
                    atom: Atom::Image { .. },
                    ..
                }
            )
        })
        .expect("image inline");
    inlines.remove(index)
}
