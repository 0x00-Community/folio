use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Session {
    doc: rdocx::Document,
}

impl Session {
    pub fn from_bytes(bytes: &[u8]) -> Result<Session, String> {
        rdocx::Document::from_bytes(bytes)
            .map(|doc| Session { doc })
            .map_err(|error| error.to_string())
    }
}

#[wasm_bindgen]
impl Session {
    pub fn blank() -> Session {
        Session {
            doc: rdocx::Document::new(),
        }
    }

    pub fn open(bytes: &[u8]) -> Result<Session, JsValue> {
        Session::from_bytes(bytes).map_err(|message| JsValue::from_str(&message))
    }

    pub fn paragraph_count(&self) -> u32 {
        self.doc.paragraph_count() as u32
    }

    pub fn text(&self) -> String {
        self.doc.text()
    }
}
