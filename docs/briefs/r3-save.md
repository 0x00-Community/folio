# Round 3 brief: save

Status: not started. Unit 1 (the rdocx editing kit) runs first, in the rdocx worktree, from its own brief.

## Goal

A user opens a `.docx`, edits it, and saves. The saved file opens in Word with the edits in place and with everything
the editor does not model (bookmarks, comments, fields, content controls, raw XML, unmodeled run and paragraph
properties) exactly as it was. Today `Source.save` throws and the toolbar has no Save control.

Save never works on the session's live document. Each save writes the model onto a fresh copy of the document as
opened, verifies the result by importing it again, and only then returns bytes. A failed save writes nothing and
leaves the document dirty.

## Read first

- `docs/design/design.md`, then `docs/design/candidate-b/design.md`, section "Save patches the original and keeps
  unmodeled content". It is the specification for `write` and `verify`.
- `docs/design/candidate-b/sketch/bridge.rs`: the `Patch`, `PatchBlock`, `BridgeError`, `write`, `plan`, `Region`,
  `Step` and `verify::Ledger` sketches. Line numbers into rdocx in that file are from an older rdocx. Find the
  functions by name.
- `engine/src/import.rs` (`SourceMap`, `ParaOrigin`, `RunOrigin`, `RowOrigin`, `CellOrigin`), `engine/src/wire.rs`,
  `engine/src/lib.rs` (`Session`).
- `src/model.ts` (the `src` fields and the invariants at the top), `src/editor/edit.ts` (`mergeSide`: which side's
  `src` and props survive a join), `src/engine/engine.ts` (`toDoc`, `bindSource`, `SaveVerifyError`), `src/app.ts`.
- The rdocx editing kit at `/Users/user/code/rdocx-editing-kit` (`crates/rdocx/src/document.rs`, `paragraph.rs`,
  `run.rs`): `split_paragraph`, `join_paragraphs`, `remove_content_range`, `insert_run_like`, the character-unit
  indent getters and `_value` setters, plus the existing `clone_for_staging`, `split_run`, `remove_run`,
  `add_run_inheriting_mark`, `try_remove_content`, `add_list_definition`, `add_style`, and the `_value` mark setters.
- The acde skill copy in `.audit/acde-skill/`: `guide/files.md` (pickers, `createWritable`) and `guide/window.md`
  (`beforeclose`).

## Data shapes

| Shape | Structure | Owner |
| --- | --- | --- |
| Patch | `{ body: PatchBlock[], sections, newLists, addedStyles }` as sketched. `PatchBlock` is `{ keep: BlockSrc }` or a full block. | `wire.rs`, mirrored in `wire.ts` |
| Keep | A block is `keep` exactly when it is the same object import produced (`===` against the imported block of that `src`). No change flags, no diffing of content on the TypeScript side. | `engine.ts` |
| Plan | `Vec<Step>` with `Region`, `Insert`, `Remove`, `Table`, as sketched, built by `plan` and applied back to front. | `write.rs` |
| Ledger | `BTreeMap<String, usize>` of unmodeled item fingerprints, counted once at import and kept in the `Session`. | `verify.rs` |
| Save result | `Result<Vec<u8>, BridgeError>` with `BridgeError::Write { detail }` and `BridgeError::Verify { first_difference }`. | `lib.rs` |
| Open file | `{ handle, name, saved: Doc }` as today. Dirty stays `editor.state.doc !== file.saved`. A successful save sets `saved` to the document that was written. No dirty flag, no "saving" boolean outside the one in-flight promise. | `app.ts` |

## Scope of what a save must write

Everything the editor can change today: text typed, deleted, split and joined across paragraphs in the body and in
table cells. The marks bold, italic, underline, strike, font, font size. Paragraph style, alignment, and bullet and
numbered lists, including a list created this session (`newLists`) and a built-in style the document lacks
(`addedStyles`). Removing a removable opaque block or atom.

Not in this round, and `plan` rejects them with `WriteError::Contract` naming the feature: inserted tables, row and
column changes, inserted images, page setup changes. A changed table whose only change is paragraph text inside its
cells is in scope. Headers and footers are not editable yet and are always kept.

## Units and checks

Each unit ends in its check. Do not start the next unit before the check passes. Units 2 to 4 are separate
dispatches.

