//! Lay out a patched document once and render that layout to PDF or PNG.
//!
//! Caller faces are passed by reference. Families the caller did not supply
//! resolve from the bundled substitutes, because the engine builds without
//! system-font discovery.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Why a print layout or a render of it failed.
///
/// A refused patch is not this type. It is the same `Write` error as save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrintError {
    Font { family: String },
    Layout { detail: String },
    Render { detail: String },
}

/// `write` refused the patch, or layout failed after a successful write.
#[derive(Debug)]
pub enum PrintFailure {
    Write(String),
    Print(PrintError),
}

/// One face the layout used. `embedded` is true when the layout kept the
/// face bytes the PDF writer embeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrintFont {
    pub family: String,
    pub embedded: bool,
}

/// The layout of one patched document. Preview and PDF both read it.
#[derive(Debug)]
#[wasm_bindgen]
pub struct PrintLayout {
    layout: oxml_layout::LayoutResult,
}

impl PrintLayout {
    pub fn page_count(&self) -> u32 {
        u32::try_from(self.layout.pages.len()).unwrap_or(u32::MAX)
    }

    pub fn page_size(&self, index: u32) -> Result<(f64, f64), PrintError> {
        let page = self.page(index)?;
        if !page.width.is_finite() || !page.height.is_finite() {
            return Err(PrintError::Layout {
                detail: format!("page {index} has a non-finite size"),
            });
        }
        Ok((page.width, page.height))
    }

    pub fn page_png(&self, index: u32, dpi: f64) -> Result<Vec<u8>, PrintError> {
        let _page = self.page(index)?;
        if !dpi.is_finite() || dpi <= 0.0 {
            return Err(PrintError::Render {
                detail: format!("dpi {dpi} is not a positive finite number"),
            });
        }
        oxml_pdf::render_page_to_png(&self.layout, index as usize, dpi).ok_or_else(|| {
            PrintError::Render {
                detail: format!("page {index} could not be encoded as png"),
            }
        })
    }

    pub fn pdf(&self) -> Result<Vec<u8>, PrintError> {
        oxml_pdf::render_to_pdf_checked(&self.layout).map_err(|error| PrintError::Render {
            detail: error.to_string(),
        })
    }

    pub fn fonts(&self) -> Vec<PrintFont> {
        let used = self.used_font_ids();
        self.layout
            .fonts
            .iter()
            .filter(|font| used.contains(&font.id))
            .map(|font| PrintFont {
                family: font.family.clone(),
                embedded: !font.data.is_empty(),
            })
            .collect()
    }

    fn used_font_ids(&self) -> BTreeSet<oxml_layout::FontId> {
        let mut ids = BTreeSet::new();
        for page in &self.layout.pages {
            oxml_layout::walk(&page.elements, &mut |element, _| match element {
                oxml_layout::PositionedElement::Text(run) => {
                    ids.insert(run.font_id);
                }
                oxml_layout::PositionedElement::MultilingualText(run) => {
                    ids.insert(run.font_id);
                }
                _ => {}
            });
        }
        ids
    }

    fn page(&self, index: u32) -> Result<&oxml_layout::PageFrame, PrintError> {
        self.layout
            .pages
            .get(index as usize)
            .map(Arc::as_ref)
            .ok_or_else(|| PrintError::Render {
                detail: format!("page {index} is out of range"),
            })
    }
}

#[wasm_bindgen]
impl PrintLayout {
    #[wasm_bindgen(js_name = page_count)]
    pub fn page_count_js(&self) -> u32 {
        self.page_count()
    }

    #[wasm_bindgen(js_name = page_size)]
    pub fn page_size_js(&self, index: u32) -> Result<String, JsValue> {
        let (width, height) = self.page_size(index).map_err(JsValue::from)?;
        serde_json::to_string(&(width, height)).map_err(|error| {
            JsValue::from(PrintError::Render {
                detail: format!("page size json: {error}"),
            })
        })
    }

