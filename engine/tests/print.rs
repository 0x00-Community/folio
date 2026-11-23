//! Print layout of the fixtures, checked with poppler.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use rdocx_word_engine::Session;
use rdocx_word_engine::print::PrintFailure;
use rdocx_word_engine::print::{BlockPage, PrintLayout};
use rdocx_word_engine::wire::{
    Block, BridgeError, Imported, Inline, Marks, Para, ParaProps, Patch, PatchBlock,
};

const SONG_FACE: usize = 3;
const NEW_SENTENCE: &str = "印刷预览写入了新的中文句子";
const OLD_SENTENCE: &str = "这是一段宋体正文，用来检查中文排版、换行和光标定位是否正确。";

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn open(name: &str) -> Session {
    Session::from_bytes(&fixture(name)).unwrap_or_else(|error| panic!("open {name}: {error}"))
}

fn imported_of(session: &Session) -> Imported {
    serde_json::from_str(&session.import()).expect("import json")
}

fn block_src(block: &Block) -> u32 {
    match block {
        Block::P(para) => para.src.expect("paragraph src"),
        Block::Table(table) => table.src.expect("table src"),
        Block::Opaque(opaque) => opaque.src,
    }
}

fn keep_patch(imported: &Imported) -> Patch {
    Patch {
        body: imported
            .body
            .iter()
            .map(|block| PatchBlock::Keep {
                keep: block_src(block),
            })
            .collect(),
        sections: imported.sections.clone(),
        new_lists: Vec::new(),
        added_styles: Vec::new(),
        media: Vec::new(),
    }
}

fn patch_json(patch: &Patch) -> String {
    serde_json::to_string(patch).expect("patch json")
}

fn body_para(imported: &Imported, src: u32) -> Para {
    imported
        .body
        .iter()
        .find_map(|block| match block {
            Block::P(para) if para.src == Some(src) => Some(para.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("paragraph {src}"))
}

fn set_run_text(para: &mut Para, run: u32, text: &str) {
    for inline in &mut para.inlines {
        if let Inline::Text {
            text: slot, src, ..
        } = inline
            && *src == Some(run)
        {
            *slot = text.to_owned();
            return;
        }
    }
    panic!("run {run}");
}

fn paragraph_text(para: &Para) -> String {
    para.inlines
        .iter()
        .filter_map(|inline| match inline {
            Inline::Text { text, .. } => Some(text.as_str()),
            Inline::Atom { .. } => None,
        })
        .collect()
}

fn body_paragraphs(imported: &Imported) -> Vec<String> {
    imported
        .body
        .iter()
        .filter_map(|block| match block {
            Block::P(para) => Some(paragraph_text(para)),
            _ => None,
        })
        .filter(|text| !strip_ws(text).is_empty())
        .collect()
}

fn strip_ws(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn has_han(text: &str) -> bool {
    text.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c))
}

/// Drop the fixture's running header and footer so a paragraph that crosses a
/// page stays contiguous in `pdftotext` output.
fn readable(text: &str) -> String {
    let stripped = strip_ws(text);
    ["rdocx-acdefixtureheader", "rdocx-acdefixturefooter"]
        .into_iter()
        .fold(stripped, |text, furniture| text.replace(furniture, ""))
}

fn contains_in_order(haystack: &str, parts: &[String]) -> Result<(), String> {
    let mut rest = haystack;
    for part in parts {
        let part = strip_ws(part);
        if part.is_empty() {
            continue;
        }
        match rest.find(&part) {
            Some(at) => {
                let next = at + part.len();
                rest = rest
                    .get(next..)
                    .ok_or_else(|| format!("split after {part}"))?;
            }
            None => {
                let preview: String = rest.chars().take(60).collect();
                return Err(format!("missing {part} before {preview}"));
            }
        }
    }
    Ok(())
}

fn cjk_font() -> Vec<u8> {
    let path = std::env::var_os("WORD_TEST_CJK_FONT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/System/Library/Fonts/Supplemental/Songti.ttc"));
    match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => panic!(
            "WORD_TEST_CJK_FONT file is missing or unreadable at {}: {error}",
            path.display()
        ),
    }
}

fn song_face(bytes: &[u8]) -> Vec<u8> {
    let index = if bytes.starts_with(b"ttcf") {
        SONG_FACE
    } else {
        0
    };
    extract_face(bytes, index).unwrap_or_else(|error| panic!("extract face {index}: {error}"))
}

fn add_song(session: &mut Session, face: &[u8]) {
    session.add_font("宋体", b"not-a-font");
    session.add_font("宋体", face);
    session.add_font_alias("SimSun", "楷体");
    session.add_font_alias("SimSun", "宋体");
}

fn tool(name: &str, args: &[&str]) -> String {
    let path = PathBuf::from("/opt/homebrew/bin").join(name);
    let output = Command::new(&path)
        .args(args)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "run {} ({error}). pdffonts, pdftotext and pdfinfo are in /opt/homebrew/bin",
                path.display()
            )
        });
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!(
            "{} exited {}\n{stderr}\n{stdout}",
            path.display(),
            output.status
        );
    }
    stdout
}

fn write_pdf(name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join("rdocx-print").join(name);
    std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("temp {}: {error}", dir.display()));
    let path = dir.join("out.pdf");
    std::fs::write(&path, bytes)
        .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
    path
}

fn pdf_arg(path: &Path) -> &str {
    path.to_str()
        .unwrap_or_else(|| panic!("pdf path {}", path.display()))
}

fn pdffonts(path: &Path) -> String {
    tool("pdffonts", &[pdf_arg(path)])
}

