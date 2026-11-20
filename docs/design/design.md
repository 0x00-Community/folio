# Word for Dopame OS: chosen design

Base: candidate B (`candidate-b/design.md`, sketches in `candidate-b/sketch/`). Read that document for the full shape.
This file records the synthesis decision and every place the build deviates from candidate B. Where the two disagree,
this file wins.

## Synthesis decision

Candidate B is the base. The decision is measured, not argued.

| Measurement (acdert 0.0.10, this machine) | Candidate A path | Candidate B path |
| --- | --- | --- |
| One-character edit, Chinese document, 8 pages | 179 ms rdocx relayout (127 ms without caller fonts) | 0.11 ms p50, 0.46 ms p95 for DOM edit plus re-measure, 137 pages |
| Same, 37 pages | 548 ms | unchanged (only mounted pages lay out) |
| Merge two paragraphs, 8 / 37 pages | 51 / 135 ms staged `remove_content` per merge | model edit; staged cost moves to save |

Probes: `scratchpad/wasmprobe`, `scratchpad/probe` (session scratchpad). Candidate A's per-keystroke relayout cannot
meet a two-frame budget for Chinese text, and rdocx has no incremental layout. The Grok cross-judge
(`grok-4.7-xhigh-fast`, read-only) independently scored A 1/5 and B 4/5 on latency and recommended B.

Grafted from candidate A:

1. **PDF from one caller-font layout.** Export lays out once with the system CJK fonts as caller fonts and renders that
   layout to PDF. It never calls `Document::to_pdf`, which lays out again with bundled fonts only (CJK becomes boxes).