    #[wasm_bindgen(js_name = page_png)]
    pub fn page_png_js(&self, index: u32, dpi: f64) -> Result<Vec<u8>, JsValue> {
        self.page_png(index, dpi).map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = pdf)]
    pub fn pdf_js(&self) -> Result<Vec<u8>, JsValue> {
        self.pdf().map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = fonts)]
    pub fn fonts_js(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.fonts()).map_err(|error| {
            JsValue::from(PrintError::Render {
                detail: format!("fonts json: {error}"),
            })
        })
    }
}

impl From<PrintError> for JsValue {
    fn from(error: PrintError) -> Self {
        match serde_json::to_string(&error) {
            Ok(json) => JsValue::from_str(&json),
            Err(_) => {
                JsValue::from_str("{\"kind\":\"layout\",\"detail\":\"error serialization failed\"}")
            }
        }
    }
}

/// Layout `document` with caller faces over the bundled substitutes.
///
/// `layout_with_fonts` has no bundled fallback, so a missing Calibri would not
/// resolve. The alias variant tries each `(requested, loaded)` pair after an
/// exact family and before the bundled metric substitutes.
pub(crate) fn lay_out(
    document: &rdocx::Document,
    fonts: &[(&str, &[u8])],
    aliases: &[(&str, &str)],
) -> Result<PrintLayout, PrintError> {
    let laid = document
        .layout_with_fonts_aliases_and_bundled_fallback(fonts, aliases)
        .map_err(classify)?;
    Ok(PrintLayout {
        layout: laid.layout,
    })
}

fn classify(error: rdocx::Error) -> PrintError {
    match error {
        rdocx::Error::Layout(oxml_layout::LayoutError::FontNotFound(detail)) => PrintError::Font {
            family: family_in(&detail),
        },
        rdocx::Error::Layout(oxml_layout::LayoutError::FontParse(detail)) => {
            match quoted_family(&detail) {
                Some(family) => PrintError::Font { family },
                None => PrintError::Layout {
                    detail: format!("font parsing error: {detail}"),
                },
            }
        }
        other => PrintError::Layout {
            detail: other.to_string(),
        },
    }
}

fn family_in(detail: &str) -> String {
    quoted_family(detail).unwrap_or_else(|| detail.to_owned())
}

fn quoted_family(detail: &str) -> Option<String> {
    let start = detail.find('\'')?;
    let rest = detail.get(start.checked_add(1)?..)?;
    let end = rest.find('\'')?;
    let family = rest.get(..end)?;
    if family.is_empty() {
        None
    } else {
        Some(family.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PrintLayout {
        let page = Arc::new(oxml_layout::PageFrame::new(1, 612.0, 792.0, Vec::new()));
        PrintLayout {
            layout: oxml_layout::LayoutResult::new(vec![page], Vec::new(), None, Vec::new()),
        }
    }

    #[test]
    fn print_error_json_kinds() {
        let font = serde_json::to_string(&PrintError::Font {
            family: "宋体".into(),
        })
        .expect("json");
        assert_eq!(font, "{\"kind\":\"font\",\"family\":\"宋体\"}");
        let layout = serde_json::to_string(&PrintError::Layout {
            detail: "no".into(),
        })
        .expect("json");
        assert_eq!(layout, "{\"kind\":\"layout\",\"detail\":\"no\"}");
        let render = serde_json::to_string(&PrintError::Render {
            detail: "png".into(),
        })
        .expect("json");
        assert_eq!(render, "{\"kind\":\"render\",\"detail\":\"png\"}");
    }

    #[test]
    fn missing_page_and_bad_dpi_are_render_errors() {
        let layout = sample();
        assert!(matches!(
            layout.page_size(1),
            Err(PrintError::Render { .. })
        ));
        for dpi in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                matches!(layout.page_png(0, dpi), Err(PrintError::Render { .. })),
                "dpi {dpi}"
            );
        }
        let (width, height) = layout.page_size(0).expect("page 0");
        assert_eq!((width, height), (612.0, 792.0));
        assert_eq!(layout.page_count(), 1);
    }
}
