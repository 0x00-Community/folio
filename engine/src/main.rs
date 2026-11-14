use rdocx::Document;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

#[derive(Deserialize)]
struct Edit {
    index: Option<usize>,
    text: String,
    #[serde(default)]
    heading: u8,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    italic: bool,
}

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "error": error }));
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<Value, String> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("missing command")?;
    match command.as_str() {
        "version" => Ok(json!({ "version": "rdocx 0.16.2" })),
        "create" => {
            let path = args.next().ok_or("missing path")?;
            let mut document = Document::new();
            if document.paragraph_count() == 0 {
                document.add_paragraph("");
            }
            document.save(&path).map_err(|error| error.to_string())?;
            Ok(model(&path, &document))
        }
        "open" => {
            let path = args.next().ok_or("missing path")?;
            let document = Document::open(&path).map_err(|error| error.to_string())?;
            Ok(model(&path, &document))
        }
        "save" => {
            let path = args.next().ok_or("missing path")?;
            let edits_path = args.next().ok_or("missing edits")?;
            let edits: Vec<Edit> = serde_json::from_str(
                &fs::read_to_string(&edits_path).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let mut document = Document::open(&path).map_err(|error| error.to_string())?;
            apply(&mut document, &edits)?;
            document.save(&path).map_err(|error| error.to_string())?;
            let document = Document::open(&path).map_err(|error| error.to_string())?;
            Ok(model(&path, &document))
        }
        "export" => {
            let path = args.next().ok_or("missing path")?;
            let format = args.next().ok_or("missing format")?;
            let output = args.next().ok_or("missing output")?;
            let document = Document::open(&path).map_err(|error| error.to_string())?;
            match format.as_str() {
                "pdf" => {
                    let bytes = document.to_pdf().map_err(|error| error.to_string())?;
                    fs::write(&output, bytes).map_err(|error| error.to_string())?;
                }
                "html" => {
                    fs::write(&output, document.to_html()).map_err(|error| error.to_string())?;
                }
                "md" => {
                    fs::write(&output, document.to_markdown()).map_err(|error| error.to_string())?;
                }
                "docx" => {
                    fs::copy(&path, &output).map_err(|error| error.to_string())?;
                }
                _ => return Err(format!("unknown format {format}")),
            }
            Ok(json!({ "output": output }))
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn apply(document: &mut Document, edits: &[Edit]) -> Result<(), String> {
    let original = document.paragraph_count();
    let flat = original == document.content_count();
    if !flat {
        for edit in edits {
            let Some(index) = edit.index else {
                return Err("this document has more than paragraphs, so new paragraphs cannot be inserted".to_string());
            };
            if index >= original {
                return Err(format!("paragraph {index} is out of range"));
            }
            format_paragraph(document, index, edit)?;
        }
        return Ok(());
    }

    let keep: HashSet<usize> = edits.iter().filter_map(|edit| edit.index).collect();
    for edit in edits {
        if let Some(index) = edit.index {
            if index >= original {
                return Err(format!("paragraph {index} is out of range"));
            }
            format_paragraph(document, index, edit)?;
        }
    }
    for index in (0..original).rev() {
        if !keep.contains(&index) && !document.remove_content(index) {
            return Err(format!("could not remove paragraph {index}"));
        }
    }

    let mut removed_before = vec![0; original];
    let mut removed = 0;
    for index in 0..original {
        removed_before[index] = removed;
        if !keep.contains(&index) {
            removed += 1;
        }
    }

    let mut inserted = 0;
    let mut last = None;
    for edit in edits {
        match edit.index {
            Some(index) => {
                last = Some(index - removed_before[index] + inserted);
            }
            None => {
                let at = last.map(|index| index + 1).unwrap_or(0);
                let mut paragraph = document.insert_paragraph(at, &edit.text);
                style_paragraph(&mut paragraph, edit);
                inserted += 1;
                last = Some(at);
            }
        }
    }
    if document.paragraph_count() == 0 {
        document.add_paragraph("");
    }
    Ok(())
}

fn format_paragraph(document: &mut Document, index: usize, edit: &Edit) -> Result<(), String> {
    let mut paragraph = document
        .paragraph_mut(index)
        .ok_or_else(|| format!("paragraph {index} is missing"))?;
    paragraph
        .set_text(&edit.text)
        .map_err(|error| error.to_string())?;
    style_paragraph(&mut paragraph, edit);
    Ok(())
}

fn style_paragraph(paragraph: &mut rdocx::Paragraph<'_>, edit: &Edit) {
    match edit.heading {
        1 => paragraph.set_style("Heading1"),
        2 => paragraph.set_style("Heading2"),
        3 => paragraph.set_style("Heading3"),
        _ => paragraph.set_style_value(None),
    }
    if edit.text.is_empty() {
        return;
    }
    if let Some(mut run) = paragraph.run_mut(0) {
        run.set_bold(edit.bold);
        run.set_italic(edit.italic);
    }
}

fn model(path: &str, document: &Document) -> Value {
    let paragraphs: Vec<Value> = document
        .paragraphs()
        .iter()
        .enumerate()
        .map(|(index, paragraph)| {
            let style = paragraph.style_id().unwrap_or("");
            let heading = match style {
                "Heading1" | "heading 1" => 1,
                "Heading2" | "heading 2" => 2,
                "Heading3" | "heading 3" => 3,
                _ => 0,
            };
            json!({
                "index": index,
                "text": paragraph.text(),
                "heading": heading,
                "bold": paragraph.run(0).is_some_and(|run| run.is_bold()),
                "italic": paragraph.run(0).is_some_and(|run| run.is_italic()),
            })
        })
        .collect();
    let words = paragraphs
        .iter()
        .map(|paragraph| {
            paragraph["text"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .count()
        })
        .sum::<usize>();
    json!({
        "name": Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or("document.docx"),
        "paragraphs": paragraphs,
        "words": words,
        "flat": document.paragraph_count() == document.content_count(),
    })
}
