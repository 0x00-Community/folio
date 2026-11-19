//! Apply a save patch onto a fresh copy of the document as opened.
//!
//! The pristine document is only read. Each step is applied from the end of the body toward the
//! start, so a later insert or removal cannot shift a content index the planner already chose.

use std::collections::{BTreeMap, HashMap, HashSet};

use rdocx::{
    Alignment, BreakKind, Document, Length, ListLevel, ListNumberFormat, Paragraph, Run,
    RunFontSlot, RunItemRef, RunRef, StyleBuilder, Twips, UnderlineStyle,
};

use crate::import::{self, ParaAddr, SourceMap};
use crate::verify;
use crate::wire::{
    self, Atom, Block, Inline, LineSpacing, Marks, Para, ParaProps, Patch, PatchBlock, Table,
};

/// The patch breaks a promise the model makes, or the kit refused an edit.
#[derive(Debug)]
pub enum WriteError {
    /// Source order, a locked paragraph, a feature this round does not write.
    Contract(String),
    /// `split_paragraph`, `join_paragraphs`, `remove_run`, or another kit call refused.
    Rdocx(rdocx::Error),
}

impl WriteError {
    pub fn detail(&self) -> String {
        match self {
            WriteError::Contract(detail) => detail.clone(),
            WriteError::Rdocx(error) => error.to_string(),
        }
    }
}

impl From<rdocx::Error> for WriteError {
    fn from(error: rdocx::Error) -> Self {
        WriteError::Rdocx(error)
    }
}

fn contract(detail: impl Into<String>) -> WriteError {
    WriteError::Contract(detail.into())
}

/// What `write` produces for `verify`: the staged document, fingerprints of items the patch
/// removed, and the real numId assigned to each negative list id.
pub struct Written {
    pub document: Document,
    pub removed: BTreeMap<String, usize>,
    pub list_ids: BTreeMap<i32, u32>,
}

/// Ordered by pristine position. `write` applies `steps` from the back.
#[derive(Debug)]
pub struct Plan {
    pub steps: Vec<Step>,
}

/// One edit against the opened document.
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum Step {
    /// Pristine paragraphs `sources` become `finals`, joined then split.
    Region(Region),
    /// A paragraph the patch created, inserted after the pristine content index (`None` is the start).
    Insert { after: Option<usize>, block: Block },
    /// A table or opaque block the patch dropped. Paragraphs are not removed this way.
    Remove { content_index: usize },
    /// A table whose grid and cells are unchanged and whose paragraphs may have been edited.
    Table { content_index: usize, table: Table },
}

/// Source paragraphs that become `finals`.
///
/// `paragraphs` are pristine body indexes. A deleted table or opaque block that
/// sat between them is listed in `gaps` and removed before the paragraphs are
/// joined, so the join sees a contiguous run of paragraphs.
#[derive(Debug)]
pub struct Region {
    pub paragraphs: Vec<usize>,
    pub gaps: Vec<usize>,
    pub finals: Vec<Para>,
}

/// Stage `patch` onto a clone of `pristine`.
pub fn write(
    pristine: &Document,
    sources: &SourceMap,
    imported: &wire::Imported,
    patch: &Patch,
) -> Result<Written, WriteError> {
    if patch.sections != imported.sections {
        return Err(contract("page setup"));
    }
    let plan = plan(sources, imported, &patch.body)?;
    let mut document = pristine.clone_for_staging();
    apply_styles(&mut document, &patch.added_styles)?;
    let list_ids = apply_lists(&mut document, &patch.new_lists)?;
    let links = run_links(&imported.body);
    let texts = run_texts(&imported.body);
    let mut removed = BTreeMap::new();
    let mut ctx = Apply {
        sources,
        list_ids: &list_ids,
        links: &links,
        texts: &texts,
        removed: &mut removed,
    };
    for step in plan.steps.iter().rev() {
        match step {
            Step::Region(region) => apply_region(&mut document, region, &mut ctx)?,
            Step::Insert { after, block } => apply_insert(&mut document, *after, block, &mut ctx)?,
            Step::Remove { content_index } => {
                remove_content(&mut document, *content_index, ctx.removed, ctx.list_ids)?;
            }
            Step::Table {
                content_index,
                table,
            } => {
                let pristine_table = find_table(&imported.body, table.src)
                    .ok_or_else(|| contract("table is not in the opened document"))?;
                patch_table(
                    &mut document,
                    *content_index,
                    pristine_table,
                    table,
                    &mut ctx,
                )?;
            }
        }
    }
    Ok(Written {
        document,
        removed,
        list_ids,
    })
}

struct Apply<'a> {
    sources: &'a SourceMap,
    list_ids: &'a BTreeMap<i32, u32>,
    links: &'a HashMap<u32, Option<String>>,
    /// Text import stored for each run. A field's `run.text()` is not that string.
    texts: &'a HashMap<u32, String>,
    removed: &'a mut BTreeMap<String, usize>,
}