2. **Print preview from rdocx layout, on demand only.** A read-only "打印预览" mode paints rdocx's `PageFrame`s as
   absolutely positioned HTML spans (A's Painting section). It runs only when the user opens it or exports. Never at
   idle: there are no workers, so an idle layout freezes the page for 179-548 ms.
3. **Opaque by default.** At import, a paragraph whose model text does not round-trip to `ParagraphRef::text()`, or whose
   runs `remove_run` would refuse, becomes locked or an `OpaqueBlock` instead of a reconstructed paragraph (A's "Content
   the editor cannot address").

## Deviations from candidate B

- **Tests run on Node, not Bun.** Bun is not installed. Pure TypeScript tests use `node --test` with Node 24's built-in
  type stripping, so source must use erasable syntax only (no `enum`, no `namespace`, no parameter properties) and
  relative imports carry the `.ts` extension. `tsc --noEmit` type-checks. Rust uses `cargo test` natively.
- **End-to-end checks run through the acde CLI** (`scripts/e2e/acde.mjs`: `acde eval`, `acde act`, `acde shot`), since
  `acde test` needs Bun.
- **Display fonts are system fonts by family name.** acdert paints installed fonts by CSS family name (measured: SimSun,
  Songti SC, PingFang). `@font-face` blob URLs are needed only for rdocx's bundled substitutes (Carlito for Calibri and
  so on), served as static files from `public/fonts/`.
- **The font service already exists** as `server/fonts.ts` (`scanFonts`, family names in every language, CJK flag).
  `server.ts` wraps it.

## rdocx upstream work (branch, user-approved)

On a branch of `/Users/lilleap/code/rdocx`, never `main`. Each item has a regression test in rdocx.

1. **Keep `w:ind` character units on re-serialization.** Measured: editing one character in each paragraph of a real
   thesis dropped all 256 `w:firstLineChars`. Parse and write `firstLineChars`, `hangingChars`, `leftChars`/`startChars`,
   `rightChars`/`endChars`. Add getters and `_value` setters.
2. **Keep `w:u` `w:color` / `w:themeColor`.** Measured: 22 underline colors dropped on the same edit.
3. `Document::split_paragraph(body_index, run_boundary)` and the table-cell twin, in place. Markers stay with the side
   they are on, and both halves keep the full `w:pPr`.
4. `Document::join_paragraphs(body_index, keep)` and the cell twin, in place, where `keep` names the side whose `w:pPr`
   survives.
5. `Document::remove_content_range(start, end)` as one staged operation.
6. `Paragraph::insert_run_like(at, like_run, text)`, which clones `like_run`'s `w:rPr`.

7. `ParagraphRef::has_section_break()`. Measured: on a real thesis, finding section-ending paragraphs through
   `StoryItemRef` cost 4.9 s (each call rescans the story) and through `story_item_snapshots` 750 ms (it serializes
   every item). Reading the paragraph's own `w:sectPr` is constant time.

The branch is `work/editing-kit-grok`, checked out at `/Users/lilleap/code/rdocx-editing-kit`. Items 1-6 and two review
fixes were verified there: the new tests pass, the existing suites fail only where `main` already fails, clippy, fmt, the
wasm32 check and the hash harness are clean, and split-then-join restores the bytes of every paragraph of the corpus and
the thesis. The engine builds against this branch from round 1 on, because item 7 is needed for import speed and items
1-6 for save.

## Build order

Each unit ends in a check that must pass before its result merges. Code is written by Grok delegates
(`grok-4.7-xhigh-fast` through `cursor-agent`), each in its own git worktree. Claude owns briefs, review and verification.

| Round | Unit | Owner | Check |
| --- | --- | --- | --- |
| 0 | Scaffold: remove the textarea prototype, TypeScript and test tooling, `src/model.ts` types from the sketch, engine crate skeleton building to wasm | Grok | `npm run typecheck`, `npm test`, `scripts/build-engine.sh`, `acde check` |
| 1 | rdocx branch, items 1-6 above | Grok, rdocx worktree | rdocx `cargo test` for the new tests; thesis edit diff loses nothing |
| 1 | Bridge import, `engine.ts` parse, font service endpoint | Grok | corpus: every paragraph's `flatText` matches rdocx text; `checkDoc` passes |
| 1 | Model helpers, commands, history | Grok | `node --test` property tests: random command sequences keep `checkDoc`, undo restores the original object |
| 1 | `render.ts`, `pages.ts`: render, measure, paginate, virtualize, caret, selection, hit test, line motion | Grok | dev page in acdert: synthetic 100-page doc, click puts caret on the clicked character, Up/Down keeps the goal column across a page break |
| 2 | `editor.ts`, `input.ts`, app shell (open, new, toolbar, menus, zh/en) | Grok | e2e: open fixture, type, Enter, Backspace across paragraphs, arrows, bold at caret, undo |
| 3 | Save (`write.rs`, verify), save as, dirty state, close guard | Grok | e2e plus native: edit fixtures, save, reopen, text and marks match; unmodeled-item multiset unchanged |
| 4 | Tables, images, page setup, lists UI | Grok | e2e per feature, round-trip through save |
| 5 | PDF export through caller fonts, print preview | Grok | Chinese fixture PDF embeds SimSun, `pdftotext` matches |
| 6 | Automation interface: operate the document and read its structure (planned, see below) | Grok | a script edits `basic.docx` through the interface alone and reads back the outline, saved bytes match |

## Round 6 (planned): an automation interface

Requested on 2026-11-20. Not designed yet. This section records the request and what a design has to settle.

A caller that is not a person at the keyboard (an agent, a test, another app) needs two things from the editor.

1. **Operate the document.** Click at a place, press Enter, type text, insert a table, an image or a page break, and
   the other edits the toolbar offers.
2. **Read the document.** Three views of the same model:
   - the document structure: blocks in order with their kind (paragraph, table, image, opaque), sections and pages;
   - the text structure: each paragraph's text, runs and marks, list level and number, and table cells;
   - the chapter structure: the outline built from heading styles, with each heading's level, number, text, page
     and the range of blocks it covers.

What exists today and why it is not this interface:

- `acde inspect` and `acde act` drive the real window. They see only mounted pages, name a paragraph by its flat
  text, and cannot address a position inside one.
- `window.__word` (`src/main.ts`) is a dev hook for the e2e scripts. It exists in dev builds only, has no stable
  shape, and gives out the internal model objects.

What a design has to settle before any code:

- **Addressing.** How a caller names a place: a paragraph id and an offset (`Pos` in `src/model.ts`), a heading
  path, a text search result, or a page and a point. Ids must stay valid across edits the caller did not make.
- **Operations as commands, not events.** Every operation should run a `Command` from `src/editor/edit.ts`
  through `Editor.run`, so it lands in the undo history and in save exactly as a keystroke does. "Click" then means
  "set the selection at an address", and a click at a pixel is a separate, view-dependent call.
- **Transport.** Which runtime channel carries it: app requests (`appWindow.on('request')`, kinds declared in
  `acde.config.jsonc`), an MCP surface, or the app's backend. Read the acde guides `agents.md`, `mcp.md` and
  `open.md` first. Do not guess the API.
- **A stable, versioned shape** for the three read views that does not leak `src` origins or other internals, and a
  size bound for long documents (a page or block range per call).
- **Results.** Each operation answers with what changed (the new selection, the ids of blocks created or removed) or
  a typed refusal (a locked paragraph, an address that no longer exists).
- **Consent and safety.** Whether another app may edit an open document without the user seeing it, and what the
  user sees while it happens.
