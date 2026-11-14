//! Appends one character to the first run of every body paragraph that has text, then saves: `editone <in> <out>`.
fn main() -> rdocx::Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args.next().expect("input path");
    let output = args.next().expect("output path");
    let mut doc = rdocx::Document::open(&input)?;
    let mut edited = 0;
    for index in 0..doc.paragraph_count() {
        if doc.paragraph(index).is_none_or(|p| p.text().is_empty()) { continue; }
        let Some(mut paragraph) = doc.paragraph_mut(index) else { continue };
        if let Some(mut run) = paragraph.run_mut(0) {
            if !run.text().is_empty() { run.add_text("字"); edited += 1; }
        }
    }
    eprintln!("edited {edited} paragraphs");
    doc.save(&output)
}