/// Group the final body into regions. Untouched blocks produce no step.
pub fn plan(
    sources: &SourceMap,
    imported: &wire::Imported,
    body: &[PatchBlock],
) -> Result<Plan, WriteError> {
    check_run_order(imported, body)?;
    let slots = body_slots(sources, &imported.body)?;
    let mut by_src = HashMap::new();
    for (position, slot) in slots.iter().enumerate() {
        by_src.insert(slot.src, position);
    }

    let mut items = Vec::new();
    let mut seen_src = HashSet::new();
    for block in body {
        match block {
            PatchBlock::Keep { keep } => {
                let position = *by_src
                    .get(keep)
                    .ok_or_else(|| contract(format!("keep {keep} is not a pristine block")))?;
                if !seen_src.insert(*keep) {
                    return Err(contract(format!("block {keep} appears twice")));
                }
                items.push(item_from_block(&slots[position].block, true)?);
            }
            PatchBlock::Changed(block) => {
                // A split repeats the surviving paragraph src. Tables and opaque blocks do not.
                if let Some(src) = block_src(block) {
                    let repeated_paragraph = matches!(block, Block::P(_));
                    if repeated_paragraph {
                        if seen_src.contains(&src) {
                            return Err(contract(format!("block {src} appears twice")));
                        }
                    } else if !seen_src.insert(src) {
                        return Err(contract(format!("block {src} appears twice")));
                    }
                    if !by_src.contains_key(&src) {
                        return Err(contract(format!(
                            "block {src} is not in the opened document"
                        )));
                    }
                }
                items.push(item_from_block(block, false)?);
            }
        }
    }
    if items.iter().any(|item| matches!(item, Item::InsertTable)) {
        return Err(contract("inserted tables"));
    }

    let para_positions: Vec<usize> = slots
        .iter()
        .enumerate()
        .filter_map(|(position, slot)| matches!(slot.kind, SlotKind::Para).then_some(position))
        .collect();
    let mut src_at = HashMap::new();
    for (ordinal, position) in para_positions.iter().enumerate() {
        src_at.insert(slots[*position].src, ordinal);
    }

    let mut linked: Vec<Option<Vec<usize>>> = Vec::new();
    for item in &items {
        linked.push(match item {
            Item::Para { para, .. } => Some(paragraph_links(para, &src_at, sources)?),
            _ => None,
        });
    }

    let mut uf = UnionFind::new(para_positions.len());
    let mut referenced = vec![false; para_positions.len()];
    for links in linked.iter().flatten() {
        if links.is_empty() {
            continue;
        }
        for ordinal in links {
            referenced[*ordinal] = true;
        }
        for ordinal in &links[1..] {
            uf.union(links[0], *ordinal);
        }
    }

    let mut absorbed = vec![false; para_positions.len()];
    // Consecutive paragraphs, or the same pair with only dropped tables and
    // removable opaque blocks between them. A kept block still separates them.
    let adjacent = |left: usize, right: usize| {
        let left_index = slots[para_positions[left]].content_index;
        let right_index = slots[para_positions[right]].content_index;
        if right_index <= left_index {
            return false;
        }
        slots
            .iter()
            .filter(|slot| slot.content_index > left_index && slot.content_index < right_index)
            .all(|slot| match slot.kind {
                SlotKind::Para => false,
                SlotKind::Table => !seen_src.contains(&slot.src),
                SlotKind::Opaque { removable: true } => !seen_src.contains(&slot.src),
                SlotKind::Opaque { removable: false } => false,
            })
    };
    for ordinal in 0..para_positions.len() {
        if referenced[ordinal] {
            continue;
        }
        if ordinal > 0
            && adjacent(ordinal - 1, ordinal)
            && (referenced[ordinal - 1] || absorbed[ordinal - 1])
        {
            uf.union(ordinal, ordinal - 1);
            absorbed[ordinal] = true;
        }
    }
    for ordinal in (0..para_positions.len()).rev() {
        if referenced[ordinal] || absorbed[ordinal] {
            continue;
        }
        if ordinal + 1 < para_positions.len()
            && adjacent(ordinal, ordinal + 1)
            && (referenced[ordinal + 1] || absorbed[ordinal + 1])
        {
            uf.union(ordinal, ordinal + 1);
            absorbed[ordinal] = true;
        } else {
            return Err(contract(
                "deleted paragraph is not next to a surviving paragraph",
            ));
        }
    }

    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); para_positions.len()];
    let mut gap_srcs = HashSet::new();
    for ordinal in 0..para_positions.len() {
        if referenced[ordinal] || absorbed[ordinal] {
            groups[uf.find(ordinal)].push(ordinal);
        }
    }

    let mut finals: Vec<Vec<Para>> = vec![Vec::new(); para_positions.len()];
    let mut kept_final: Vec<Vec<bool>> = vec![Vec::new(); para_positions.len()];
    let mut seq = 0usize;
    let mut staged: Vec<(SortKey, Step)> = Vec::new();
    let mut last_content: Option<usize> = None;
    for (item, links) in items.iter().zip(linked.iter()) {
        match item {
            Item::Para { para, kept } => {
                let Some(links) = links else { continue };
                if links.is_empty() {
                    if para.lock.is_some() {
                        return Err(contract("locked paragraph"));
                    }
                    staged.push((
                        SortKey {
                            pos: last_content.map(|index| index as isize).unwrap_or(-1),
                            rank: 1,
                            seq,
                        },
                        Step::Insert {
                            after: last_content,
                            block: Block::P(para.clone()),
                        },
                    ));
                    seq += 1;
                    continue;
                }
                let root = uf.find(links[0]);
                if links.iter().any(|ordinal| uf.find(*ordinal) != root) {
                    return Err(contract("region is not contiguous"));
                }
                finals[root].push(para.clone());
                kept_final[root].push(*kept);
                let end = group_end(&groups[root], &para_positions, &slots);
                last_content = Some(end);
            }
            Item::Table { table, kept } => {
                let src = table.src.ok_or_else(|| contract("inserted tables"))?;
                let position = by_src[&src];
                let content_index = slots[position].content_index;
                last_content = Some(content_index);
                if *kept {
                    continue;
                }
                let pristine = match &slots[position].block {
                    Block::Table(table) => table,
                    _ => return Err(contract("table src is not a table")),
                };
                if table_shape_changed(pristine, table) {
                    return Err(contract("row and column changes"));
                }
                staged.push((
                    SortKey {
                        pos: content_index as isize,
                        rank: 0,
                        seq,
                    },
                    Step::Table {
                        content_index,
                        table: table.clone(),
                    },
                ));
                seq += 1;
            }
            Item::InsertTable => return Err(contract("inserted tables")),
            Item::Opaque { src } => {
                let position = by_src[src];
                last_content = Some(slots[position].content_index);
            }
        }
    }

    for (root, ordinals) in groups.iter().enumerate() {
        if ordinals.is_empty() {
            continue;
        }
        let group_finals = &finals[root];
        let flags = &kept_final[root];
        if group_finals.is_empty() {
            return Err(contract(
                "deleted paragraph is not next to a surviving paragraph",
            ));
        }
        if flags.iter().all(|kept| *kept)
            && group_finals.len() == ordinals.len()
            && group_finals
                .iter()
                .zip(ordinals.iter())
                .all(|(para, ordinal)| para.src == Some(slots[para_positions[*ordinal]].src))
        {
            continue;
        }
        let src = group_finals[0]
            .src
            .ok_or_else(|| contract("paragraph has no src"))?;
        if group_finals.iter().any(|para| para.src != Some(src)) {
            return Err(contract("region paragraphs do not share a src"));
        }
        if group_finals.iter().any(|para| para.lock.is_some()) {
            return Err(contract("locked paragraph"));
        }
        if !ordinals
            .iter()
            .any(|ordinal| slots[para_positions[*ordinal]].src == src)
        {
            return Err(contract("region src is not one of its paragraphs"));
        }
        check_kept_atoms(&slots, &para_positions, ordinals, src, group_finals)?;
        let (mut paragraphs, mut gaps) =
            region_span(&slots, &para_positions, ordinals, &seen_src, &mut gap_srcs)?;
        // A deleted paragraph that holds a drawing, a break, or a field is removed
        // whole. Joining it first pulls that child into the survivor, and the kit
        // then refuses to project the paragraph. Text paragraphs still join, so a
        // bookmark in a deleted paragraph moves onto the survivor.
        let used = referenced_paragraphs(group_finals, sources);
        let mut kept = Vec::new();
        for index in paragraphs.drain(..) {
            let slot = slots
                .iter()
                .find(|slot| slot.content_index == index)
                .expect("paragraph slot");
            if used.contains(&slot.src) || !paragraph_holds_object(&slot.block) {
                kept.push(index);
            } else {
                gaps.push(index);
                gap_srcs.insert(slot.src);
            }
        }
        paragraphs = kept;
        let start = *paragraphs.first().expect("region has a paragraph");
        for (para, _) in group_finals.iter().zip(flags) {
            reject_fresh_atoms(&para.inlines)?;
        }
        staged.push((
            SortKey {
                pos: start as isize,
                rank: 0,
                seq,
            },
            Step::Region(Region {
                paragraphs,
                gaps,
                finals: group_finals.clone(),
            }),
        ));
        seq += 1;
    }

    for slot in &slots {
        if seen_src.contains(&slot.src) || gap_srcs.contains(&slot.src) {
            continue;
        }
        match slot.kind {
            SlotKind::Para => {}
            SlotKind::Table => {
                staged.push((
                    SortKey {
                        pos: slot.content_index as isize,
                        rank: 0,
                        seq,
                    },
                    Step::Remove {
                        content_index: slot.content_index,
                    },
                ));
                seq += 1;
            }
            SlotKind::Opaque { removable: true } => {
                staged.push((
                    SortKey {
                        pos: slot.content_index as isize,
                        rank: 0,
                        seq,
                    },
                    Step::Remove {
                        content_index: slot.content_index,
                    },
                ));
                seq += 1;
            }
            SlotKind::Opaque { removable: false } => {
                return Err(contract("non-removable block"));
            }
        }
    }

    staged.sort_by(|left, right| {
        (left.0.pos, left.0.rank, left.0.seq).cmp(&(right.0.pos, right.0.rank, right.0.seq))
    });
    Ok(Plan {
        steps: staged.into_iter().map(|(_, step)| step).collect(),
    })
}

struct SortKey {
    pos: isize,
    rank: u8,
    seq: usize,
}

struct Slot {
    src: u32,
    content_index: usize,
    kind: SlotKind,
    block: Block,
}

enum SlotKind {
    Para,
    Table,
    Opaque { removable: bool },
}

#[allow(clippy::large_enum_variant)]
enum Item {
    Para { para: Para, kept: bool },
    Table { table: Table, kept: bool },
    Opaque { src: u32 },
    InsertTable,
}

fn item_from_block(block: &Block, kept: bool) -> Result<Item, WriteError> {
    match block {
        Block::P(para) => {
            reject_fresh_atoms(&para.inlines)?;
            Ok(Item::Para {
                para: para.clone(),
                kept,
            })
        }
        Block::Table(table) => {
            if table.src.is_none() {
                Ok(Item::InsertTable)
            } else {
                Ok(Item::Table {
                    table: table.clone(),
                    kept,
                })
            }
        }
        Block::Opaque(opaque) => Ok(Item::Opaque { src: opaque.src }),
    }
}

fn body_slots(sources: &SourceMap, body: &[Block]) -> Result<Vec<Slot>, WriteError> {
    let mut slots = Vec::new();
    for block in body {
        let src =
            block_src(block).ok_or_else(|| contract("opened document has a block without src"))?;
        let content_index = match sources.blocks.get(src as usize) {
            Some(import::BlockOrigin::Paragraph(para)) => match sources.paras.get(*para as usize) {
                Some(Some(origin)) => match origin.addr {
                    ParaAddr::Body { content_index } => content_index,
                    ParaAddr::Cell { .. } => {
                        return Err(contract("body block points at a table cell"));
                    }
                },
                _ => return Err(contract(format!("paragraph {src} has no origin"))),
            },
            Some(import::BlockOrigin::Table { content_index })
            | Some(import::BlockOrigin::Opaque { content_index }) => *content_index,
            None => return Err(contract(format!("block {src} has no origin"))),
        };
        let kind = match block {
            Block::P(_) => SlotKind::Para,
            Block::Table(_) => SlotKind::Table,
            Block::Opaque(opaque) => SlotKind::Opaque {
                removable: opaque.removable,
            },
        };
        slots.push(Slot {
            src,
            content_index,
            kind,
            block: block.clone(),
        });
    }
    Ok(slots)
}

fn block_src(block: &Block) -> Option<u32> {
    match block {
        Block::P(para) => para.src,
        Block::Table(table) => table.src,
        Block::Opaque(opaque) => Some(opaque.src),
    }
}

fn paragraph_links(
    para: &Para,
    src_at: &HashMap<u32, usize>,
    sources: &SourceMap,
) -> Result<Vec<usize>, WriteError> {
    let mut found = Vec::new();
    let mut push = |ordinal: usize| {
        if !found.contains(&ordinal) {
            found.push(ordinal);
        }
    };
    if let Some(src) = para.src {
        if let Some(ordinal) = src_at.get(&src) {
            push(*ordinal);
        } else if sources
            .paras
            .get(src as usize)
            .and_then(|slot| slot.as_ref())
            .is_some()
        {
            return Err(contract(format!(
                "paragraph src {src} is not a body paragraph"
            )));
        } else {
            return Err(contract(format!("paragraph src {src} is unknown")));
        }
    }
    for inline in &para.inlines {
        let Some(run_src) = inline_run_src(inline) else {
            continue;
        };
        let Some(origin) = sources.runs.get(run_src as usize) else {
            return Err(contract(format!("run {run_src} is unknown")));
        };
        match src_at.get(&origin.para) {
            Some(ordinal) => push(*ordinal),
            None => {
                return Err(contract(format!(
                    "run {run_src} belongs to paragraph {} which is outside this story",
                    origin.para
                )));
            }
        }
    }
    if !found.is_empty() && para.src.is_none() {
        return Err(contract("paragraph has no src"));
    }
    Ok(found)
}