fn pdftotext(path: &Path) -> String {
    tool("pdftotext", &["-enc", "UTF-8", pdf_arg(path), "-"])
}

fn pdfinfo(path: &Path) -> String {
    tool("pdfinfo", &[pdf_arg(path)])
}

fn info_pages(info: &str) -> u32 {
    info.lines()
        .find_map(|line| line.strip_prefix("Pages:"))
        .and_then(|rest| rest.trim().parse().ok())
        .unwrap_or_else(|| panic!("pdfinfo has no Pages line:\n{info}"))
}

struct ListedFont {
    name: String,
    embedded: bool,
}

fn listed_fonts(output: &str) -> Vec<ListedFont> {
    let mut lines = output.lines().filter(|line| !line.trim().is_empty());
    let header = lines.next().unwrap_or("");
    let emb_at = header.find("emb").unwrap_or(0);
    let _rule = lines.next();
    let mut fonts = Vec::new();
    for line in lines {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        if name.is_empty() || name.chars().all(|c| c == '-') {
            continue;
        }
        let emb = line
            .get(emb_at..)
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or("");
        fonts.push(ListedFont {
            name: name.to_owned(),
            embedded: emb == "yes",
        });
    }
    fonts
}

fn assert_all_embedded(output: &str) {
    let fonts = listed_fonts(output);
    assert!(!fonts.is_empty(), "pdffonts listed no fonts:\n{output}");
    assert!(
        fonts.iter().all(|font| font.embedded),
        "a font is not embedded:\n{output}"
    );
}

fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert!(
        bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']),
        "png signature"
    );
    assert_eq!(bytes.get(12..16), Some(b"IHDR".as_slice()), "png chunk");
    let width = bytes
        .get(16..20)
        .and_then(|raw| raw.try_into().ok())
        .map(u32::from_be_bytes)
        .expect("png width");
    let height = bytes
        .get(20..24)
        .and_then(|raw| raw.try_into().ok())
        .map(u32::from_be_bytes)
        .expect("png height");
    (width, height)
}

struct DecodedPng {
    width: u32,
    height: u32,
    color: png::ColorType,
    depth: png::BitDepth,
    pixels: Vec<u8>,
}

fn decode_png(bytes: &[u8], label: &str) -> DecodedPng {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .unwrap_or_else(|error| panic!("{label} png header: {error}"));
    let buffer_size = reader
        .output_buffer_size()
        .unwrap_or_else(|| panic!("{label} png buffer size overflow"));
    let mut pixels = vec![0; buffer_size];
    let info = reader
        .next_frame(&mut pixels)
        .unwrap_or_else(|error| panic!("{label} png frame: {error}"));
    let size = info.buffer_size();
    pixels.truncate(size);
    DecodedPng {
        width: info.width,
        height: info.height,
        color: info.color_type,
        depth: info.bit_depth,
        pixels,
    }
}

fn keep_layout(name: &str) -> PrintLayout {
    let session = open(name);
    let imported = imported_of(&session);
    session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{name}: {error:?}"))
}

