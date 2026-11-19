pub mod import;
pub mod verify;
pub mod wire;
pub mod write;

use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

struct StoredMedia {
    content_type: String,
    bytes: Vec<u8>,
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
        )
        .map_err(|first_difference| wire::BridgeError::Verify { first_difference })?;
        written
            .document
            .to_bytes()
            .map_err(|error| wire::BridgeError::Write {
                detail: error.to_string(),
            })
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