/// Paragraphs whose `w:pPr` or runs appear in the finals. The rest of a region
/// was deleted and exists only so the deletion has somewhere to land.
fn referenced_paragraphs(finals: &[Para], sources: &SourceMap) -> HashSet<u32> {
    let mut used = HashSet::new();
    for para in finals {
        if let Some(src) = para.src {
            used.insert(src);
        }
        for inline in &para.inlines {
            let Some(run) = inline_run_src(inline) else {
                continue;
            };
            if let Some(origin) = sources.runs.get(run as usize) {
                used.insert(origin.para);
            }
        }
    }
    used
}

fn paragraph_holds_object(block: &Block) -> bool {
    let Block::P(para) = block else {
        return false;
    };
    para.inlines.iter().any(|inline| {
        matches!(
            inline,
            Inline::Atom {
                atom: Atom::Image { .. }
                    | Atom::PageBreak {}
                    | Atom::ColumnBreak {}
                    | Atom::Field { .. },
                ..
            }
        )
    })
}

fn group_end(ordinals: &[usize], para_positions: &[usize], slots: &[Slot]) -> usize {
    ordinals
        .iter()
        .map(|ordinal| slots[para_positions[*ordinal]].content_index)
        .max()
        .unwrap_or(0)
}

fn check_kept_atoms(
    slots: &[Slot],
    para_positions: &[usize],
    ordinals: &[usize],
    survivor: u32,
    finals: &[Para],
) -> Result<(), WriteError> {
    for ordinal in ordinals {
        let src = slots[para_positions[*ordinal]].src;
        if src != survivor {
            continue;
        }
        let Block::P(pristine) = &slots[para_positions[*ordinal]].block else {
            continue;
        };
        for inline in &pristine.inlines {
            let Inline::Atom {
                atom: Atom::Opaque {
                    removable: false, ..
                },
                src: Some(run_src),
            } = inline
            else {
                continue;
            };
            let present = finals.iter().any(|para| {
                para.inlines
                    .iter()
                    .any(|inline| inline_run_src(inline) == Some(*run_src))
            });
            if !present {
                return Err(contract("non-removable atom"));
            }
        }
    }
    Ok(())
}

fn reject_fresh_atoms(inlines: &[Inline]) -> Result<(), WriteError> {
    for inline in inlines {
        let Inline::Atom { atom, src: None } = inline else {
            continue;
        };
        match atom {
            Atom::Image { .. } => return Err(contract("inserted images")),
            Atom::Field { .. } => return Err(contract("field")),
            Atom::PageBreak {} => return Err(contract("page break")),
            Atom::ColumnBreak {} => return Err(contract("column break")),
            Atom::Opaque { label, .. } if label == "bookmark" || label == "comment" => {}
            Atom::Opaque { label, .. } if label == "contentControl" => {}
            Atom::Opaque { .. } => return Err(contract("opaque atom")),
        }
    }
    Ok(())
}

fn check_run_order(imported: &wire::Imported, body: &[PatchBlock]) -> Result<(), WriteError> {
    let mut by_src = HashMap::new();
    index_blocks(&imported.body, &mut by_src);
    let mut last: Option<u32> = None;
    for block in body {
        let resolved = match block {
            PatchBlock::Keep { keep } => *by_src
                .get(keep)
                .ok_or_else(|| contract(format!("keep {keep} is not a pristine block")))?,
            PatchBlock::Changed(block) => block,
        };
        check_block_runs(resolved, &mut last)?;
    }
    Ok(())
}

fn check_block_runs(block: &Block, last: &mut Option<u32>) -> Result<(), WriteError> {
    match block {
        Block::P(para) => note_runs(&para.inlines, last),
        Block::Table(table) => {
            for row in &table.rows {
                for cell in &row.cells {
                    for child in &cell.blocks {
                        check_block_runs(child, last)?;
                    }
                }
            }
            Ok(())
        }
        Block::Opaque(_) => Ok(()),
    }
}

fn note_runs(inlines: &[Inline], last: &mut Option<u32>) -> Result<(), WriteError> {
    for inline in inlines {
        let Some(src) = inline_run_src(inline) else {
            continue;
        };
        if let Some(previous) = *last
            && src < previous
        {
            return Err(contract("source order"));
        }
        *last = Some(src);
    }
    Ok(())
}

fn index_blocks<'a>(blocks: &'a [Block], into: &mut HashMap<u32, &'a Block>) {
    for block in blocks {
        if let Some(src) = block_src(block) {
            into.insert(src, block);
        }
        if let Block::Table(table) = block {
            for row in &table.rows {
                for cell in &row.cells {
                    index_blocks(&cell.blocks, into);
                }
            }
        }
    }
}

fn table_shape_changed(pristine: &Table, edited: &Table) -> bool {
    if pristine.src != edited.src || pristine.rows.len() != edited.rows.len() {
        return true;
    }
    if pristine.grid_pt.len() != edited.grid_pt.len()
        || pristine
            .grid_pt
            .iter()
            .zip(&edited.grid_pt)
            .any(|(left, right)| (left - right).abs() > 0.05)
    {
        return true;
    }
    for (left_row, right_row) in pristine.rows.iter().zip(&edited.rows) {
        if left_row.src != right_row.src
            || left_row.header != right_row.header
            || left_row.cant_split != right_row.cant_split
            || left_row.cells.len() != right_row.cells.len()
        {
            return true;
        }
        for (left_cell, right_cell) in left_row.cells.iter().zip(&right_row.cells) {
            if left_cell.src != right_cell.src
                || left_cell.span != right_cell.span
                || left_cell.v_merge != right_cell.v_merge
            {
                return true;
            }
            if non_para_srcs(&left_cell.blocks) != non_para_srcs(&right_cell.blocks) {
                return true;
            }
        }
    }
    false
}

fn non_para_srcs(blocks: &[Block]) -> Vec<Option<u32>> {
    blocks
        .iter()
        .filter_map(|block| match block {
            Block::P(_) => None,
            other => Some(block_src(other)),
        })
        .collect()
}

struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
        }
    }

    fn find(&mut self, mut index: usize) -> usize {
        while self.parent[index] != index {
            self.parent[index] = self.parent[self.parent[index]];
            index = self.parent[index];
        }
        index
    }

    fn union(&mut self, left: usize, right: usize) {
        let left = self.find(left);
        let right = self.find(right);
        if left != right {
            self.parent[right] = left;
        }
    }
}

fn apply_styles(doc: &mut Document, roles: &[String]) -> Result<(), WriteError> {
    for role in roles {
        let (id, name) = match role.as_str() {
            "normal" => ("Normal", "Normal"),
            "title" => ("Title", "Title"),
            "heading1" => ("Heading1", "heading 1"),
            "heading2" => ("Heading2", "heading 2"),
            "heading3" => ("Heading3", "heading 3"),
            other => return Err(contract(format!("added style {other}"))),
        };
        if doc.style(id).is_some() {
            continue;
        }
        doc.add_style(StyleBuilder::paragraph(id, name))?;
    }
    Ok(())
}

fn apply_lists(
    doc: &mut Document,
    lists: &[(i32, wire::ListDef)],
) -> Result<BTreeMap<i32, u32>, WriteError> {
    let mut ids = BTreeMap::new();
    for (id, definition) in lists {
        if *id >= 0 {
            return Err(contract(format!("new list {id} is not a fresh id")));
        }
        let mut levels = Vec::new();
        for level in &definition.levels {
            levels.push(list_level(level)?);
        }
        let real = doc.add_list_definition(&levels);
        if real == 0 {
            return Err(contract("list definition"));
        }
        ids.insert(*id, real);
    }
    Ok(ids)
}

fn list_level(level: &wire::ListLevel) -> Result<ListLevel, WriteError> {
    let format = match level.format.as_str() {
        "bullet" => ListNumberFormat::Bullet,
        "decimal" => ListNumberFormat::Decimal,
        "lowerLetter" => ListNumberFormat::LowerLetter,
        "upperLetter" => ListNumberFormat::UpperLetter,
        "lowerRoman" => ListNumberFormat::LowerRoman,
        "upperRoman" => ListNumberFormat::UpperRoman,
        "chineseCounting" => ListNumberFormat::ChineseCounting,
        "ideographTraditional" => ListNumberFormat::IdeographTraditional,
        "decimalEnclosedCircle" => ListNumberFormat::DecimalEnclosedCircle,
        "none" => ListNumberFormat::None,
        other => return Err(contract(format!("list format {other}"))),
    };
    Ok(ListLevel::new(format)
        .start(level.start)
        .level_text(level.text.clone())
        .indentation(
            Some(Twips::from_pt(level.indent_left_pt)),
            Some(Twips::from_pt(level.hanging_pt)),
            None,
        ))
}

fn apply_region(
    doc: &mut Document,
    region: &Region,
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    // Higher indexes first, so removing a gap does not move a later gap.
    let mut gaps = region.gaps.clone();
    gaps.sort_unstable();
    for index in gaps.iter().rev() {
        remove_content(doc, *index, ctx.removed, ctx.list_ids)?;
    }
    let mut indices = Vec::new();
    let mut srcs = Vec::new();
    for index in &region.paragraphs {
        let shift = gaps.iter().filter(|gap| *gap < index).count();
        indices.push(*index - shift);
        srcs.push(body_para_src(ctx.sources, *index)?);
    }
    if indices.windows(2).any(|pair| pair[1] != pair[0] + 1) {
        return Err(contract("region crosses a non-paragraph"));
    }
    let mut loc = BodyLoc { doc };
    apply_joined(&mut loc, &indices, &srcs, &region.finals, ctx)
}

