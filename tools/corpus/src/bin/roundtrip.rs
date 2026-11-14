//! Opens each .docx and saves it unchanged: `roundtrip <in.docx> <out.docx>`.
fn main() -> rdocx::Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args.next().expect("input path");
    let output = args.next().expect("output path");
    let mut doc = rdocx::Document::open(&input)?;
    doc.save(&output)
}
