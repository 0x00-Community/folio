use std::hint::black_box;
use std::time::Instant;

use rdocx::{Document, HdrFtrType};
use rdocx_word_engine::import::import;

fn main() {
    let (parse_500, import_500) = measure(500);
    let (parse_2000, import_2000) = measure(2000);
    println!("500 paragraphs: parse {parse_500:.1} ms, import {import_500:.1} ms");
    println!("2000 paragraphs: parse {parse_2000:.1} ms, import {import_2000:.1} ms");
    assert!(
        import_2000 < 100.0,
        "import at 2000 paragraphs took {import_2000:.1} ms"
    );
    assert!(
        import_2000 < import_500 * 5.0,
        "import grew from {import_500:.1} ms at 500 paragraphs to {import_2000:.1} ms at 2000"
    );
}

fn measure(paragraphs: usize) -> (f64, f64) {
    let mut doc = build(paragraphs);
    let bytes = doc.to_bytes().expect("serialize");
    black_box(import(&Document::from_bytes(&bytes).expect("warmup")));
    let started = Instant::now();
    let parsed = Document::from_bytes(&bytes).expect("parse");
    let parse_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let imported = import(&parsed);
    black_box(&imported);
    let import_ms = started.elapsed().as_secs_f64() * 1000.0;
    (parse_ms, import_ms)
}

fn build(paragraphs: usize) -> Document {
    let mut doc = Document::new();
    let mut section = 0usize;
    doc.set_header(&story_text("页眉", "Header", section));
    doc.set_raw_footer_with_images(footer_xml(section), &[], HdrFtrType::Default);
    for index in 0..paragraphs {
        {
            let mut paragraph = doc.add_paragraph(&format!(
                "第{index}段 The quick brown fox jumps 测量导入速度 {index}"
            ));
            if index == 0 {
                paragraph
                    .add_run("")
                    .add_field("TOC \\o \"1-3\" \\h \\z \\u", "目录")
                    .expect("toc field");
            }
            if index % 10 == 0 {
                paragraph
                    .add_run("")
                    .add_field("PAGEREF bookmark \\h", "1")
                    .expect("pageref field");
            }
        }
        if (index + 1) % 50 == 0 {
            let id = doc.add_footnote(&format!("注{index}"));
            doc.last_paragraph_mut()
                .expect("footnote paragraph")
                .add_footnote_ref(id);
        }
        if (index + 1) % 100 == 0 {
            let mut table = doc.add_table(4, 4);
            for row in 0..4 {
                for col in 0..4 {
                    let Some(mut cell) = table.cell(row, col) else {
                        continue;
                    };
                    cell.set_text(&format!("格{row}-{col} cell"));
                }
            }
        }
        if (index + 1) % 40 == 0 && index + 1 != paragraphs {
            doc.insert_section(doc.section_count())
                .expect("section break");
            section += 1;
            doc.set_header(&story_text("页眉", "Header", section));
            doc.set_raw_footer_with_images(footer_xml(section), &[], HdrFtrType::Default);
        }
    }
    doc
}

fn footer_xml(section: usize) -> Vec<u8> {
    let text = story_text("页脚", "Footer", section);
    format!(
        r#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{text}</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>"#
    )
    .into_bytes()
}

fn story_text(label: &str, english: &str, section: usize) -> String {
    format!("第{section}节{label} {english} {section}")
}