/// The paragraphs of one region, plus the dropped blocks that sit between them.
fn region_span(
    slots: &[Slot],
    para_positions: &[usize],
    ordinals: &[usize],
    seen_src: &HashSet<u32>,
    gap_srcs: &mut HashSet<u32>,
) -> Result<(Vec<usize>, Vec<usize>), WriteError> {
    let start_ord = *ordinals.iter().min().expect("group");
    let end_ord = *ordinals.iter().max().expect("group");
    let start = slots[para_positions[start_ord]].content_index;
    let end = slots[para_positions[end_ord]].content_index;
    let members: HashSet<usize> = ordinals.iter().copied().collect();
    let mut paragraphs = Vec::new();
    for (ordinal, position) in para_positions.iter().enumerate() {
        let index = slots[*position].content_index;
        if index < start || index > end {
            continue;
        }
        if !members.contains(&ordinal) {
            return Err(contract("region crosses a non-paragraph"));
        }
        paragraphs.push(index);
    }
    let mut gaps = Vec::new();
    for slot in slots {
        if slot.content_index <= start || slot.content_index >= end {
            continue;
        }
        match slot.kind {
            SlotKind::Para => {}
            SlotKind::Table | SlotKind::Opaque { removable: true } => {
                if seen_src.contains(&slot.src) {
                    return Err(contract("region crosses a non-paragraph"));
                }
                gaps.push(slot.content_index);
                gap_srcs.insert(slot.src);
            }
            SlotKind::Opaque { removable: false } => {
                return Err(contract("non-removable block"));
            }
        }
    }
    Ok((paragraphs, gaps))
}

fn apply_insert(
    doc: &mut Document,
    after: Option<usize>,
    block: &Block,
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    let Block::P(para) = block else {
        return Err(contract("inserted tables"));
    };
    let index = after.map(|index| index + 1).unwrap_or(0);
    {
        let _paragraph = doc.insert_paragraph(index, "");
    }
    let mut loc = BodyLoc { doc };
    patch_paragraph(&mut loc, index, &[], para, ctx)
}

