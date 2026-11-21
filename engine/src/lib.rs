pub mod import;
pub mod print;
pub mod verify;
pub mod wire;
pub mod write;

use std::collections::BTreeMap;
use std::sync::Arc;

use wasm_bindgen::prelude::*;

struct StoredMedia {
    content_type: String,
    bytes: Vec<u8>,
}

struct CallerFont {
    family: String,
    bytes: Arc<[u8]>,
}

#[wasm_bindgen]
pub struct MediaFile {
    bytes: Vec<u8>,
    content_type: String,
}

#[wasm_bindgen]
impl MediaFile {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    #[wasm_bindgen(getter, js_name = contentType)]
    pub fn content_type(&self) -> String {
        self.content_type.clone()
    }
}

#[wasm_bindgen]
pub struct Session {
    doc: rdocx::Document,
    imported: wire::Imported,
    sources: import::SourceMap,
    media: BTreeMap<String, StoredMedia>,
    ledger: verify::Ledger,
    fonts: Vec<CallerFont>,
    font_aliases: Vec<(String, String)>,
}

impl Session {
    pub fn from_bytes(bytes: &[u8]) -> Result<Session, String> {
        let doc = rdocx::Document::from_bytes(bytes).map_err(|error| error.to_string())?;
        Ok(Self::from_document(doc))
    }

    fn from_document(doc: rdocx::Document) -> Session {
        let imported = import::import(&doc);
        let media = imported
            .media_bytes
            .into_iter()
            .map(|(key, (content_type, bytes))| {
                (
                    key,
                    StoredMedia {
                        content_type,
                        bytes,
                    },
                )
            })
            .collect();
        Session {
            doc,
            imported: imported.imported,
            sources: imported.sources,
            media,
            ledger: imported.ledger,
            fonts: Vec::new(),
            font_aliases: Vec::new(),
        }
    }

    pub fn block_sources(&self) -> usize {
        self.sources.blocks.len()
    }

    /// The unmodeled-item ledger counted at import.
    pub fn ledger(&self) -> &verify::Ledger {
        &self.ledger
    }

    /// Write `patch_json` onto a fresh copy of the opened document.
    ///
    /// The session's document is left untouched. A write or verify failure returns before bytes.
    pub fn save_result(&self, patch_json: &str) -> Result<Vec<u8>, wire::BridgeError> {
        self.save_result_tampered(patch_json, |_| {})
    }

    /// `save_result`, then `tamper` the written document before verification.
    ///
    /// Tests use this to drop a bookmark and check that verify names it. A save never calls it.
    pub fn save_result_tampered(
        &self,
        patch_json: &str,
        tamper: impl FnOnce(&mut rdocx::Document),
    ) -> Result<Vec<u8>, wire::BridgeError> {
        let patch: wire::Patch =
            serde_json::from_str(patch_json).map_err(|error| wire::BridgeError::Write {
                detail: error.to_string(),
            })?;
        let mut written =
            write::write(&self.doc, &self.sources, &self.imported, &patch).map_err(|error| {
                wire::BridgeError::Write {
                    detail: error.detail(),
                }
            })?;
        tamper(&mut written.document);
        verify::verify(
            &written.document,
            &patch,
            &self.imported,
            &self.ledger,
            &written.removed,
            &written.list_ids,
            &written.media,
        )
        .map_err(|first_difference| wire::BridgeError::Verify { first_difference })?;
        written
            .document
            .to_bytes()
            .map_err(|error| wire::BridgeError::Write {
                detail: error.to_string(),
            })
    }

    /// Keep `bytes` as the face for `family` until the session is dropped.
    ///
    /// The same bytes under two family names share one buffer. Adding a family
    /// that is already stored replaces that face.
    pub fn add_font(&mut self, family: &str, bytes: &[u8]) {
        let stored = self
            .fonts
            .iter()
            .find(|font| font.bytes.as_ref() == bytes)
            .map(|font| Arc::clone(&font.bytes))
            .unwrap_or_else(|| Arc::<[u8]>::from(bytes));
        if let Some(slot) = self.fonts.iter_mut().find(|font| font.family == family) {
            slot.bytes = stored;
        } else {
            self.fonts.push(CallerFont {
                family: family.to_owned(),
                bytes: stored,
            });
        }
    }