2. **Engine write and verify (Rust).** `engine/src/write.rs`, `engine/src/verify.rs`, the `Patch` types in `wire.rs`,
   `Session::save(&self, patch_json: &str) -> Result<Vec<u8>, JsValue>`. The ledger is built at import. Check, native
   `cargo test` in `engine/tests/save.rs`, building patches in Rust from the import of each fixture:
   - A patch of only `keep` blocks: the written document imports to a model equal to the first import, for
     `basic.docx`, `long.docx` and `preserve.docx`, and the ledger is unchanged.
   - One test per edit kind in scope: text in a run, text spanning two source runs, a new run with marks in the middle
     of a paragraph, split one paragraph into three, join three into one with each `keep` side, delete a whole
     paragraph that carries a bookmark (the bookmark survives in the neighbor), each mark set and cleared, font and
     size, style, alignment, a new list, text inside a table cell, removing a removable opaque block.
   - `preserve.docx`: edit one character in every paragraph. The ledger of the written document equals the pristine
     ledger, and every `w:firstLineChars` and underline color present before is present after.
   - Saving the same patch twice gives documents that import equal. A save does not change what the next save writes.
   - A patch that breaks a contract returns `Write`. A deliberately wrong write (a test-only hook that drops a
     bookmark after `write`) returns `Verify` with a first difference that names the item.
   - `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, and the wasm build (`npm run engine`).
3. **Engine binding (TypeScript).** `Source.save(doc)` builds the patch, calls the session, and maps `BridgeError`
   to `SaveVerifyError` or a write error. `node --test` covers patch building: an untouched document is all `keep`.
   One edited paragraph is the only non-keep block. A paragraph moved by a split or join carries the right `src`.
   End to end in `scripts/e2e/save.mjs` through `window.__word`: open each fixture, save with no edit, open the
   bytes again, and compare `flatText` and marks of every paragraph.
4. **App.** Save and Save As in the toolbar (icons in the existing style, accessible names from the locale table),
   the platform save chords in the keymap, the `beforeclose` guard, and errors in the existing error band.
   - Save writes through the open file's handle with `createWritable()`. With no handle, or when the handle refuses
     writing, it falls back to Save As (`showSaveFilePicker` with the docx type and the current name).
   - Save As makes the picked handle the open file.
   - While a save is in flight a second save waits for it. It does not start a second write.
   - `beforeclose` on a dirty document shows a dialog built in the page (acdert has no `confirm`) with Save, Don't
     save and Cancel, focus trapped, Escape for Cancel. The handler has 3 seconds to answer, so it answers `false`
     at once, and closes the window itself with `close()` after the user chooses Save (and the save succeeded) or
     Don't save.
   - Opening or creating another document while dirty asks the same question.
   - Check, `scripts/e2e/shell-save.mjs` with `acde choose save` pointing into a temporary folder: open `basic.docx`,
     type English and Chinese, split and join paragraphs, set bold, a font, a size, a style and a list. Save As. The
     title loses the dirty mark. Read the saved bytes back through `openBytes` and compare `flatText` and marks of
     every paragraph with the model before the save. Edit again, Save (no picker this time), reopen, compare. The
     close guard: `beforeclose` on a dirty document keeps the window and shows the dialog, and each of the three
     buttons does what it says. A save that fails verification (dev-only hook) shows the error, writes nothing, and
     stays dirty. Console has no errors.

## Constraints

- All of `docs/briefs/r2-shell.md` "Constraints" and "Agent contract" apply.
- No lossy fallback. Where the kit refuses an operation (a split point inside a hyperlink, a join across a section
  break), `write` returns `Write` with the reason. It does not rebuild the paragraph from the model.
- The engine builds with `RUSTUP_TOOLCHAIN=nightly SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
  Run cargo with `--offline`.
- Use only the fixtures in `fixtures/`. Write test output under a temporary folder, never into `fixtures/`.
- Do not commit. Leave the changes in the working tree.

## Success

A reviewer opens `fixtures/preserve.docx`, edits text in several paragraphs, saves, and opens the result in Word: the
edits are there and the comments, bookmarks, fields and indents are intact. All unit checks pass when rerun from a
clean checkout after `npm run engine`.