fn remove_content(
    doc: &mut Document,
    index: usize,
    removed: &mut BTreeMap<String, usize>,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<(), WriteError> {
    let counts = verify::body_index_counts(doc, index);
    // A fresh list that no paragraph references yet is dropped when removal
    // reopens the package, and a later list's id slides down onto it. Point a
    // surviving paragraph at each such list for the duration of the removal.
    let pins = pin_unreferenced_lists(doc, index, list_ids)?;
    let removed_it = doc.try_remove_content(index)?;
    restore_numbering_pins(doc, &pins, removed_it.then_some(index))?;
    match removed_it {
        true => {
            merge_counts(removed, counts);
            Ok(())
        }
        false => Err(contract(format!("content {index} was not removed"))),
    }
}

struct NumberingPin {
    index: usize,
    previous: Option<(u32, u32)>,
}

fn pin_unreferenced_lists(
    doc: &mut Document,
    removing: usize,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<Vec<NumberingPin>, WriteError> {
    let mut used = HashSet::new();
    for item in doc.body_items() {
        if let rdocx::BodyItemRef::Paragraph(para) = item
            && let Some((id, _)) = para.numbering()
        {
            used.insert(id);
        }
    }
    let missing: Vec<u32> = list_ids
        .values()
        .copied()
        .filter(|id| !used.contains(id))
        .collect();
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let anchors: Vec<usize> = doc
        .body_items()
        .enumerate()
        .filter_map(|(index, item)| {
            matches!(item, rdocx::BodyItemRef::Paragraph(_))
                .then_some(index)
                .filter(|index| *index != removing)
        })
        .take(missing.len())
        .collect();
    if anchors.len() < missing.len() {
        return Err(contract("fresh list has nowhere to stay during removal"));
    }
    let mut pins = Vec::new();
    for (anchor, id) in anchors.into_iter().zip(missing) {
        let previous = body_numbering(doc, anchor)?;
        set_body_numbering(doc, anchor, Some((id, 0)))?;
        pins.push(NumberingPin {
            index: anchor,
            previous,
        });
    }
    Ok(pins)
}

fn restore_numbering_pins(
    doc: &mut Document,
    pins: &[NumberingPin],
    removed: Option<usize>,
) -> Result<(), WriteError> {
    for pin in pins {
        let index = match removed {
            Some(removed) if pin.index > removed => pin.index - 1,
            _ => pin.index,
        };
        set_body_numbering(doc, index, pin.previous)?;
    }
    Ok(())
}

fn body_numbering(doc: &Document, index: usize) -> Result<Option<(u32, u32)>, WriteError> {
    let paragraph_index = doc
        .paragraph_index_of_content(index)
        .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
    let paragraph = doc
        .paragraph(paragraph_index)
        .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
    Ok(paragraph.numbering())
}

fn set_body_numbering(
    doc: &mut Document,
    index: usize,
    numbering: Option<(u32, u32)>,
) -> Result<(), WriteError> {
    let paragraph_index = doc
        .paragraph_index_of_content(index)
        .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
    let mut paragraph = doc
        .paragraph_mut(paragraph_index)
        .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
    if !paragraph.set_numbering_value(numbering) {
        return Err(contract("numbering"));
    }
    Ok(())
}

fn find_table(blocks: &[Block], src: Option<u32>) -> Option<&Table> {
    let src = src?;
    for block in blocks {
        if let Block::Table(table) = block
            && table.src == Some(src)
        {
            return Some(table);
        }
    }
    None
}

fn patch_table(
    doc: &mut Document,
    content_index: usize,
    pristine: &Table,
    edited: &Table,
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    let ordinal = table_ordinal(doc, content_index)?;
    for (row_index, (pristine_row, edited_row)) in
        pristine.rows.iter().zip(&edited.rows).enumerate()
    {
        for (cell_index, (pristine_cell, edited_cell)) in
            pristine_row.cells.iter().zip(&edited_row.cells).enumerate()
        {
            patch_cell(
                doc,
                ordinal,
                row_index,
                cell_index,
                pristine_cell,
                edited_cell,
                ctx,
            )?;
        }
    }
    Ok(())
}

fn table_ordinal(doc: &Document, content_index: usize) -> Result<usize, WriteError> {
    let mut ordinal = 0usize;
    for (index, item) in doc.body_items().enumerate() {
        if let rdocx::BodyItemRef::Table(_) = item
            && index == content_index
        {
            return Ok(ordinal);
        }
        if let rdocx::BodyItemRef::Table(_) = item {
            ordinal += 1;
        } else if index == content_index {
            return Err(contract(format!("content {content_index} is not a table")));
        }
    }
    Err(contract(format!(
        "table at content {content_index} is missing"
    )))
}

fn patch_cell(
    doc: &mut Document,
    ordinal: usize,
    row: usize,
    cell_index: usize,
    pristine: &wire::Cell,
    edited: &wire::Cell,
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    let pristine_paras: Vec<&Para> = pristine
        .blocks
        .iter()
        .filter_map(|block| match block {
            Block::P(para) => Some(para),
            _ => None,
        })
        .collect();
    let edited_paras: Vec<&Para> = edited
        .blocks
        .iter()
        .filter_map(|block| match block {
            Block::P(para) => Some(para),
            _ => None,
        })
        .collect();
    if pristine_paras.len() == edited_paras.len()
        && pristine_paras
            .iter()
            .zip(&edited_paras)
            .all(|(pristine, edited)| pristine.src == edited.src)
        && edited_paras
            .iter()
            .all(|para| para_runs_stay(para, ctx.sources))
    {
        for (paragraph_index, para) in edited_paras.iter().enumerate() {
            let src = para
                .src
                .ok_or_else(|| contract("table cell paragraph has no src"))?;
            let runs = runs_of(ctx.sources, src);
            let mut loc = CellLoc {
                doc,
                ordinal,
                row,
                cell: cell_index,
            };
            patch_paragraph(&mut loc, paragraph_index, &runs, para, ctx)?;
        }
        return Ok(());
    }
    // Splits and joins inside a cell use the same join-then-split sequence as the body.
    let mut loc = CellLoc {
        doc,
        ordinal,
        row,
        cell: cell_index,
    };
    let indices: Vec<usize> = (0..pristine_paras.len()).collect();
    let srcs: Vec<u32> = pristine_paras
        .iter()
        .map(|para| {
            para.src
                .ok_or_else(|| contract("table cell paragraph has no src"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut owned: Vec<Para> = edited_paras.into_iter().cloned().collect();
    // Clearing a cell replaces its paragraphs with a new one that has no src.
    // It is still that cell's text, so it takes the survivor paragraph's src.
    if let Some(survivor) = pristine_paras.first().and_then(|para| para.src) {
        for para in &mut owned {
            if para.src.is_none() {
                para.src = Some(survivor);
            }
        }
    }
    if owned.iter().any(|para| para.src.is_none()) {
        return Err(contract("inserted paragraph"));
    }
    // A cell whose paragraphs were only edited in place already returned. Reaching here with a
    // different src sequence still has to be one region: the cell is one story.
    apply_joined(&mut loc, &indices, &srcs, &owned, ctx)
}

fn para_runs_stay(para: &Para, sources: &SourceMap) -> bool {
    let Some(src) = para.src else {
        return false;
    };
    para.inlines.iter().all(|inline| {
        inline_run_src(inline).is_none_or(|run_src| {
            sources
                .runs
                .get(run_src as usize)
                .is_some_and(|origin| origin.para == src)
        })
    })
}

trait Story {
    fn join(&mut self, index: usize, keep: rdocx::ParagraphPropertyKeep) -> Result<(), WriteError>;
    fn split_para(&mut self, index: usize, run_index: usize) -> Result<(), WriteError>;
    fn with_para<T>(
        &mut self,
        index: usize,
        edit: impl FnOnce(&mut Paragraph<'_>) -> Result<T, WriteError>,
    ) -> Result<T, WriteError>;
    fn direct_props(&mut self, index: usize) -> Result<ParaProps, WriteError>;
}

struct BodyLoc<'a> {
    doc: &'a mut Document,
}

impl Story for BodyLoc<'_> {
    fn join(&mut self, index: usize, keep: rdocx::ParagraphPropertyKeep) -> Result<(), WriteError> {
        Ok(self.doc.join_paragraphs(index, keep)?)
    }

    fn split_para(&mut self, index: usize, run_index: usize) -> Result<(), WriteError> {
        Ok(self.doc.split_paragraph(index, run_index)?)
    }

    fn with_para<T>(
        &mut self,
        index: usize,
        edit: impl FnOnce(&mut Paragraph<'_>) -> Result<T, WriteError>,
    ) -> Result<T, WriteError> {
        let paragraph_index = self
            .doc
            .paragraph_index_of_content(index)
            .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
        let mut paragraph = self
            .doc
            .paragraph_mut(paragraph_index)
            .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
        edit(&mut paragraph)
    }

    fn direct_props(&mut self, index: usize) -> Result<ParaProps, WriteError> {
        let paragraph_index = self
            .doc
            .paragraph_index_of_content(index)
            .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
        let paragraph = self
            .doc
            .paragraph(paragraph_index)
            .ok_or_else(|| contract(format!("body index {index} is not a paragraph")))?;
        Ok(import::direct_props(&paragraph))
    }
}

struct CellLoc<'a> {
    doc: &'a mut Document,
    ordinal: usize,
    row: usize,
    cell: usize,
}

impl Story for CellLoc<'_> {
    fn join(&mut self, index: usize, keep: rdocx::ParagraphPropertyKeep) -> Result<(), WriteError> {
        let mut table = self
            .doc
            .table_mut(self.ordinal)
            .ok_or_else(|| contract("table is out of range"))?;
        let mut cell = table
            .cell(self.row, self.cell)
            .ok_or_else(|| contract("cell is out of range"))?;
        Ok(cell.join_paragraphs(index, keep)?)
    }

    fn split_para(&mut self, index: usize, run_index: usize) -> Result<(), WriteError> {
        let mut table = self
            .doc
            .table_mut(self.ordinal)
            .ok_or_else(|| contract("table is out of range"))?;
        let mut cell = table
            .cell(self.row, self.cell)
            .ok_or_else(|| contract("cell is out of range"))?;
        Ok(cell.split_paragraph(index, run_index)?)
    }

    fn with_para<T>(
        &mut self,
        index: usize,
        edit: impl FnOnce(&mut Paragraph<'_>) -> Result<T, WriteError>,
    ) -> Result<T, WriteError> {
        let mut table = self
            .doc
            .table_mut(self.ordinal)
            .ok_or_else(|| contract("table is out of range"))?;
        let mut cell = table
            .cell(self.row, self.cell)
            .ok_or_else(|| contract("cell is out of range"))?;
        let mut paragraph = cell
            .paragraph_mut(index)
            .ok_or_else(|| contract("cell paragraph is out of range"))?;
        edit(&mut paragraph)
    }

    fn direct_props(&mut self, index: usize) -> Result<ParaProps, WriteError> {
        let table = self
            .doc
            .table(self.ordinal)
            .ok_or_else(|| contract("table is out of range"))?;
        let cell = table
            .cell(self.row, self.cell)
            .ok_or_else(|| contract("cell is out of range"))?;
        let paragraph = cell
            .paragraph(index)
            .ok_or_else(|| contract("cell paragraph is out of range"))?;
        Ok(import::direct_props(&paragraph))
    }
}

fn apply_joined<S: Story>(
    loc: &mut S,
    indices: &[usize],
    srcs: &[u32],
    finals: &[Para],
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    if indices.is_empty() || finals.is_empty() {
        return Err(contract("region is empty"));
    }
    let keep_src = finals[0]
        .src
        .ok_or_else(|| contract("paragraph has no src"))?;
    let keep_offset = srcs
        .iter()
        .position(|src| *src == keep_src)
        .ok_or_else(|| contract("region src is not one of its paragraphs"))?;
    // Join every paragraph after the survivor into it, then every paragraph before it.
    // Each join removes the following paragraph, so the survivor's index only moves when
    // a preceding paragraph is joined with Keep::Second.
    let mut current = indices[keep_offset];
    let after = indices.len() - keep_offset - 1;
    for _ in 0..after {
        loc.join(current, rdocx::ParagraphPropertyKeep::First)?;
    }
    for _ in 0..keep_offset {
        loc.join(current - 1, rdocx::ParagraphPropertyKeep::Second)?;
        current -= 1;
    }
    debug_assert_eq!(current, indices[0]);

    let mut run_srcs = Vec::new();
    for src in srcs {
        run_srcs.extend(runs_of(ctx.sources, *src));
    }
    let run_count = loc.with_para(current, |paragraph| Ok(paragraph.run_count()))?;
    if run_count != run_srcs.len() {
        return Err(contract(format!(
            "joined paragraph has {run_count} runs but the source map has {}",
            run_srcs.len()
        )));
    }

    let per_final = if finals.len() == 1 {
        vec![run_srcs]
    } else {
        split_finals(loc, current, &run_srcs, finals, ctx)?
    };
    for (offset, (para, runs)) in finals.iter().zip(per_final).enumerate() {
        patch_paragraph(loc, current + offset, &runs, para, ctx)?;
    }
    Ok(())
}

struct SimRun {
    src: u32,
    origin: usize,
}

/// Give each final paragraph the source runs its pieces use.
///
/// A piece's text is not a slice of the pristine run: it may be longer, shorter,
/// empty, or entirely new, and the pieces of one run may sit in different
/// paragraphs. Each piece becomes its own run. The text is written afterwards,
/// so the offset used to clone the run does not matter.
fn split_finals<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    run_srcs: &[u32],
    finals: &[Para],
    ctx: &mut Apply<'_>,
) -> Result<Vec<Vec<u32>>, WriteError> {
    let paragraphs = finals
        .iter()
        .map(|para| grouped_srcs(&para.inlines))
        .collect::<Result<Vec<_>, _>>()?;
    // A comment or bookmark marker sits on a run boundary. A split at 0 sends
    // every run to the next paragraph and leaves only a marker that was already
    // on that boundary. Runs no final uses are removed first, so a marker the
    // model kept in an earlier paragraph is not carried off with the deleted text.
    let mut run_srcs = run_srcs.to_vec();
    drop_unused_runs(loc, paragraph_index, &mut run_srcs, &paragraphs, ctx)?;
    let flat: Vec<u32> = paragraphs.iter().flatten().copied().collect();
    let mut cursor = 0usize;
    let mut opened = false;
    let mut flat_index = 0usize;
    let mut layout = Vec::new();
    let mut boundaries = Vec::new();
    for (para_index, takes) in paragraphs.iter().enumerate() {
        for src in takes {
            while cursor < run_srcs.len() && run_srcs[cursor] != *src {
                if opened {
                    return Err(contract("source order"));
                }
                layout.push(SimRun {
                    src: run_srcs[cursor],
                    origin: cursor,
                });
                cursor += 1;
            }
            if cursor >= run_srcs.len() {
                return Err(contract(format!("run {src} is not in the paragraph")));
            }
            layout.push(SimRun {
                src: *src,
                origin: cursor,
            });
            let follows = flat.get(flat_index + 1).copied() == Some(*src);
            flat_index += 1;
            if follows {
                opened = true;
            } else {
                cursor += 1;
                opened = false;
            }
        }
        if para_index + 1 != paragraphs.len() {
            boundaries.push(layout.len());
        }
    }
    while cursor < run_srcs.len() {
        if opened {
            return Err(contract("source order"));
        }
        layout.push(SimRun {
            src: run_srcs[cursor],
            origin: cursor,
        });
        cursor += 1;
    }

    let mut counts: BTreeMap<usize, usize> = BTreeMap::new();
    for run in &layout {
        *counts.entry(run.origin).or_default() += 1;
    }
    // Higher origins stay put while a lower run grows, so expand from the right.
    for (origin, count) in counts.into_iter().rev() {
        expand_run(loc, paragraph_index, origin, count)?;
    }
    for boundary in boundaries.iter().rev() {
        loc.split_para(paragraph_index, *boundary)?;
    }

    let mut slices = Vec::new();
    let mut from = 0usize;
    for boundary in boundaries {
        slices.push(layout[from..boundary].iter().map(|run| run.src).collect());
        from = boundary;
    }
    slices.push(layout[from..].iter().map(|run| run.src).collect());
    Ok(slices)
}

fn drop_unused_runs<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    run_srcs: &mut Vec<u32>,
    paragraphs: &[Vec<u32>],
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    let used: HashSet<u32> = paragraphs.iter().flatten().copied().collect();
    if run_srcs.iter().all(|src| used.contains(src)) {
        return Ok(());
    }
    let mut srcs: Vec<Option<u32>> = run_srcs.iter().copied().map(Some).collect();
    let mut index = srcs.len();
    while index > 0 {
        index -= 1;
        if srcs[index].is_some_and(|src| !used.contains(&src)) {
            remove_at(loc, paragraph_index, &mut srcs, index, ctx.removed)?;
        }
    }
    *run_srcs = srcs.into_iter().flatten().collect();
    Ok(())
}

/// One source run becomes `count` runs that each carry a clone of its `w:rPr`.
///
/// `split_run` at offset 1 is the call that clones the run. Offset 0 and an
/// offset equal to the literal length return the boundary and leave the
/// paragraph unchanged, so the piece length is not a usable split point. Text
/// is written onto each run afterwards. Non-text children have no literal
/// width and stay on the side of this offset they already occupy; markers stay
/// on their run boundaries. A run of fewer than two characters cannot be
/// split, and the copies still required come from `insert_run_like`, which
/// clones `w:rPr` and leaves the original run's children, and the markers
/// immediately before the insertion, where they are. `split_run` goes first
/// because it also works inside a hyperlink, where `insert_run_like` is refused.
fn expand_run<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    run_index: usize,
    count: usize,
) -> Result<(), WriteError> {
    if count <= 1 {
        return Ok(());
    }
    let mut made = 1usize;
    let mut tail = run_index;
    while made < count {
        let len = loc.with_para(paragraph_index, |paragraph| {
            let run = paragraph
                .run(tail)
                .ok_or_else(|| contract("run index is out of range"))?;
            Ok(literal_len(&run))
        })?;
        if len >= 2 {
            loc.with_para(paragraph_index, |paragraph| {
                paragraph.split_run(tail, 1)?;
                Ok(())
            })?;
            tail += 1;
            made += 1;
        } else {
            let insert_at = run_index + made;
            let like = tail;
            loc.with_para(paragraph_index, |paragraph| {
                paragraph.insert_run_like(insert_at, like, "")?;
                Ok(())
            })?;
            made += 1;
        }
    }
    Ok(())
}

fn grouped_srcs(inlines: &[Inline]) -> Result<Vec<u32>, WriteError> {
    let mut srcs = Vec::new();
    for src in source_srcs(inlines)? {
        if srcs.last().copied() != Some(src) {
            srcs.push(src);
        }
    }
    Ok(srcs)
}

fn source_srcs(inlines: &[Inline]) -> Result<Vec<u32>, WriteError> {
    let mut srcs = Vec::new();
    let mut index = 0;
    while index < inlines.len() {
        let skip = skipped_width(inlines, index);
        if skip > 0 {
            index += skip;
            continue;
        }
        match &inlines[index] {
            Inline::Text { src: Some(src), .. } | Inline::Atom { src: Some(src), .. } => {
                srcs.push(*src);
            }
            _ => {}
        }
        index += 1;
    }
    Ok(srcs)
}

fn patch_paragraph<S: Story>(
    loc: &mut S,
    index: usize,
    run_srcs: &[u32],
    target: &Para,
    ctx: &mut Apply<'_>,
) -> Result<(), WriteError> {
    apply_props(loc, index, &target.props, ctx.list_ids)?;
    let mut srcs: Vec<Option<u32>> = run_srcs.iter().copied().map(Some).collect();
    let segments = segments(&target.inlines)?;
    let mut cursor = 0usize;
    for segment in segments {
        match segment {
            Segment::Fresh(piece) => {
                insert_fresh(loc, index, &mut srcs, cursor, &piece, ctx)?;
                cursor += 1;
            }
            Segment::Run(group) => {
                cursor = apply_run(loc, index, &mut srcs, cursor, &group, ctx)?;
            }
        }
    }
    while cursor < srcs.len() {
        remove_at(loc, index, &mut srcs, cursor, ctx.removed)?;
    }
    Ok(())
}

enum Segment {
    Run(RunGroup),
    Fresh(Piece),
}

struct RunGroup {
    src: u32,
    items: Vec<GroupItem>,
}

enum GroupItem {
    Text(Piece),
    Fresh(Piece),
}

#[derive(Clone)]
struct Piece {
    text: String,
    marks: Marks,
    literal: usize,
}

fn segments(inlines: &[Inline]) -> Result<Vec<Segment>, WriteError> {
    let mut events = Vec::new();
    let mut index = 0;
    while index < inlines.len() {
        let skip = skipped_width(inlines, index);
        if skip > 0 {
            index += skip;
            continue;
        }
        match &inlines[index] {
            Inline::Text {
                text,
                marks,
                src: Some(src),
            } => events.push(Ev::Source {
                src: *src,
                piece: Piece {
                    text: text.clone(),
                    marks: marks.clone(),
                    literal: model_literal_len(text),
                },
            }),
            Inline::Atom { src: Some(src), .. } => events.push(Ev::Source {
                src: *src,
                piece: Piece {
                    text: String::new(),
                    marks: Marks::default(),
                    literal: 0,
                },
            }),
            Inline::Text {
                text,
                marks,
                src: None,
            } if !text.is_empty() => events.push(Ev::Fresh(Piece {
                text: text.clone(),
                marks: marks.clone(),
                literal: model_literal_len(text),
            })),
            Inline::Atom { src: None, .. } | Inline::Text { src: None, .. } => {}
        }
        index += 1;
    }

    let mut segments = Vec::new();
    for (index, event) in events.iter().enumerate() {
        match event {
            Ev::Fresh(piece) => {
                let next_src = events[index + 1..].iter().find_map(|event| event.src());
                let attach = matches!(
                    segments.last(),
                    Some(Segment::Run(group)) if Some(group.src) == next_src
                );
                if attach {
                    let Some(Segment::Run(group)) = segments.last_mut() else {
                        continue;
                    };
                    group.items.push(GroupItem::Fresh(piece.clone()));
                } else {
                    segments.push(Segment::Fresh(piece.clone()));
                }
            }
            Ev::Source { src, piece } => {
                if let Some(Segment::Run(group)) = segments.last_mut()
                    && group.src == *src
                {
                    if piece.literal > 0 || !piece.text.is_empty() {
                        group.items.push(GroupItem::Text(piece.clone()));
                    }
                } else if piece.literal == 0 && piece.text.is_empty() {
                    segments.push(Segment::Run(RunGroup {
                        src: *src,
                        items: Vec::new(),
                    }));
                } else {
                    segments.push(Segment::Run(RunGroup {
                        src: *src,
                        items: vec![GroupItem::Text(piece.clone())],
                    }));
                }
            }
        }
    }
    Ok(segments)
}

enum Ev {
    Source { src: u32, piece: Piece },
    Fresh(Piece),
}

impl Ev {
    fn src(&self) -> Option<u32> {
        match self {
            Ev::Source { src, .. } => Some(*src),
            Ev::Fresh(_) => None,
        }
    }
}

fn skipped_width(inlines: &[Inline], index: usize) -> usize {
    let Some(inline) = inlines.get(index) else {
        return 0;
    };
    if is_marker(inline) {
        return 1;
    }
    if let Inline::Text { src: None, .. } = inline
        && let Some(Inline::Atom {
            atom: Atom::Opaque { label, .. },
            src: None,
        }) = inlines.get(index + 1)
        && label == "contentControl"
    {
        return 2;
    }
    if let Inline::Atom {
        atom: Atom::Opaque { label, .. },
        src: None,
    } = inline
        && (label == "contentControl" || label == "bookmark" || label == "comment")
    {
        return 1;
    }
    0
}

fn is_marker(inline: &Inline) -> bool {
    matches!(
        inline,
        Inline::Atom {
            atom: Atom::Opaque { label, .. },
            src: None,
        } if label == "bookmark" || label == "comment"
    )
}

fn apply_run<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    srcs: &mut Vec<Option<u32>>,
    cursor: usize,
    group: &RunGroup,
    ctx: &mut Apply<'_>,
) -> Result<usize, WriteError> {
    while cursor < srcs.len() && srcs[cursor] != Some(group.src) {
        if srcs[cursor].is_some_and(|src| srcs[cursor + 1..].contains(&Some(src))) {
            return Err(contract("source order"));
        }
        remove_at(loc, paragraph_index, srcs, cursor, ctx.removed)?;
    }
    if cursor >= srcs.len() || srcs[cursor] != Some(group.src) {
        return Err(contract(format!("run {} is missing", group.src)));
    }

    let text_pieces: Vec<&Piece> = group
        .items
        .iter()
        .filter_map(|item| match item {
            GroupItem::Text(piece) => Some(piece),
            GroupItem::Fresh(_) => None,
        })
        .collect();
    let concat: String = text_pieces
        .iter()
        .map(|piece| piece.text.as_str())
        .collect();
    let imported = ctx.texts.get(&group.src).map(String::as_str).unwrap_or("");
    let needs_split = text_pieces.len() > 1
        || group
            .items
            .iter()
            .any(|item| matches!(item, GroupItem::Fresh(_)));
    // set_text replaces every typed child, so a run that still mixes text with a
    // non-text child is refused rather than rewritten.
    let protected = loc.with_para(paragraph_index, |paragraph| {
        let run = paragraph
            .run(cursor)
            .ok_or_else(|| contract("run index is out of range"))?;
        Ok(is_protected(&run))
    })?;
    if protected && (concat != imported || needs_split) {
        return Err(contract(format!(
            "run {} contains unmodeled content",
            group.src
        )));
    }
    if text_pieces.len() > 1 {
        // Clone first. The piece lengths are not offsets into the pristine text.
        expand_run(loc, paragraph_index, cursor, text_pieces.len())?;
        for (offset, piece) in text_pieces.iter().enumerate() {
            loc.with_para(paragraph_index, |paragraph| {
                with_run(paragraph, cursor + offset, |run| {
                    write_text(run, &piece.text)
                })
            })?;
        }
        let src = srcs[cursor];
        srcs.splice(
            cursor..cursor + 1,
            std::iter::repeat_n(src, text_pieces.len()),
        );
    } else if !protected {
        // A paragraph split clones the run at an arbitrary interior offset, so the
        // bytes in the run are not the piece even when the piece equals the
        // pristine text. Compare the run, not the import.
        let current = loc.with_para(paragraph_index, |paragraph| {
            let run = paragraph
                .run(cursor)
                .ok_or_else(|| contract("run index is out of range"))?;
            Ok(run.text())
        })?;
        if current != concat {
            loc.with_para(paragraph_index, |paragraph| {
                with_run(paragraph, cursor, |run| write_text(run, &concat))
            })?;
        }
    }

    let mut physical = cursor;
    for item in &group.items {
        match item {
            GroupItem::Text(piece) => {
                apply_piece_marks(loc, paragraph_index, physical, piece, Some(group.src), ctx)?;
                physical += 1;
            }
            GroupItem::Fresh(piece) => {
                insert_fresh(loc, paragraph_index, srcs, physical, piece, ctx)?;
                physical += 1;
            }
        }
    }
    if group.items.is_empty() {
        physical = cursor + 1;
    }
    Ok(physical)
}

fn apply_piece_marks<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    run_index: usize,
    piece: &Piece,
    run_src: Option<u32>,
    ctx: &Apply<'_>,
) -> Result<(), WriteError> {
    let original_link = run_src
        .and_then(|src| ctx.links.get(&src).cloned())
        .flatten();
    if piece.marks.link != original_link {
        return Err(contract("hyperlink"));
    }
    let current = loc.with_para(paragraph_index, |paragraph| {
        let run = paragraph
            .run(run_index)
            .ok_or_else(|| contract("run index is out of range"))?;
        Ok(import::direct_marks(&run))
    })?;
    if marks_same(&current, &piece.marks) {
        return Ok(());
    }
    loc.with_para(paragraph_index, |paragraph| {
        with_run(paragraph, run_index, |run| {
            apply_mark_values(run, &current, &piece.marks)
        })?;
        Ok(())
    })
}

