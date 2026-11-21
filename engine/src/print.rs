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

/// One model body block, in body order.
///
/// Pages are 0-based physical pages. Both are absent when the block has no
/// placed fragment: the layout returns an empty list for content it did not
/// place, and `None` for an index past the written body. Nothing is invented
/// for that block.
///
/// `body_layout_fragments` is indexed by the written document's direct body
/// items. `write` keeps one body item per patch block, in patch order, so
/// item `i` is model block `i`. On an unmodified document that index is also
/// the import source map's content index, because import walks body items in
/// order. After a patch the fragment index follows the written document, not
/// the original content index an insert would have shifted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPage {
    pub index: u32,
    pub first_page: Option<u32>,
    pub last_page: Option<u32>,
}

/// One placed fragment of a body block.
///
/// `page` is 0-based, matching [`BlockPage`]. `y` and `height` are the
/// fragment's top and size in points, copied from `body_layout_fragments`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockFragment {
    pub page: u32,
    pub y: f64,
    pub height: f64,
}

/// One model body block and the fragments the layout placed, in page order.
///
/// The list is empty when nothing was placed, the same case as a [`BlockPage`]
/// with both pages absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockBox {
    pub index: u32,
    pub fragments: Vec<BlockFragment>,
}

/// One glyph run as the PDF paints it. Baseline is points from the page top.
#[derive(Debug, Clone, PartialEq)]
pub struct PaintedSpan {
    pub page: u32,
    pub text: String,
    pub family: String,
    pub baseline: f64,
}

/// The layout of one patched document. Preview and PDF both read it.
#[derive(Debug)]
#[wasm_bindgen]
pub struct PrintLayout {
    layout: oxml_layout::LayoutResult,
    block_pages: Vec<BlockPage>,
    block_boxes: Vec<BlockBox>,
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

    pub fn block_pages(&self) -> &[BlockPage] {
        &self.block_pages
    }

    /// Fragments of each body block, in body order. See [`BlockBox`].
    pub fn block_boxes(&self) -> &[BlockBox] {
        &self.block_boxes
    }

    /// Glyph runs in paint order, with the face the PDF embeds for each.
    pub fn painted_spans(&self) -> Vec<PaintedSpan> {
        let fonts: Vec<(oxml_layout::FontId, String)> = self
            .layout
            .fonts
            .iter()
            .map(|font| (font.id, font.family.clone()))
            .collect();
        let mut spans = Vec::new();
        for (index, page) in self.layout.pages.iter().enumerate() {
            let Ok(page_index) = u32::try_from(index) else {
                continue;
            };
            oxml_layout::walk(&page.elements, &mut |element, transform| {
                let (text, font_id, origin) = match element {
                    oxml_layout::PositionedElement::Text(run) => {
                        (run.text.as_str(), run.font_id, run.origin)
                    }
                    oxml_layout::PositionedElement::MultilingualText(run) => {
                        (run.logical_text.as_str(), run.font_id, run.origin)
                    }
                    _ => return,
                };
                if text.is_empty() {
                    return;
                }
                let family = fonts
                    .iter()
                    .find(|(id, _)| *id == font_id)
                    .map(|(_, family)| family.clone())
                    .unwrap_or_else(|| format!("font {}", font_id.0));
                spans.push(PaintedSpan {
                    page: page_index,
                    text: text.to_owned(),
                    family,
                    baseline: transform.apply(origin).y,
                });
            });
        }
        spans
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

    #[wasm_bindgen(js_name = block_pages)]
    pub fn block_pages_js(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.block_pages).map_err(|error| {
            JsValue::from(PrintError::Render {
                detail: format!("block pages json: {error}"),
            })
        })
    }