    /// Strong count of the bytes stored for `family`.
    ///
    /// A live [`print::PrintLayout`] holds one clone of each face the text uses.
    pub fn font_strong_count(&self, family: &str) -> Option<usize> {
        self.fonts
            .iter()
            .find(|font| font.family == family)
            .map(|font| Arc::strong_count(&font.bytes))
    }

    /// Map a requested family onto a family passed to `add_font`.
    ///
    /// The same requested name replaces its previous target.
    pub fn add_font_alias(&mut self, requested: &str, loaded: &str) {
        if let Some(alias) = self
            .font_aliases
            .iter_mut()
            .find(|(name, _)| name == requested)
        {
            alias.1 = loaded.to_owned();
        } else {
            self.font_aliases
                .push((requested.to_owned(), loaded.to_owned()));
        }
    }

    /// Lay out `patch_json` on a fresh copy of the opened document.
    ///
    /// The session document is left untouched. A patch `write` refuses carries
    /// the same detail as `save_result`. Nothing is verified and no docx bytes
    /// are produced.
    pub fn print_layout(
        &self,
        patch_json: &str,
    ) -> Result<print::PrintLayout, print::PrintFailure> {
        let patch: wire::Patch = serde_json::from_str(patch_json)
            .map_err(|error| print::PrintFailure::Write(error.to_string()))?;
        let written = write::write(&self.doc, &self.sources, &self.imported, &patch)
            .map_err(|error| print::PrintFailure::Write(error.detail()))?;
        let fonts: Vec<(&str, Arc<[u8]>)> = self
            .fonts
            .iter()
            .map(|font| (font.family.as_str(), Arc::clone(&font.bytes)))
            .collect();
        let aliases: Vec<(&str, &str)> = self
            .font_aliases
            .iter()
            .map(|(requested, loaded)| (requested.as_str(), loaded.as_str()))
            .collect();
        print::lay_out(&written.document, &fonts, &aliases, patch.body.len())
            .map_err(print::PrintFailure::Print)
    }
}

#[wasm_bindgen]
impl Session {
    pub fn blank() -> Session {
        Self::from_document(rdocx::Document::new())
    }

    pub fn open(bytes: &[u8]) -> Result<Session, JsValue> {
        Session::from_bytes(bytes).map_err(|message| open_error(&message))
    }

    pub fn paragraph_count(&self) -> u32 {
        self.doc.paragraph_count() as u32
    }

    pub fn text(&self) -> String {
        self.doc.text()
    }

    pub fn import(&self) -> String {
        serde_json::to_string(&self.imported).expect("imported document is JSON")
    }

    /// Save the patch onto a fresh copy of the opened document and return docx bytes.
    pub fn save(&self, patch_json: &str) -> Result<Vec<u8>, JsValue> {
        self.save_result(patch_json).map_err(bridge_error)
    }

    /// `save`, then drop a bookmark before verification so the result fails.
    ///
    /// The app does not call this. The dev hook uses it to show a verify error.
    /// A document with no bookmark has its first run rewritten, so verification still fails.
    pub fn save_tampered(&self, patch_json: &str) -> Result<Vec<u8>, JsValue> {
        self.save_result_tampered(patch_json, tamper_for_verify)
            .map_err(bridge_error)
    }

    /// Image bytes and content type for one media key. The sketch's `image` returns bytes only.
    pub fn media(&self, key: &str) -> Option<MediaFile> {
        self.media.get(key).map(|media| MediaFile {
            bytes: media.bytes.clone(),
            content_type: media.content_type.clone(),
        })
    }

    pub fn image(&self, rel_id: &str) -> Option<Vec<u8>> {
        self.media.get(rel_id).map(|media| media.bytes.clone())
    }