fn insert_fresh<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    srcs: &mut Vec<Option<u32>>,
    at: usize,
    piece: &Piece,
    _ctx: &Apply<'_>,
) -> Result<(), WriteError> {
    if piece.marks.link.is_some() {
        return Err(contract("hyperlink"));
    }
    loc.with_para(paragraph_index, |paragraph| {
        let count = paragraph.run_count();
        if count == 0 {
            let _run = paragraph.add_run_inheriting_mark(&piece.text);
        } else {
            let like = if at == 0 { 0 } else { at - 1 };
            paragraph.insert_run_like(at, like, &piece.text)?;
        }
        if piece.text.chars().any(|ch| ch == '\t' || ch == '\n') {
            with_run(paragraph, at, |run| write_text(run, &piece.text))?;
        }
        let current = import::direct_marks(
            &paragraph
                .run(at)
                .ok_or_else(|| contract("inserted run is missing"))?,
        );
        if !marks_same(&current, &piece.marks) {
            with_run(paragraph, at, |run| {
                apply_mark_values(run, &current, &piece.marks)
            })?;
        }
        Ok(())
    })?;
    srcs.insert(at, None);
    Ok(())
}

fn remove_at<S: Story>(
    loc: &mut S,
    paragraph_index: usize,
    srcs: &mut Vec<Option<u32>>,
    at: usize,
    removed: &mut BTreeMap<String, usize>,
) -> Result<(), WriteError> {
    let counts = loc.with_para(paragraph_index, |paragraph| {
        let run = paragraph
            .run(at)
            .ok_or_else(|| contract("run index is out of range"))?;
        Ok(verify::run_counts(&run))
    })?;
    loc.with_para(paragraph_index, |paragraph| {
        paragraph.remove_run(at)?;
        Ok(())
    })?;
    srcs.remove(at);
    merge_counts(removed, counts);
    Ok(())
}

