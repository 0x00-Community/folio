//! The staged ledger matches one `part_xml` call per part.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use rdocx::{Document, HdrFtrType, RunPosition, RunRange, StoryKind};
use rdocx_word_engine::verify::{self, Ledger};

fn fixture(name: &str) -> Document {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name);
    let bytes =
        std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    Document::from_bytes(&bytes).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// The previous ledger: body items, then one `part_xml` call per story part and note part.
fn reference(doc: &Document) -> Ledger {
    let mut counts = verify::body_counts(doc);
    if let Ok(stories) = doc.stories() {
        let mut parts = BTreeSet::new();
        for story in stories {
            if story.kind() == StoryKind::Body {
                continue;
            }
            if parts.insert(story.part_name().to_string()) {
                scan_part_xml(doc, story.part_name(), &mut counts);
            }
        }
    }
    for part in [
        "/word/comments.xml",
        "/word/footnotes.xml",
        "/word/endnotes.xml",
    ] {
        scan_part_xml(doc, part, &mut counts);
    }
    Ledger { counts }
}

fn scan_part_xml(doc: &Document, part: &str, counts: &mut BTreeMap<String, usize>) {
    let Ok(xml) = doc.part_xml(part) else {
        return;
    };
    verify::scan_xml(&xml, counts);
}

#[test]
fn staged_ledger_matches_part_xml() {
    for name in ["basic.docx", "long.docx", "preserve.docx", "tables.docx"] {
        let doc = fixture(name);
        assert_eq!(
            verify::ledger(&doc).counts,
            reference(&doc).counts,
            "{name}"
        );
    }
    let doc = document_with_header_footer_comment_and_footnote();
    let counts = verify::ledger(&doc).counts;
    assert_eq!(counts, reference(&doc).counts);
    assert_eq!(counts.get("bookmark:HeaderMark").copied(), Some(1));
    assert_eq!(counts.get("bookmark:FooterMark").copied(), Some(1));
    assert!(
        counts.keys().any(|key| key.starts_with("comment-part:")),
        "comment part was counted"
    );
    assert!(
        counts.keys().any(|key| key.starts_with("footnote-part:")),
        "footnote part was counted"
    );
}

fn document_with_header_footer_comment_and_footnote() -> Document {
    let mut doc = Document::new();
    let word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    doc.set_raw_header_with_images(
        format!(
            r#"<w:hdr xmlns:w="{word}"><w:p><w:bookmarkStart w:id="1" w:name="HeaderMark"/><w:r><w:t>Header</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p></w:hdr>"#
        )
        .into_bytes(),
        &[],
        HdrFtrType::Default,
    );
    doc.set_raw_footer_with_images(
        format!(
            r#"<w:ftr xmlns:w="{word}"><w:p><w:bookmarkStart w:id="2" w:name="FooterMark"/><w:r><w:t>Footer</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p></w:ftr>"#
        )
        .into_bytes(),
        &[],
        HdrFtrType::Default,
    );
    doc.add_paragraph("Body");
    doc.add_comment(
        RunRange {
            start: RunPosition {
                body_index: 0,
                run_index: 0,
            },
            end: RunPosition {
                body_index: 0,
                run_index: 1,
            },
        },
        "Ada",
        None,
        "A comment",
    )
    .expect("comment");
    let id = doc.add_footnote("A note");
    doc.last_paragraph_mut()
        .expect("body paragraph")
        .add_footnote_ref(id);
    doc
}