    pub fn look(&self, para_style: &str, char_style: Option<String>) -> String {
        let look = self
            .imported
            .run_looks
            .iter()
            .find(|entry| {
                entry.para == para_style && entry.character.as_deref() == char_style.as_deref()
            })
            .or_else(|| {
                self.imported
                    .run_looks
                    .iter()
                    .find(|entry| entry.para == para_style && entry.character.is_none())
            })
            .map(|entry| entry.look.clone())
            .unwrap_or_else(default_run_look);
        serde_json::to_string(&look).expect("run look is JSON")
    }

    /// The page's bytes are copied once, into this slice. `Arc::from` on a
    /// `Vec<u8>` or a `Box<[u8]>` copies again (nightly and 1.97.1), so the
    /// binding does not take ownership.
    #[wasm_bindgen(js_name = add_font)]
    pub fn add_font_js(&mut self, family: &str, bytes: &[u8]) {
        self.add_font(family, bytes);
    }

    #[wasm_bindgen(js_name = add_font_alias)]
    pub fn add_font_alias_js(&mut self, requested: &str, loaded: &str) {
        self.add_font_alias(requested, loaded);
    }

    #[wasm_bindgen(js_name = print_layout)]
    pub fn print_layout_js(&self, patch_json: &str) -> Result<print::PrintLayout, JsValue> {
        self.print_layout(patch_json).map_err(print_failure)
    }

    pub fn para_look(&self, style: &str) -> String {
        let look = self
            .imported
            .para_looks
            .iter()
            .find(|entry| entry.style == style)
            .map(|entry| entry.look.clone())
            .unwrap_or_else(default_para_look);
        serde_json::to_string(&look).expect("paragraph look is JSON")
    }
}

fn default_run_look() -> wire::RunLook {
    wire::RunLook {
        fonts: wire::RunFonts {
            ascii: "Calibri".into(),
            h_ansi: "Calibri".into(),
            east_asia: "Calibri".into(),
            cs: "Calibri".into(),
            hint: None,
        },
        size_pt: 11.0,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        color: "auto".into(),
        highlight: None,
        caps: false,
        char_spacing_pt: 0.0,
    }
}

fn default_para_look() -> wire::ParaLook {
    wire::ParaLook {
        align: "left".into(),
        indent: wire::ParaIndent {
            left: 0.0,
            right: 0.0,
            first_line: 0.0,
            hanging: 0.0,
            first_line_chars: None,
        },
        spacing: wire::ParaSpacing {
            before: 0.0,
            after: 0.0,
            line: wire::LineSpacing::Auto { multiple: 1.0 },
            contextual: false,
        },
        numbering: None,
        keep_next: false,
        keep_lines: false,
        page_break_before: false,
        widow_control: true,
    }
}

fn bridge_error(error: wire::BridgeError) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&error).expect("bridge error is JSON"))
}

fn print_failure(error: print::PrintFailure) -> JsValue {
    match error {
        print::PrintFailure::Write(detail) => bridge_error(wire::BridgeError::Write { detail }),
        print::PrintFailure::Print(error) => JsValue::from(error),
    }
}

/// Drop one bookmark. With none to drop, rewrite the first run so the projection differs.
fn tamper_for_verify(doc: &mut rdocx::Document) {
    let bookmark = doc
        .bookmarks()
        .into_iter()
        .find_map(|bookmark| bookmark.id());
    if let Some(id) = bookmark
        && doc.remove_story_bookmark(id).is_ok()
    {
        return;
    }
    let Some(mut paragraph) = doc.paragraph_mut(0) else {
        return;
    };
    let Some(mut run) = paragraph.run_mut(0) else {
        return;
    };
    run.set_text("tampered");
}

fn open_error(message: &str) -> JsValue {
    let lower = message.to_ascii_lowercase();
    let reason = if lower.contains("encrypt") || lower.contains("password") {
        "encrypted"
    } else if lower.contains("not a zip")
        || lower.contains("invalid zip")
        || lower.contains("central directory")
    {
        "notDocx"
    } else if lower.contains("too large") || lower.contains("limit") {
        "tooLarge"
    } else {
        "corrupt"
    };
    JsValue::from_str(
        &serde_json::json!({
            "kind": "open",
            "reason": reason,
            "detail": message,
        })
        .to_string(),
    )
}
