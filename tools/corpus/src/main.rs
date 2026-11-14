//! Writes the fixture documents the editor is verified against: `cargo run --release -- <out dir>`.

use rdocx::{Alignment, BreakKind, Document, Length, ListLevel, RunRange, RunPosition};
use std::path::Path;

fn main() -> rdocx::Result<()> {
    let out = std::env::args().nth(1).unwrap_or_else(|| "fixtures".into());
    std::fs::create_dir_all(&out)?;
    basic(&Path::new(&out).join("basic.docx"))?;
    long(&Path::new(&out).join("long.docx"), 100)?;
    preserve(&Path::new(&out).join("preserve.docx"))?;
    Ok(())
}

fn picture() -> rdocx::Result<Vec<u8>> {
    let mut source = Document::new();
    source.add_paragraph("rdocx").set_alignment(Alignment::Center);
    source.set_page_size(Length::inches(2.0), Length::inches(1.0));
    source.set_margins(Length::inches(0.1), Length::inches(0.1), Length::inches(0.1), Length::inches(0.1));
    Ok(source.render_page_to_png_deterministic(0, 96.0)?.expect("one page"))
}

fn basic(path: &Path) -> rdocx::Result<()> {
    let mut doc = Document::new();
    doc.set_header("rdocx-acde fixture header");
    doc.set_footer("rdocx-acde fixture footer");
    doc.add_paragraph("Quarterly report").set_style("Title");
    doc.add_paragraph("Overview").set_style("Heading1");
    {
        let mut p = doc.add_paragraph("");
        p.add_run("Plain, ");
        p.add_run("bold, ").set_bold(true);
        p.add_run("italic, ").set_italic(true);
        p.add_run("underlined, ").set_underline(true);
        p.add_run("struck, ").set_strike(true);
        p.add_run("red, ").set_color("C00000");
        p.add_run("large, ").set_size(16.0);
        p.add_run("highlighted, ").set_highlight("yellow");
        p.add_run("Arial.").set_font("Arial");
    }
    doc.add_paragraph("Centered paragraph.").set_alignment(Alignment::Center);
    doc.add_paragraph("Right aligned paragraph.").set_alignment(Alignment::Right);
    doc.add_paragraph(
        "Justified paragraph that is long enough to wrap onto a second line so that justification is visible on the first line of the paragraph.",
    )
    .set_alignment(Alignment::Justify);
    doc.add_paragraph("Lists").set_style("Heading2");
    let bullets = doc.add_list_definition(&[ListLevel::bullet(), ListLevel::bullet()]);
    let numbers = doc.add_list_definition(&[ListLevel::decimal(), ListLevel::decimal()]);
    for (text, level) in [("First bullet", 0), ("Nested bullet", 1), ("Second bullet", 0)] {
        doc.add_paragraph(text).set_numbering(bullets, level);
    }
    for text in ["Step one", "Step two", "Step three"] {
        doc.add_paragraph(text).set_numbering(numbers, 0);
    }
    doc.add_paragraph("Table").set_style("Heading2");
    {
        let mut table = doc.add_table(3, 3);
        for (row, cells) in [["Item", "Qty", "Price"], ["Apples", "3", "1.20"], ["Pears", "5", "2.40"]].iter().enumerate() {
            for (col, text) in cells.iter().enumerate() {
                if let Some(mut cell) = table.cell(row, col) {
                    cell.set_text(text);
                }
            }
        }
    }
    doc.add_paragraph("Picture").set_style("Heading2");
    doc.add_picture(&picture()?, "picture.png", Length::inches(2.0), Length::inches(1.0));
    doc.add_paragraph("").add_run("").add_break(BreakKind::Page);
    doc.add_paragraph("第二章 中文内容").set_style("Heading1");
    {
        let mut p = doc.add_paragraph("");
        p.add_run("这是一段宋体正文，用来检查中文排版、换行和光标定位是否正确。").set_slot_font(rdocx::RunFontSlot::EastAsia, Some("宋体"));
        p.add_run("这一句是黑体加粗。").set_bold(true);
        p.add_run("Mixed 中英文 text 混排。");
    }
    {
        let mut p = doc.add_paragraph("");
        p.add_run("楷体段落：天津大学本科毕业设计（论文）答辩记录。").set_font("楷体");
    }
    for i in 1..=12 {
        doc.add_paragraph(&format!(
            "第{i}段：根据项目申报指南的要求，申报单位应当如实填写申报材料，并对材料的真实性负责。The quick brown fox jumps over the lazy dog."
        ));
    }
    doc.save(path)
}

fn long(path: &Path, pages: usize) -> rdocx::Result<()> {
    let mut doc = Document::new();
    for i in 0..pages * 6 {
        if i % 18 == 0 {
            doc.add_paragraph(&format!("Chapter {}", i / 18 + 1)).set_style("Heading1");
        }
        let mut p = doc.add_paragraph("");
        p.add_run(&format!("Paragraph {i}. "));
        p.add_run("The quick brown fox jumps over the lazy dog. ").set_bold(i % 3 == 0);
        p.add_run("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. 这是一段中文内容，用来测试长文档的排版性能。");
    }
    doc.save(path)
}

fn preserve(path: &Path) -> rdocx::Result<()> {
    let mut doc = Document::new();
    doc.add_paragraph("Preservation fixture").set_style("Heading1");
    doc.add_paragraph("A paragraph with a comment anchored on these words.");
    doc.add_comment_on_text("these words", 0, "Reviewer", Some("R"), "Keep this comment.", None)?;
    {
        let mut p = doc.add_paragraph("Page field: ");
        p.add_run("").add_field("PAGE", "1")?;
    }
    {
        let link = doc.add_hyperlink_relationship("https://example.com/");
        let mut p = doc.add_paragraph("Link: ");
        p.add_hyperlink("example.com", &link);
    }
    let body_index = doc.content_count();
    doc.add_paragraph("Bookmarked paragraph.");
    doc.add_bookmark(
        "kept_bookmark",
        RunRange { start: RunPosition { body_index, run_index: 0 }, end: RunPosition { body_index, run_index: 1 } },
    )?;
    doc.add_paragraph("An editable paragraph after the preserved content.");
    doc.save(path)
}
