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
| 6 | Automation interface: operate the document and read its structure (see below) | Grok | a script edits `basic.docx` through the interface alone and reads back the outline, saved bytes match |
| 7 | Print fidelity: merged rows across pages, font memory, page breaks that match the preview, table borders from the file (see below) | Grok, kit and app worktrees | on the private document no text past a page and memory under the window's limit; drift report at 0.9 or better |

## Round 6: an automation interface

Requested on 2026-11-20, designed on 2026-11-21. A caller that is not a person at the keyboard (an agent, a test,
later another app) operates the open document and reads its structure.

### What acde 0.0.10 can carry (read from its guides, not guessed)

| Channel | Reaches the page | Carries an answer back | Where it exists |
| --- | --- | --- | --- |
| `acde eval` and the MCP `eval` tool | yes, runs code in the page | yes, the awaited value as JSON | `acde dev` sessions |
| App requests (`open('word', { kind })`, `appWindow.on('request')`) | yes, one structured-cloneable object | no. `open` resolves with `{ window }` only | everywhere |
| The app's backend (`server.ts`) | only from this app's own page | not reachable by another app | everywhere |
| A desktop service (`acde:<name>`) | belongs to the desktop package, not to an app | yes | desktops that ship it |
| `acde:inspect` (`snapshot`, `act`, `query`) | the accessibility tree, mounted pages only | text of the tree | the desktop and its services |

No channel lets another app ask this app a question and get the answer. So the interface is a page object with
JSON in and JSON out, and the transport is a thin wrapper that comes later.

### Decisions

- **Surface.** `window.word`, in every build: `{ version: 1, call(request): Promise<Response> }`. A request is one
  JSON object with an `op`. A response is one JSON object. Nothing else crosses: no model objects, no `src`
  identities, no functions. Code lives in `src/automation/` and reaches the editor only through `Editor`'s public
  methods and the commands of `src/editor/edit.ts`.
- **Transport this round.** `acde eval word 'word.call({...})'` and the MCP `eval` tool. That serves tests and
  coding agents. The app declares no `requests` this round, because a request cannot answer and half an interface
  (writes with no result, no reads) is worse than none. When acde gains a channel that answers, it wraps `call`
  unchanged.
- **Addressing.** A place is `{ para: ParaId, offset }`: the editor's own `Pos`. `offset` is a UTF-16 offset into
  the paragraph's flat text where an atom counts one, or `'end'`. Paragraph, table and opaque ids are minted per
  session, never reused, and survive every edit that does not remove their block, so an id a caller holds stays
  valid across edits it did not make. Every other way to name a place is a read that returns addresses: `outline`
  gives heading ids, `find` gives `{ para, start, end }` ranges, `blocks` gives block ids by index and page, and
  `hitTest` turns a window point into an address for mounted pages (the only view-dependent call).
- **Operations are commands.** Every operation builds a `Command` and runs it through `Editor.run`, so it lands in
  the undo history and in save as a keystroke does. "Click" is `select`. An edit may carry `at` (an address or a
  range), which sets the selection first. The selection step has intent `none` and adds no undo entry.
- **Reads.** Three views of the same `Doc`, all pure functions of the model plus a page lookup:
  `blocks` (document structure), `text` (text structure), `outline` (chapter structure), with `info`, `selection`
  and `find` beside them. `blocks` and `text` take `from` and `count` over body block indexes and answer `total` and
  `next`. One call returns at most 500 blocks. Headings are paragraphs whose style's `w:name` is `heading 1` to
  `heading 9`, at the top level of the body.
- **Results.** An edit answers `{ ok: true, rev, selection, created, removed }`: the selection after it and the ids
  of blocks that appeared and disappeared. A refusal is `{ ok: false, error: { code, message } }` with a closed set
  of codes: `bad-request`, `unknown-op`, `unsupported-version`, `unknown-address`, `out-of-range`, `locked`,
  `read-only-story`, `busy`, `refused`. `rev` counts document changes from any source, so a caller can tell that
  someone else edited between two of its calls.
- **Consent and what the user sees.** This round only something that can already run code in the page reaches the
  interface, so there is no second party to ask about. Automated edits are not hidden: they run through
  `Editor.run`, so the caret moves, the view scrolls to it, and Ctrl+Z takes each one back. While the print preview
  or a dialog is open, or an IME composition is in progress, edits answer `busy` and reads still work. A prompt or
  a visible "being edited by" mark is a decision for the round that adds a cross-app transport.
- **`window.__word` stays** as the test hook for what is not part of the interface: loading fixture bytes, save
  bytes, the tampered save, memory and timing probes. It keeps no editing helpers once the e2e scripts that use
  them move to `word.call`. Moving them is not part of this round.

The data shapes and the checks are in `docs/briefs/r6-automation.md`.

## Round 7: print fidelity

Chosen by the user on 2026-11-21 from the open items of the earlier rounds. It closes the four that round 5
recorded. The causes below were read from the code, not run. The brief makes each unit confirm its cause first.

| Open item | Where it comes from | Decision |
| --- | --- | --- |
| A vertically merged row runs past the page (82 characters lost on the private document) | The kit's paginator places rows one at a time and refuses to split a row that touches a vertical merge. The restart cell is painted with the summed height of its span from its own row, so any merge that lands on two pages overflows the first. | Fix in the kit: a merged cell's content divides at the page end and continues on the next page. The reference is Word's PDF of the private document, since the repo records no rule. |
| Wasm memory 490 MB and 1.3 GB | Every face added to the session is copied whole five times per layout, used or not, and every face named in the style table is fetched. Half of the recorded size is still unexplained. | Measure per stage first. Then pass only the faces the text uses, and share one `Arc<[u8]>` per face from the session through the kit to the layout result. Target: high-water mark at most the baseline plus 2.5 times the face bytes, and under the window's 512 MB for the private document. |
| 59 pages in the preview, 50 in the editing view (`long.docx`) | Nothing has ever compared the two paginations (candidate B's risk 4 was not run). The leading candidate is the line box of runs that mix Latin and Chinese. Four smaller differences are verified by reading. | Build the comparison first: the print layout reports a page per body block and a drift report compares it with the editing view's. Fix what it shows, the kit side before the editing view. Pass mark: 90 percent of blocks start on the same page (the mark candidate B set), page counts within 2 percent. |
| The editing view draws borders on every table | The model, the wire format and the importer carry no borders. CSS draws them unconditionally. | Import resolved table and cell borders (direct, then the style chain, then the cell) and draw only those. |

Decisions that hold across the units:

- **The preview is the reference for the editing view, and Word is the reference for the preview.** When the two
  views differ, the first question is whether the preview is wrong against Word. Only then does the editing view
  move toward it. The tradeoff candidate B accepted (drift of a line or two per page) stays. This round gives it
  a number.
- **No layout at idle still holds.** The drift report is a development tool behind `window.__word`. The app does
  not adopt page breaks from rdocx at idle in this round. That stays the fallback candidate B named, to be
  decided from the report if the pass mark is not reached.
- **Kit signatures that exist do not change.** Shared font bytes arrive through new entry points, and the old
  ones wrap them, so the other crates of the kit keep building.
- **Borders are view data this round.** Save does not write them back and verify does not compare them, because
  the editor has no control that changes a border. A table the editor inserts carries in the model the borders
  save already writes for it.

The findings, the data shapes and the checks are in `docs/briefs/r7-print-fidelity.md`.