fn assert_same_pixels(layout: &PrintLayout, doc: &str, page: u32, dpi: f64) {
    let label = format!("{doc} page {page} at {dpi} dpi");
    let encoded = layout
        .page_png(page, dpi)
        .unwrap_or_else(|error| panic!("{label}: {error:?}"));
    let reference = oxml_pdf::render_page_to_png(layout.layout_result(), page as usize, dpi)
        .unwrap_or_else(|| panic!("{label}: render_page_to_png returned none"));
    let encoded = decode_png(&encoded, &label);
    let reference = decode_png(&reference, &format!("{label} reference"));
    assert_eq!(
        (encoded.width, encoded.height, encoded.color, encoded.depth),
        (
            reference.width,
            reference.height,
            reference.color,
            reference.depth
        ),
        "{label} image info"
    );
    if encoded.pixels != reference.pixels {
        let index = encoded
            .pixels
            .iter()
            .zip(reference.pixels.iter())
            .position(|(left, right)| left != right);
        panic!(
            "{label} pixels differ at {index:?}: page_png {} bytes, render_page_to_png {} bytes",
            encoded.pixels.len(),
            reference.pixels.len()
        );
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

#[test]
fn refused_patch_matches_save() {
    let session = open("basic.docx");
    for patch in ["not json", r#"{"body":[],"sections":[]}"#] {
        let print_error = session.print_layout(patch).expect_err(patch);
        let save_error = session.save_result(patch).expect_err(patch);
        match (print_error, save_error) {
            (
                PrintFailure::Write(detail),
                BridgeError::Write {
                    detail: save_detail,
                },
            ) => assert_eq!(detail, save_detail, "{patch}"),
            (print_error, save_error) => {
                panic!("print {print_error:?}\nsave {save_error:?}")
            }
        }
    }
}

#[test]
fn basic_without_caller_font_uses_bundled_substitutes() {
    let session = open("basic.docx");
    let imported = imported_of(&session);
    let patch = patch_json(&keep_patch(&imported));
    let layout = session
        .print_layout(&patch)
        .unwrap_or_else(|error| panic!("{error:?}"));
    let section = imported.sections.first().expect("section");
    let (width, height) = layout.page_size(0).expect("page size");
    assert_eq!(width, section.width_pt);
    assert_eq!(height, section.height_pt);

    let png = layout.page_png(0, 144.0).expect("png");
    let (pixels_wide, pixels_high) = png_size(&png);
    assert_eq!(pixels_wide as f64, width * 2.0);
    assert_eq!(pixels_high as f64, height * 2.0);

    let first = layout.pdf().expect("pdf");
    let second = layout.pdf().expect("pdf again");
    assert_eq!(first, second, "pdf() on one layout is deterministic");
    assert!(first.starts_with(b"%PDF"));

    let path = write_pdf("basic-no-font", &first);
    let info = pdfinfo(&path);
    assert_eq!(layout.page_count(), info_pages(&info), "{info}");
    let fonts = pdffonts(&path);
    assert_all_embedded(&fonts);
    let text = pdftotext(&path);
    let plain = readable(&text);
    let paragraphs = body_paragraphs(&imported);
    let latin: Vec<String> = paragraphs
        .iter()
        .filter(|paragraph| !has_han(paragraph))
        .cloned()
        .collect();
    contains_in_order(&plain, &latin).unwrap_or_else(|error| panic!("{error}\n{text}"));

    let faces = layout.fonts();
    assert!(
        faces.iter().all(|font| font.embedded),
        "layout font without bytes: {faces:?}"
    );
    println!(
        "no caller font families: {}",
        faces
            .iter()
            .map(|font| font.family.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("no caller font pdftotext:\n{text}");
    println!("no caller font chinese paragraphs:");
    for paragraph in paragraphs.iter().filter(|paragraph| has_han(paragraph)) {
        println!("found={} {paragraph}", plain.contains(&strip_ws(paragraph)));
    }

    let again = session
        .print_layout(&patch)
        .unwrap_or_else(|error| panic!("{error:?}"));
    let again_pdf = again.pdf().expect("second layout pdf");
    let again_path = write_pdf("basic-no-font-again", &again_pdf);
    assert_eq!(pdftotext(&path), pdftotext(&again_path));
}

#[test]
fn page_png_matches_render_page_to_png_pixels() {
    for name in ["basic.docx", "tables.docx"] {
        let layout = keep_layout(name);
        let pages = layout.page_count();
        assert!(pages > 0, "{name} has no pages");
        for page in 0..pages {
            for dpi in [96.0, 144.0] {
                assert_same_pixels(&layout, name, page, dpi);
            }
        }
    }

    let layout = keep_layout("long.docx");
    let pages = layout.page_count();
    assert!(pages > 0, "long.docx has no pages");
    let middle = pages / 2;
    let last = pages - 1;
    for page in [0, middle, last] {
        for dpi in [96.0, 144.0] {
            assert_same_pixels(&layout, "long.docx", page, dpi);
        }
    }
}

#[test]
fn layout_shares_session_font_bytes() {
    let mut session = open("basic.docx");
    let face = song_face(&cjk_font());
    add_song(&mut session, &face);
    session.add_font("UnusedFace", b"unused-face-bytes-not-shared");
    let imported = imported_of(&session);
    let layout = session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    let used = session.font_strong_count("宋体").expect("song face");
    let unused = session
        .font_strong_count("UnusedFace")
        .expect("unused face");
    assert!(
        used > 1,
        "a face the text uses stays shared while the layout is alive: {used}"
    );
    assert_eq!(unused, 1, "an unused face is not held by the layout");
    drop(layout);
    assert_eq!(session.font_strong_count("宋体"), Some(1));
    assert_eq!(session.font_strong_count("UnusedFace"), Some(1));
}

#[test]
fn basic_with_songti_face_embeds_the_face_and_the_text() {
    let collection = cjk_font();
    let face = song_face(&collection);
    let ps_name = name_string(&face, 6).unwrap_or_else(|error| panic!("postscript name: {error}"));
    // Name ID 6 is `STSongti-SC-Light`. The PDF writer sanitizes the family
    // (`Songti SC` → `SongtiSC`) and does not use the PostScript name.
    let family = name_string(&face, 16)
        .or_else(|_| name_string(&face, 1))
        .unwrap_or_else(|error| panic!("family name: {error}"));
    let prefix: String = family
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let prefix = if prefix.is_empty() {
        "Font".to_owned()
    } else {
        prefix
    };
    println!("extracted face {SONG_FACE} PostScript name {ps_name}; PDF family prefix {prefix}");

    let mut session = open("basic.docx");
    add_song(&mut session, &face);
    let imported = imported_of(&session);
    let layout = session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    let pdf = layout.pdf().expect("pdf");
    let path = write_pdf("basic-songti", &pdf);
    let fonts = pdffonts(&path);
    assert_all_embedded(&fonts);
    let listed = listed_fonts(&fonts);
    assert!(
        listed
            .iter()
            .any(|font| font.name.starts_with(&ps_name) || font.name.starts_with(&prefix)),
        "no font name starts with {ps_name} or {prefix}:\n{fonts}"
    );
    let text = readable(&pdftotext(&path));
    contains_in_order(&text, &body_paragraphs(&imported))
        .unwrap_or_else(|error| panic!("{error}\n{fonts}\n{}", pdftotext(&path)));
}

#[test]
fn edited_paragraph_is_in_the_pdf_and_the_session_is_unchanged() {
    let face = song_face(&cjk_font());
    let mut session = open("basic.docx");
    add_song(&mut session, &face);
    let imported = imported_of(&session);
    let before_import = session.import();
    let before_text = session.text();
    let mut para = body_para(&imported, 28);
    set_run_text(&mut para, 35, NEW_SENTENCE);
    set_run_text(&mut para, 36, "");
    set_run_text(&mut para, 37, "");
    let mut patch = keep_patch(&imported);
    let mut replaced = false;
    for block in &mut patch.body {
        if let PatchBlock::Keep { keep } = block
            && *keep == 28
        {
            *block = PatchBlock::Changed(Block::P(para.clone()));
            replaced = true;
        }
    }
    assert!(replaced, "paragraph 28");
    let layout = session
        .print_layout(&patch_json(&patch))
        .unwrap_or_else(|error| panic!("{error:?}"));
    let text = readable(&pdftotext(&write_pdf(
        "basic-edited",
        &layout.pdf().expect("pdf"),
    )));
    assert!(
        text.contains(&strip_ws(NEW_SENTENCE)),
        "pdf missing the new sentence:\n{text}"
    );
    assert!(
        !text.contains(&strip_ws(OLD_SENTENCE)),
        "pdf still has the old sentence"
    );
    assert_eq!(session.import(), before_import);
    assert_eq!(session.text(), before_text);
    let saved = session
        .save_result(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("save: {error:?}"));
    let reopened = Session::from_bytes(&saved).expect("reopen");
    assert_eq!(reopened.import(), before_import);
    assert!(reopened.text().contains(OLD_SENTENCE));
    assert!(!reopened.text().contains(NEW_SENTENCE));
}

#[test]
fn collection_versus_extracted_face() {
    let collection = cjk_font();
    let face = song_face(&collection);
    let extracted = attempt("extracted face", &face);
    let whole = attempt("whole ttc", &collection);
    println!("finding 8: {extracted}");
    println!("finding 8: {whole}");
    assert!(
        extracted.starts_with("extracted face works"),
        "extracted face did not produce a PDF\n{extracted}\n{whole}"
    );
}

fn attempt(label: &str, face: &[u8]) -> String {
    let face = face.to_vec();
    let label_owned = label.to_owned();
    let run = catch_unwind(AssertUnwindSafe(move || render_song(&label_owned, &face)));
    match run {
        Ok(Ok(summary)) => summary,
        Ok(Err(error)) => error,
        Err(payload) => format!("{label} panicked: {}", panic_message(&*payload)),
    }
}

fn render_song(label: &str, face: &[u8]) -> Result<String, String> {
    let mut session = open("basic.docx");
    add_song(&mut session, face);
    let imported = imported_of(&session);
    let layout = session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .map_err(|error| format!("{label} failed: {error:?}"))?;
    let pdf = layout
        .pdf()
        .map_err(|error| format!("{label} pdf failed: {error:?}"))?;
    if !pdf.starts_with(b"%PDF") {
        return Err(format!("{label} pdf has no header"));
    }
    let path = write_pdf(&label.replace(' ', "-"), &pdf);
    let fonts = pdffonts(&path);
    let text = readable(&pdftotext(&path));
    let song = text.contains(&strip_ws(OLD_SENTENCE));
    let embedded = listed_fonts(&fonts).iter().all(|font| font.embedded);
    if !song || !embedded {
        return Err(format!(
            "{label} failed: song_text={song} all_embedded={embedded}\n{fonts}"
        ));
    }
    Ok(format!(
        "{label} works: pages {} fonts {}",
        layout.page_count(),
        listed_fonts(&fonts)
            .iter()
            .map(|font| font.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn assert_block_boxes(layout: &PrintLayout, body_len: usize) {
    let boxes = layout.block_boxes();
    let pages = layout.block_pages();
    assert_eq!(boxes.len(), body_len, "one box list per body block");
    assert_eq!(pages.len(), boxes.len());
    for (index, entry) in boxes.iter().enumerate() {
        assert_eq!(entry.index as usize, index);
        let page = &pages[index];
        assert_eq!(page.index, entry.index);
        let mut previous = None;
        for fragment in &entry.fragments {
            assert!(
                fragment.height > 0.0,
                "block {index} fragment height {}",
                fragment.height
            );
            assert!(fragment.y.is_finite(), "block {index} y is not finite");
            assert!(
                fragment.page < layout.page_count(),
                "block {index} fragment page {} is past the last page",
                fragment.page
            );
            if let Some(earlier) = previous {
                assert!(
                    fragment.page >= earlier,
                    "block {index} fragment page {} follows {earlier}",
                    fragment.page
                );
            }
            previous = Some(fragment.page);
        }
        match (
            page.first_page,
            entry.fragments.first(),
            entry.fragments.last(),
        ) {
            (None, None, None) => {}
            (Some(first), Some(start), Some(end)) => {
                assert_eq!(start.page, first, "block {index} first fragment");
                assert_eq!(
                    end.page,
                    page.last_page.expect("last page"),
                    "block {index} last fragment"
                );
            }
            _ => panic!("block {index} pages and fragments disagree"),
        }
    }
}

fn assert_block_pages(layout: &PrintLayout, body_len: usize) {
    let pages = layout.block_pages();
    assert_eq!(pages.len(), body_len, "one entry per body block");
    let mut previous = None;
    for (index, entry) in pages.iter().enumerate() {
        assert_eq!(entry.index as usize, index);
        match (entry.first_page, entry.last_page) {
            (Some(first), Some(last)) => {
                assert!(last >= first, "block {index} ends before it starts");
                assert!(
                    last < layout.page_count(),
                    "block {index} is past the last page"
                );
                if let Some(earlier) = previous {
                    assert!(
                        first >= earlier,
                        "block {index} starts on page {first} after page {earlier}"
                    );
                }
                previous = Some(first);
            }
            (None, None) => {}
            _ => panic!("block {index} has only one of first and last page"),
        }
    }
    let last = pages.last().expect("body has a block");
    assert_eq!(
        last.last_page,
        Some(layout.page_count() - 1),
        "the last block ends on the last page"
    );
}

fn pdftotext_page(path: &Path, page: u32) -> String {
    let n = (page + 1).to_string();
    tool(
        "pdftotext",
        &["-enc", "UTF-8", "-f", &n, "-l", &n, pdf_arg(path), "-"],
    )
}

fn block_holding(body: &[Block], needle: &str) -> usize {
    body.iter()
        .position(|block| match block {
            Block::P(para) => paragraph_text(para).contains(needle),
            _ => false,
        })
        .unwrap_or_else(|| panic!("no paragraph holds {needle}"))
}

fn assert_paragraph_on_page(pages: &[BlockPage], body: &[Block], needle: &str, pdf: &Path) {
    let index = block_holding(body, needle);
    let page = pages[index]
        .first_page
        .unwrap_or_else(|| panic!("{needle} has no page"));
    let text = readable(&pdftotext_page(pdf, page));
    let flat = strip_ws(needle);
    assert!(
        text.contains(&flat),
        "page {} does not hold {flat}",
        page + 1
    );
}

fn inserted_paragraph(text: &str) -> Para {
    let props = ParaProps {
        page_break_before: Some(true),
        ..ParaProps::default()
    };
    Para::new(
        None,
        props,
        vec![Inline::Text {
            text: text.to_owned(),
            marks: Marks::default(),
            src: None,
        }],
        None,
        None,
    )
}

fn flat_block(block: &Block) -> String {
    match block {
        Block::P(para) => strip_ws(&paragraph_text(para)),
        Block::Table(table) => table
            .rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .flat_map(|cell| cell.blocks.iter())
            .find_map(|block| match block {
                Block::P(para) => Some(strip_ws(&paragraph_text(para))),
                _ => None,
            })
            .unwrap_or_default(),
        Block::Opaque(opaque) => strip_ws(&opaque.label),
    }
}

#[test]
fn block_pages_follow_the_body_and_an_insert_at_index_3() {
    let face = song_face(&cjk_font());
    let mut session = open("basic.docx");
    add_song(&mut session, &face);
    let imported = imported_of(&session);
    let layout = session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    assert_block_pages(&layout, imported.body.len());
    assert_block_boxes(&layout, imported.body.len());
    let pdf = write_pdf("basic-block-pages", &layout.pdf().expect("pdf"));
    assert_paragraph_on_page(layout.block_pages(), &imported.body, OLD_SENTENCE, &pdf);

    let displaced = flat_block(&imported.body[3]);
    assert!(
        displaced.chars().count() >= 8,
        "block 3 has no text to follow"
    );
    let displaced: String = displaced.chars().take(24).collect();
    let mut inserted = String::new();
    for _ in 0..80 {
        inserted.push_str("DRIFTINSERTMARK ");
        inserted.push_str(&"x".repeat(80));
        inserted.push(' ');
    }
    let mut patch = keep_patch(&imported);
    patch.body.insert(
        3,
        PatchBlock::Changed(Block::P(inserted_paragraph(&inserted))),
    );
    let again = session
        .print_layout(&patch_json(&patch))
        .unwrap_or_else(|error| panic!("{error:?}"));
    assert_eq!(again.block_pages().len(), imported.body.len() + 1);
    let before = layout.block_pages();
    let after = again.block_pages();
    for index in 0..3 {
        assert_eq!(
            after[index].first_page, before[index].first_page,
            "block {index} moved"
        );
    }
    let pdf = write_pdf("basic-block-pages-insert", &again.pdf().expect("pdf"));
    let new_page = after[3].first_page.expect("inserted block has a page");
    let new_text = readable(&pdftotext_page(&pdf, new_page));
    assert!(
        new_text.contains("DRIFTINSERTMARK"),
        "entry 3 is not the inserted paragraph"
    );
    assert!(
        !new_text.contains(&displaced),
        "entry 3 still holds the block that was at index 3"
    );
    let moved = after[4].first_page.expect("the shifted block has a page");
    let moved_text = readable(&pdftotext_page(&pdf, moved));
    assert!(
        moved_text.contains(&displaced),
        "entry 4 is not the block that was at index 3"
    );
    assert_ne!(new_page, moved, "the insert did not land on its own page");
}

struct MeasureLine {
    baseline: f64,
    han: bool,
    latin: bool,
    latin_families: Vec<String>,
    mixed_families: Vec<String>,
}

fn span_lines(layout: &PrintLayout, page: u32) -> Vec<MeasureLine> {
    let spans = layout.painted_spans();
    let mut lines: Vec<MeasureLine> = Vec::new();
    for span in spans.iter().filter(|span| span.page == page) {
        let han = has_han(&span.text);
        let latin = span.text.chars().any(|c| c.is_ascii_alphabetic());
        let mixed = han && latin;
        if let Some(line) = lines
            .iter_mut()
            .find(|line| (line.baseline - span.baseline).abs() < 0.75)
        {
            line.han |= han;
            line.latin |= latin;
            push_family(&mut line.latin_families, latin, &span.family);
            push_family(&mut line.mixed_families, mixed, &span.family);
        } else {
            lines.push(MeasureLine {
                baseline: span.baseline,
                han,
                latin,
                latin_families: if latin {
                    vec![span.family.clone()]
                } else {
                    Vec::new()
                },
                mixed_families: if mixed {
                    vec![span.family.clone()]
                } else {
                    Vec::new()
                },
            });
        }
    }
    lines.sort_by(|left, right| {
        left.baseline
            .partial_cmp(&right.baseline)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    lines
}

fn push_family(families: &mut Vec<String>, take: bool, family: &str) {
    if take && !families.iter().any(|had| had == family) {
        families.push(family.to_owned());
    }
}

fn report_lines(label: &str, lines: &[MeasureLine]) {
    let mut reported = 0;
    for (index, line) in lines.iter().enumerate() {
        let Some(previous) = index.checked_sub(1).and_then(|at| lines.get(at)) else {
            continue;
        };
        let pitch = line.baseline - previous.baseline;
        if !(8.0..40.0).contains(&pitch) {
            continue;
        }
        let kind = if line.han { "han" } else { "latin" };
        println!(
            "{label} {kind} pitch {pitch:.2} baseline {baseline:.2} latin_faces {} mixed_faces {}",
            line.latin_families.join("+"),
            line.mixed_families.join("+"),
            baseline = line.baseline,
        );
        reported += 1;
        if reported == 6 {
            break;
        }
    }
    if reported == 0 {
        println!("{label} no body line pitch in 8..40 pt");
    }
}

struct BBoxWord {
    y_min: f64,
    y_max: f64,
    han: bool,
    latin: bool,
}

fn bbox_words(xml: &str) -> Vec<BBoxWord> {
    let mut words = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<word ") {
        let after = &rest[start..];
        let Some(close) = after.find("</word>") else {
            break;
        };
        let Some(tag_end) = after.find('>') else {
            break;
        };
        let tag = &after[..tag_end];
        let text = &after[tag_end + 1..close];
        if let (Some(y_min), Some(y_max)) = (bbox_attr(tag, "yMin"), bbox_attr(tag, "yMax")) {
            words.push(BBoxWord {
                y_min,
                y_max,
                han: has_han(text),
                latin: text.chars().any(|c| c.is_ascii_alphabetic()),
            });
        }
        rest = &after[close + "</word>".len()..];
    }
    words
}

fn bbox_attr(tag: &str, name: &str) -> Option<f64> {
    let key = format!("{name}=\"");
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    tag[start..end].parse().ok()
}

fn report_bbox(label: &str, xml: &str) {
    let words = bbox_words(xml);
    println!("{label} bbox words {}", words.len());
    let mut lines: Vec<(f64, f64, bool, bool)> = Vec::new();
    for word in &words {
        if let Some(line) = lines
            .iter_mut()
            .find(|line| (line.0 - word.y_min).abs() < 1.5)
        {
            line.1 = line.1.max(word.y_max);
            line.2 |= word.han;
            line.3 |= word.latin;
        } else {
            lines.push((word.y_min, word.y_max, word.han, word.latin));
        }
    }
    lines.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut reported = 0;
    for pair in lines.windows(2) {
        let pitch = pair[1].0 - pair[0].0;
        if !(8.0..40.0).contains(&pitch) {
            continue;
        }
        let kind = if pair[1].2 { "han" } else { "latin" };
        let bottom = pair[1].1 - pair[0].1;
        println!("{label} bbox {kind} line-top {pitch:.2} bottom-delta {bottom:.2}");
        reported += 1;
        if reported == 4 {
            break;
        }
    }
}

fn render_page_png(pdf: &Path, page: u32, name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("rdocx-print").join(name);
    std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("temp {}: {error}", dir.display()));
    let prefix = dir.join("page");
    let prefix_arg = prefix
        .to_str()
        .unwrap_or_else(|| panic!("prefix {}", prefix.display()));
    let n = (page + 1).to_string();
    tool(
        "pdftoppm",
        &[
            "-f",
            &n,
            "-l",
            &n,
            "-png",
            "-r",
            "72",
            pdf_arg(pdf),
            prefix_arg,
        ],
    );
    std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "png"))
        .unwrap_or_else(|| panic!("pdftoppm wrote no png in {}", dir.display()))
}

fn letters(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphabetic()).collect()
}

/// Faces of glyph runs whose letters are a slice of `piece`.
fn faces_of_piece(layout: &PrintLayout, piece: &str) -> Vec<String> {
    let piece = letters(piece);
    let mut families = Vec::new();
    for span in layout.painted_spans() {
        let text = letters(&span.text);
        if text.chars().count() < 4 || !piece.contains(&text) {
            continue;
        }
        push_family(&mut families, true, &span.family);
    }
    families
}

fn faces_of_han(layout: &PrintLayout) -> Vec<String> {
    let mut families = Vec::new();
    for span in layout.painted_spans() {
        push_family(&mut families, has_han(&span.text), &span.family);
    }
    families
}

fn report_long_layout(label: &str, layout: &PrintLayout, body: &[Block], pdf_name: &str) {
    println!("{label} pages {}", layout.page_count());
    assert_block_pages(layout, body.len());
    let pdf = write_pdf(pdf_name, &layout.pdf().expect("pdf"));
    assert_paragraph_on_page(layout.block_pages(), body, "Paragraph 40.", &pdf);
    let fonts = pdffonts(&pdf);
    println!("{label} pdffonts:\n{fonts}");
    println!(
        "{label} fox faces {}",
        faces_of_piece(layout, "quick brown fox jumps").join("+")
    );
    println!(
        "{label} lorem faces {}",
        faces_of_piece(
            layout,
            "Lorem ipsum dolor sit amet consectetur adipiscing elit"
        )
        .join("+")
    );
    println!("{label} han faces {}", faces_of_han(layout).join("+"));
    let han_page = layout
        .painted_spans()
        .into_iter()
        .find(|span| has_han(&span.text))
        .map(|span| span.page);
    let paragraph_page = layout.block_pages()[block_holding(body, "Paragraph 40.")]
        .first_page
        .expect("Paragraph 40 has a page");
    let page = han_page.unwrap_or(paragraph_page);
    if han_page.is_none() {
        println!("{label} no painted han text");
    }
    let lines = span_lines(layout, page);
    println!(
        "{label} painted lines on page {}: {}",
        page + 1,
        lines.len()
    );
    report_lines(label, &lines);
    let n = (page + 1).to_string();
    let bbox = tool(
        "pdftotext",
        &[
            "-bbox",
            "-enc",
            "UTF-8",
            "-f",
            &n,
            "-l",
            &n,
            pdf_arg(&pdf),
            "-",
        ],
    );
    report_bbox(label, &bbox);
    let png = render_page_png(&pdf, page, pdf_name);
    println!("{label} page image {}", png.display());
}

#[test]
fn long_mixed_run_with_and_without_the_cjk_face() {
    let imported = imported_of(&open("long.docx"));
    let plain = open("long.docx");
    let without = plain
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    report_long_layout(
        "long-without-cjk",
        &without,
        &imported.body,
        "long-without-cjk",
    );

    let face = song_face(&cjk_font());
    let mut with_font = open("long.docx");
    add_song(&mut with_font, &face);
    let with = with_font
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    report_long_layout("long-with-cjk", &with, &imported.body, "long-with-cjk");
    println!(
        "finding 17 page counts: without {} with {}",
        without.page_count(),
        with.page_count()
    );
}

#[test]
fn long_document_lays_out_and_exports() {
    let session = open("long.docx");
    let imported = imported_of(&session);
    let started = Instant::now();
    let layout = session
        .print_layout(&patch_json(&keep_patch(&imported)))
        .unwrap_or_else(|error| panic!("{error:?}"));
    let layout_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let pdf = layout.pdf().expect("pdf");
    let pdf_ms = started.elapsed().as_millis();
    assert!(pdf.starts_with(b"%PDF"));
    assert!(layout.page_count() > 0);
    println!(
        "long.docx pages {} layout_ms {} pdf_ms {}",
        layout.page_count(),
        layout_ms,
        pdf_ms
    );
}

fn extract_face(bytes: &[u8], face_index: usize) -> Result<Vec<u8>, String> {
    let face_at = face_start(bytes, face_index)?;
    let directory = slice(bytes, face_at, 12)?;
    let table_count = usize::from(read_u16(directory, 4)?);
    if table_count == 0 {
        return Err("font face has no tables".into());
    }
    let records = slice(bytes, face_at + 12, table_count * 16)?;
    let mut tables = Vec::with_capacity(table_count);
    for index in 0..table_count {
        let at = index * 16;
        let name = tag(records, at)?;
        let offset = read_u32(records, at + 8)? as usize;
        let length = read_u32(records, at + 12)? as usize;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| format!("table {name} offset overflow"))?;
        if end > bytes.len() {
            return Err(format!("table {name} is truncated"));
        }
        let padded_len = length.saturating_add(3) & !3;
        let mut padded = vec![0u8; padded_len];
        padded[..length].copy_from_slice(
            bytes
                .get(offset..end)
                .ok_or_else(|| format!("table {name} is truncated"))?,
        );
        tables.push(FaceTable {
            name,
            length,
            bytes: padded,
        });
    }
    tables.sort_by(|left, right| left.name.cmp(&right.name));

    let table_bytes = u32::try_from(table_count)
        .map_err(|_| "too many tables".to_owned())?
        .checked_mul(16)
        .ok_or_else(|| "too many tables".to_owned())?;
    let mut search_range: u32 = 16;
    let mut entry_selector: u32 = 0;
    while search_range.saturating_mul(2) <= table_bytes {
        search_range *= 2;
        entry_selector += 1;
    }
    let range_shift = table_bytes - search_range;
    let mut offset = 12 + table_count * 16;
    let mut placed = Vec::with_capacity(tables.len());
    for table in tables {
        let at = offset;
        offset += table.bytes.len();
        placed.push((table, at));
    }
    if let Some((table, _)) = placed.iter_mut().find(|(table, _)| table.name == "head")
        && table.length >= 12
    {
        write_u32(&mut table.bytes, 8, 0)?;
    }

    let mut out = vec![0u8; offset];
    out.get_mut(..4)
        .ok_or_else(|| "font header".to_owned())?
        .copy_from_slice(directory.get(..4).ok_or_else(|| "font header".to_owned())?);
    write_u16(
        &mut out,
        4,
        u16::try_from(table_count).map_err(|_| "table count")?,
    )?;
    write_u16(
        &mut out,
        6,
        u16::try_from(search_range).map_err(|_| "search range")?,
    )?;
    write_u16(
        &mut out,
        8,
        u16::try_from(entry_selector).map_err(|_| "entry selector")?,
    )?;
    write_u16(
        &mut out,
        10,
        u16::try_from(range_shift).map_err(|_| "range shift")?,
    )?;
    let head_at = placed
        .iter()
        .find(|(table, _)| table.name == "head" && table.length >= 12)
        .map(|(_, at)| *at);
    for (index, (table, at)) in placed.iter().enumerate() {
        let record = 12 + index * 16;
        write_tag(&mut out, record, &table.name)?;
        write_u32(&mut out, record + 4, sum_u32(&table.bytes))?;
        write_u32(
            &mut out,
            record + 8,
            u32::try_from(*at).map_err(|_| "table offset")?,
        )?;
        write_u32(
            &mut out,
            record + 12,
            u32::try_from(table.length).map_err(|_| "table length")?,
        )?;
        let end = at
            .checked_add(table.bytes.len())
            .ok_or_else(|| "table placement".to_owned())?;
        out.get_mut(*at..end)
            .ok_or_else(|| "table placement".to_owned())?
            .copy_from_slice(&table.bytes);
    }
    if let Some(at) = head_at {
        let adjustment = 0xb1b0afbau32.wrapping_sub(sum_u32(&out));
        write_u32(&mut out, at + 8, adjustment)?;
    }
    Ok(out)
}

struct FaceTable {
    name: String,
    length: usize,
    bytes: Vec<u8>,
}

fn name_string(bytes: &[u8], name_id: u16) -> Result<String, String> {
    let tables = directory(bytes, 0)?;
    let (at, length) = tables
        .get("name")
        .copied()
        .ok_or_else(|| "font has no name table".to_owned())?;
    let name = slice(bytes, at, length)?;
    let count = usize::from(read_u16(name, 2)?);
    let storage = usize::from(read_u16(name, 4)?);
    let mut mac = None;
    let mut unicode = None;
    let mut unicode_en = None;
    for index in 0..count {
        let record = 6 + index * 12;
        let platform = read_u16(name, record)?;
        if read_u16(name, record + 6)? != name_id {
            continue;
        }
        let language = read_u16(name, record + 4)?;
        let len = usize::from(read_u16(name, record + 8)?);
        let start = storage + usize::from(read_u16(name, record + 10)?);
        let raw = name
            .get(
                start
                    ..start
                        .checked_add(len)
                        .ok_or_else(|| "name string".to_owned())?,
            )
            .ok_or_else(|| "name string truncated".to_owned())?;
        let text = decode_name(platform, raw);
        if text.is_empty() {
            continue;
        }
        if platform == 3 && language == 1033 {
            unicode_en = Some(text);
        } else if platform == 3 && unicode.is_none() {
            unicode = Some(text);
        } else if platform == 1 && mac.is_none() {
            mac = Some(text);
        }
    }
    unicode_en
        .or(unicode)
        .or(mac)
        .ok_or_else(|| format!("font has no name id {name_id}"))
}

fn decode_name(platform: u16, raw: &[u8]) -> String {
    let text = if platform == 0 || platform == 3 {
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .filter_map(|pair| {
                let bytes: [u8; 2] = pair.try_into().ok()?;
                Some(u16::from_be_bytes(bytes))
            })
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|byte| char::from(*byte)).collect()
    };
    text.trim_matches('\0').to_owned()
}

fn directory(
    bytes: &[u8],
    face_at: usize,
) -> Result<std::collections::BTreeMap<String, (usize, usize)>, String> {
    let header = slice(bytes, face_at, 12)?;
    let count = usize::from(read_u16(header, 4)?);
    let records = slice(bytes, face_at + 12, count * 16)?;
    let mut tables = std::collections::BTreeMap::new();
    for index in 0..count {
        let at = index * 16;
        let offset = read_u32(records, at + 8)? as usize;
        let length = read_u32(records, at + 12)? as usize;
        tables.insert(tag(records, at)?, (offset, length));
    }
    Ok(tables)
}

fn face_start(bytes: &[u8], face_index: usize) -> Result<usize, String> {
    let header = slice(bytes, 0, 12)?;
    if header.get(..4) != Some(b"ttcf".as_slice()) {
        if face_index != 0 {
            return Err(format!("face {face_index} is out of range"));
        }
        return Ok(0);
    }
    let count = read_u32(header, 8)? as usize;
    if face_index >= count {
        return Err(format!("face {face_index} is out of range ({count} faces)"));
    }
    let offsets = slice(bytes, 12, (face_index + 1) * 4)?;
    Ok(read_u32(offsets, face_index * 4)? as usize)
}

fn slice(bytes: &[u8], at: usize, len: usize) -> Result<&[u8], String> {
    let end = at
        .checked_add(len)
        .ok_or_else(|| "offset overflow".to_owned())?;
    bytes
        .get(at..end)
        .ok_or_else(|| format!("truncated at {at}+{len}"))
}

fn read_u16(bytes: &[u8], at: usize) -> Result<u16, String> {
    let raw = slice(bytes, at, 2)?;
    let raw: [u8; 2] = raw.try_into().map_err(|_| "short u16".to_owned())?;
    Ok(u16::from_be_bytes(raw))
}

fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    let raw = slice(bytes, at, 4)?;
    let raw: [u8; 4] = raw.try_into().map_err(|_| "short u32".to_owned())?;
    Ok(u32::from_be_bytes(raw))
}

fn tag(bytes: &[u8], at: usize) -> Result<String, String> {
    let raw = slice(bytes, at, 4)?;
    Ok(raw.iter().map(|byte| char::from(*byte)).collect())
}

fn write_u16(bytes: &mut [u8], at: usize, value: u16) -> Result<(), String> {
    bytes
        .get_mut(at..at + 2)
        .ok_or_else(|| format!("write u16 at {at}"))?
        .copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn write_u32(bytes: &mut [u8], at: usize, value: u32) -> Result<(), String> {
    bytes
        .get_mut(at..at + 4)
        .ok_or_else(|| format!("write u32 at {at}"))?
        .copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn write_tag(bytes: &mut [u8], at: usize, name: &str) -> Result<(), String> {
    let raw = name.as_bytes();
    if raw.len() != 4 {
        return Err(format!("tag {name}"));
    }
    bytes
        .get_mut(at..at + 4)
        .ok_or_else(|| format!("write tag at {at}"))?
        .copy_from_slice(raw);
    Ok(())
}

fn sum_u32(bytes: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in bytes.chunks_exact(4) {
        let mut word = [0u8; 4];
        word.copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}