fn with_run(
    paragraph: &mut Paragraph<'_>,
    index: usize,
    edit: impl FnOnce(&mut Run<'_>) -> Result<(), WriteError>,
) -> Result<(), WriteError> {
    if paragraph.run(index).is_none() {
        return Err(contract("run index is out of range"));
    }
    if paragraph.run_mut(index).is_some() {
        let mut run = paragraph
            .run_mut(index)
            .ok_or_else(|| contract("run index is out of range"))?;
        edit(&mut run)
    } else {
        let path = paragraph
            .run_path(index)
            .ok_or_else(|| contract("run index is out of range"))?;
        let mut error = None;
        paragraph.edit_run(&path, |run| {
            if let Err(found) = edit(run) {
                error = Some(found);
            }
        })?;
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn write_text(run: &mut Run<'_>, text: &str) -> Result<(), WriteError> {
    if !text.chars().any(|ch| ch == '\t' || ch == '\n') {
        run.set_text(text);
        return Ok(());
    }
    let mut buf = String::new();
    let mut started = false;
    for ch in text.chars() {
        if ch == '\t' || ch == '\n' {
            if !buf.is_empty() {
                if started {
                    run.add_text(&buf);
                } else {
                    run.set_text(&buf);
                    started = true;
                }
                buf.clear();
            }
            if !started {
                run.set_text("");
                started = true;
            }
            if ch == '\t' {
                run.add_tab();
            } else {
                run.add_break(BreakKind::Line);
            }
        } else {
            buf.push(ch);
        }
    }
    if !buf.is_empty() {
        if started {
            run.add_text(&buf);
        } else {
            run.set_text(&buf);
        }
    } else if !started {
        run.set_text("");
    }
    Ok(())
}

fn apply_mark_values(
    run: &mut Run<'_>,
    current: &Marks,
    desired: &Marks,
) -> Result<(), WriteError> {
    if current.bold != desired.bold {
        run.set_bold_value(desired.bold);
    }
    if current.italic != desired.italic {
        run.set_italic_value(desired.italic);
    }
    if current.underline != desired.underline {
        let style = match desired.underline {
            None => None,
            Some(true) => Some(UnderlineStyle::Single),
            Some(false) => Some(UnderlineStyle::None),
        };
        run.set_underline_style_value(style);
    }
    if current.strike != desired.strike {
        run.set_strike_value(desired.strike);
    }
    if current.font != desired.font {
        run.set_font_value(desired.font.as_deref());
    }
    if current.font_east_asia != desired.font_east_asia {
        run.set_slot_font(RunFontSlot::EastAsia, desired.font_east_asia.as_deref());
    }
    if !same_opt(current.size_pt, desired.size_pt) {
        run.set_size_value(desired.size_pt);
    }
    if current.color != desired.color {
        run.set_color_value(desired.color.as_deref());
    }
    if current.highlight != desired.highlight
        && !run.set_highlight_value(desired.highlight.as_deref())
    {
        return Err(contract(format!(
            "highlight {}",
            desired.highlight.as_deref().unwrap_or("none")
        )));
    }
    if current.vert_align != desired.vert_align {
        match desired.vert_align.as_deref() {
            Some("super") => run.set_superscript_value(Some(true)),
            Some("sub") => run.set_subscript_value(Some(true)),
            None => {
                run.set_superscript_value(None);
                run.set_subscript_value(None);
            }
            Some(other) => return Err(contract(format!("vertAlign {other}"))),
        }
    }
    if current.char_style != desired.char_style {
        run.set_style_value(desired.char_style.as_deref());
    }
    Ok(())
}

fn marks_same(current: &Marks, desired: &Marks) -> bool {
    current.bold == desired.bold
        && current.italic == desired.italic
        && current.underline == desired.underline
        && current.strike == desired.strike
        && current.font == desired.font
        && current.font_east_asia == desired.font_east_asia
        && same_opt(current.size_pt, desired.size_pt)
        && current.color == desired.color
        && current.highlight == desired.highlight
        && current.vert_align == desired.vert_align
        && current.char_style == desired.char_style
}

fn apply_props<S: Story>(
    loc: &mut S,
    index: usize,
    desired: &ParaProps,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<(), WriteError> {
    let current = loc.direct_props(index)?;
    if let Some(chars) = desired.first_line_chars
        && current.first_line_chars != Some(chars)
    {
        loc.with_para(index, |paragraph| {
            paragraph.set_first_line_chars_value(Some(i64::from(chars)));
            Ok(())
        })?;
    }
    if current.style != desired.style {
        loc.with_para(index, |paragraph| {
            paragraph.set_style_value(desired.style.as_deref());
            Ok(())
        })?;
    }
    if current.align != desired.align {
        let align = match desired.align.as_deref() {
            None => None,
            Some("left") => Some(Alignment::Left),
            Some("center") => Some(Alignment::Center),
            Some("right") => Some(Alignment::Right),
            Some("justify") => Some(Alignment::Justify),
            Some(other) => return Err(contract(format!("alignment {other}"))),
        };
        loc.with_para(index, |paragraph| {
            paragraph.set_alignment_value(align);
            Ok(())
        })?;
    }
    if !same_opt(current.indent_left, desired.indent_left) {
        loc.with_para(index, |paragraph| {
            paragraph.set_indent_left_value(desired.indent_left.map(Length::pt));
            Ok(())
        })?;
    }
    if !same_opt(current.indent_right, desired.indent_right) {
        loc.with_para(index, |paragraph| {
            paragraph.set_indent_right_value(desired.indent_right.map(Length::pt));
            Ok(())
        })?;
    }
    if !same_opt(current.first_line, desired.first_line)
        || !same_opt(current.hanging, desired.hanging)
    {
        let signed = match (desired.first_line, desired.hanging) {
            (None, None) => None,
            (Some(pt), None) => Some(Length::pt(pt)),
            (None, Some(pt)) => Some(Length::pt(-pt)),
            (Some(_), Some(_)) => {
                return Err(contract("first line and hanging"));
            }
        };
        loc.with_para(index, |paragraph| {
            paragraph.set_signed_first_line_indent_value(signed);
            Ok(())
        })?;
    }
    if !same_opt(current.space_before, desired.space_before) {
        loc.with_para(index, |paragraph| {
            paragraph.set_space_before_value(desired.space_before.map(Length::pt));
            Ok(())
        })?;
    }
    if !same_opt(current.space_after, desired.space_after) {
        loc.with_para(index, |paragraph| {
            paragraph.set_space_after_value(desired.space_after.map(Length::pt));
            Ok(())
        })?;
    }
    if !same_line(&current.line, &desired.line) {
        match &desired.line {
            None => {
                loc.with_para(index, |paragraph| {
                    paragraph.clear_line_spacing();
                    Ok(())
                })?;
            }
            Some(LineSpacing::Auto { multiple }) => {
                let multiple = *multiple;
                loc.with_para(index, |paragraph| {
                    paragraph.set_line_spacing_multiple(multiple);
                    Ok(())
                })?;
            }
            Some(LineSpacing::Exact { pt }) => {
                let pt = *pt;
                loc.with_para(index, |paragraph| {
                    paragraph.set_line_spacing(pt);
                    Ok(())
                })?;
            }
            Some(LineSpacing::AtLeast { .. }) => {
                return Err(contract("line spacing atLeast"));
            }
        }
    }
    let desired_numbering = map_numbering(desired.numbering, list_ids)?;
    let current_numbering = match current.numbering {
        None => None,
        Some(None) => Some(None),
        Some(Some((id, level))) => Some(Some((id as u32, level))),
    };
    if current_numbering != desired_numbering {
        let numbering = match desired_numbering {
            None => None,
            Some(None) => Some((0, 0)),
            Some(Some((id, level))) => Some((id, level)),
        };
        let applied = loc.with_para(index, |paragraph| {
            Ok(paragraph.set_numbering_value(numbering))
        })?;
        if !applied {
            return Err(contract("numbering"));
        }
    }
    set_toggle(
        loc,
        index,
        current.keep_next,
        desired.keep_next,
        |paragraph, value| {
            paragraph.set_keep_with_next_value(value);
        },
    )?;
    set_toggle(
        loc,
        index,
        current.keep_lines,
        desired.keep_lines,
        |paragraph, value| {
            paragraph.set_keep_together_value(value);
        },
    )?;
    set_toggle(
        loc,
        index,
        current.page_break_before,
        desired.page_break_before,
        |paragraph, value| paragraph.set_page_break_before_value(value),
    )?;
    set_toggle(
        loc,
        index,
        current.widow_control,
        desired.widow_control,
        |paragraph, value| paragraph.set_widow_control_value(value),
    )?;
    Ok(())
}

fn set_toggle<S: Story>(
    loc: &mut S,
    index: usize,
    current: Option<bool>,
    desired: Option<bool>,
    set: impl Fn(&mut Paragraph<'_>, Option<bool>),
) -> Result<(), WriteError> {
    if current == desired {
        return Ok(());
    }
    loc.with_para(index, |paragraph| {
        set(paragraph, desired);
        Ok(())
    })
}

fn map_numbering(
    numbering: Option<Option<(i32, u32)>>,
    list_ids: &BTreeMap<i32, u32>,
) -> Result<Option<Option<(u32, u32)>>, WriteError> {
    match numbering {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some((id, level))) => {
            let id = if id < 0 {
                *list_ids
                    .get(&id)
                    .ok_or_else(|| contract(format!("list {id} was not defined")))?
            } else {
                id as u32
            };
            Ok(Some(Some((id, level))))
        }
    }
}

fn same_line(want: &Option<LineSpacing>, got: &Option<LineSpacing>) -> bool {
    match (want, got) {
        (None, None) => true,
        (Some(LineSpacing::Auto { multiple: want }), Some(LineSpacing::Auto { multiple: got })) => {
            (want - got).abs() < 0.01
        }
        (Some(LineSpacing::Exact { pt: want }), Some(LineSpacing::Exact { pt: got }))
        | (Some(LineSpacing::AtLeast { pt: want }), Some(LineSpacing::AtLeast { pt: got })) => {
            (want - got).abs() < 0.05
        }
        _ => false,
    }
}

fn same_opt(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => (left - right).abs() < 0.05,
        _ => false,
    }
}

fn runs_of(sources: &SourceMap, para: u32) -> Vec<u32> {
    let mut runs = Vec::new();
    for (src, origin) in sources.runs.iter().enumerate() {
        if origin.para == para {
            runs.push((origin.run_index, src as u32));
        }
    }
    runs.sort_by_key(|(index, _)| *index);
    runs.into_iter().map(|(_, src)| src).collect()
}

fn body_para_src(sources: &SourceMap, content_index: usize) -> Result<u32, WriteError> {
    for (src, origin) in sources.paras.iter().enumerate() {
        if let Some(import::ParaOrigin {
            addr: ParaAddr::Body {
                content_index: found,
            },
        }) = origin
            && *found == content_index
        {
            return Ok(src as u32);
        }
    }
    Err(contract(format!(
        "body index {content_index} is not a paragraph"
    )))
}

fn literal_len(run: &RunRef<'_>) -> usize {
    run.items()
        .map(|item| match item {
            RunItemRef::Text(text) | RunItemRef::DeletedText(text) => text.chars().count(),
            _ => 0,
        })
        .sum()
}

fn model_literal_len(text: &str) -> usize {
    text.chars().filter(|ch| *ch != '\t' && *ch != '\n').count()
}

fn is_protected(run: &RunRef<'_>) -> bool {
    run.items().any(|item| {
        matches!(
            item,
            RunItemRef::Field(_)
                | RunItemRef::Drawing(_)
                | RunItemRef::FootnoteReference(_)
                | RunItemRef::EndnoteReference(_)
                | RunItemRef::CommentReference(_)
                | RunItemRef::Symbol { .. }
                | RunItemRef::SpecialCharacter(_)
                | RunItemRef::LegacyHorizontalRule(_)
                | RunItemRef::Break(_)
                | RunItemRef::LastRenderedPageBreak(_)
                | RunItemRef::UnsupportedXml(_)
        )
    })
}

fn inline_run_src(inline: &Inline) -> Option<u32> {
    match inline {
        Inline::Text { src, .. } | Inline::Atom { src, .. } => *src,
    }
}

fn run_texts(blocks: &[Block]) -> HashMap<u32, String> {
    let mut texts = HashMap::new();
    fn walk(blocks: &[Block], texts: &mut HashMap<u32, String>) {
        for block in blocks {
            match block {
                Block::P(para) => note_text(&para.inlines, texts),
                Block::Table(table) => {
                    for row in &table.rows {
                        for cell in &row.cells {
                            walk(&cell.blocks, texts);
                        }
                    }
                }
                Block::Opaque(opaque) => {
                    for para in &opaque.preview {
                        note_text(&para.inlines, texts);
                    }
                }
            }
        }
    }
    fn note_text(inlines: &[Inline], texts: &mut HashMap<u32, String>) {
        for inline in inlines {
            if let Inline::Text {
                text,
                src: Some(src),
                ..
            } = inline
            {
                texts.entry(*src).or_default().push_str(text);
            }
        }
    }
    walk(blocks, &mut texts);
    texts
}

fn run_links(blocks: &[Block]) -> HashMap<u32, Option<String>> {
    let mut links = HashMap::new();
    fn walk(blocks: &[Block], links: &mut HashMap<u32, Option<String>>) {
        for block in blocks {
            match block {
                Block::P(para) => {
                    for inline in &para.inlines {
                        if let Inline::Text {
                            src: Some(src),
                            marks,
                            ..
                        } = inline
                        {
                            links.entry(*src).or_insert_with(|| marks.link.clone());
                        }
                    }
                }
                Block::Table(table) => {
                    for row in &table.rows {
                        for cell in &row.cells {
                            walk(&cell.blocks, links);
                        }
                    }
                }
                Block::Opaque(opaque) => {
                    for para in &opaque.preview {
                        for inline in &para.inlines {
                            if let Inline::Text {
                                src: Some(src),
                                marks,
                                ..
                            } = inline
                            {
                                links.entry(*src).or_insert_with(|| marks.link.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    walk(blocks, &mut links);
    links
}

fn merge_counts(into: &mut BTreeMap<String, usize>, extra: BTreeMap<String, usize>) {
    for (key, count) in extra {
        *into.entry(key).or_insert(0) += count;
    }
}