    #[wasm_bindgen(js_name = block_boxes)]
    pub fn block_boxes_js(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.block_boxes).map_err(|error| {
            JsValue::from(PrintError::Render {
                detail: format!("block boxes json: {error}"),
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
///
/// `body_blocks` is the patch body length. See [`BlockPage`] for the map from
/// those blocks onto `body_layout_fragments`.
pub(crate) fn lay_out(
    document: &rdocx::Document,
    fonts: &[(&str, &[u8])],
    aliases: &[(&str, &str)],
    body_blocks: usize,
) -> Result<PrintLayout, PrintError> {
    let laid = document
        .layout_with_fonts_aliases_and_bundled_fallback(fonts, aliases)
        .map_err(classify)?;
    let mut block_pages = Vec::with_capacity(body_blocks);
    let mut block_boxes = Vec::with_capacity(body_blocks);
    for index in 0..body_blocks {
        let index_u32 = u32::try_from(index).expect("body index fits in u32");
        let found = laid.body_layout_fragments(index);
        let (first_page, last_page) = match &found {
            Some(fragments) => {
                pages_from_physical(fragments.iter().map(|fragment| fragment.physical_page))
            }
            None => (None, None),
        };
        let mut placed = Vec::new();
        if let Some(fragments) = &found {
            for fragment in fragments.iter() {
                if let Some(placed_fragment) =
                    placed_fragment(fragment.physical_page, fragment.y, fragment.height)
                {
                    placed.push(placed_fragment);
                }
            }
        }
        placed.sort_by_key(|fragment| fragment.page);
        block_pages.push(BlockPage {
            index: index_u32,
            first_page,
            last_page,
        });
        block_boxes.push(BlockBox {
            index: index_u32,
            fragments: placed,
        });
    }
    Ok(PrintLayout {
        layout: laid.layout,
        block_pages,
        block_boxes,
    })
}

/// A 1-based physical page and a finite box become one fragment. Page 0 is
/// not placed. Non-finite coordinates are left out rather than invented.
fn placed_fragment(physical_page: usize, y: f64, height: f64) -> Option<BlockFragment> {
    let page = physical_page.checked_sub(1)?;
    let page = u32::try_from(page).ok()?;
    if !y.is_finite() || !height.is_finite() {
        return None;
    }
    Some(BlockFragment { page, y, height })
}

/// 1-based physical pages become a 0-based first and last. A page number of 0
/// is not a placed page and is left out.
fn pages_from_physical(
    physical_pages: impl IntoIterator<Item = usize>,
) -> (Option<u32>, Option<u32>) {
    let mut first = None;
    let mut last = None;
    for physical in physical_pages {
        let Some(page) = physical.checked_sub(1) else {
            continue;
        };
        let Ok(page) = u32::try_from(page) else {
            continue;
        };
        first = Some(first.map_or(page, |earlier: u32| earlier.min(page)));
        last = Some(last.map_or(page, |earlier: u32| earlier.max(page)));
    }
    (first, last)
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
            block_pages: Vec::new(),
            block_boxes: Vec::new(),
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
        assert!(layout.block_pages().is_empty());
        assert!(layout.block_boxes().is_empty());
    }

    #[test]
    fn block_page_json_uses_null_when_the_block_has_no_fragment() {
        let page = BlockPage {
            index: 2,
            first_page: None,
            last_page: None,
        };
        let json = serde_json::to_string(&page).expect("json");
        assert_eq!(json, "{\"index\":2,\"firstPage\":null,\"lastPage\":null}");
        let placed = BlockPage {
            index: 0,
            first_page: Some(0),
            last_page: Some(1),
        };
        assert_eq!(
            serde_json::to_string(&placed).expect("json"),
            "{\"index\":0,\"firstPage\":0,\"lastPage\":1}"
        );
        assert_eq!(pages_from_physical([1, 3, 2]), (Some(0), Some(2)));
        assert_eq!(pages_from_physical([0]), (None, None));
        assert_eq!(pages_from_physical(std::iter::empty()), (None, None));
    }

    #[test]
    fn block_box_json_lists_fragments_in_the_order_they_were_stored() {
        let placed = BlockBox {
            index: 1,
            fragments: vec![BlockFragment {
                page: 0,
                y: 72.0,
                height: 18.5,
            }],
        };
        assert_eq!(
            serde_json::to_string(&placed).expect("json"),
            "{\"index\":1,\"fragments\":[{\"page\":0,\"y\":72.0,\"height\":18.5}]}"
        );
        let empty = BlockBox {
            index: 4,
            fragments: Vec::new(),
        };
        assert_eq!(
            serde_json::to_string(&empty).expect("json"),
            "{\"index\":4,\"fragments\":[]}"
        );
        assert_eq!(placed_fragment(0, 10.0, 12.0), None);
        assert_eq!(placed_fragment(1, f64::NAN, 12.0), None);
        assert_eq!(
            placed_fragment(2, 36.0, 15.0),
            Some(BlockFragment {
                page: 1,
                y: 36.0,
                height: 15.0,
            })
        );
    }
}
