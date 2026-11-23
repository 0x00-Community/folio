# Inline picture handles

An inline picture can be selected, resized, and moved to another place in the text. The selection is the
ordinary text range that covers that one atom. Eight handles resize it. Dragging its body moves it. A corner
keeps the aspect ratio. A side changes one dimension. The opposite side stays put, and nothing is re-laid out
until the pointer is released. `resizeImage` and `moveAtom` are one undo entry each. `resizeImage` and
`moveImage` are on `word.call`. A picture's `widthPt` and `heightPt` are on its `text` run.

A picture that came from the file can be resized. The save changes that one drawing's extent through
`set_picture_size_at`, and a second use of the same media keeps its size. The kit also scales `wp:effectExtent`
with the extent. It cannot be moved: the kit has no call that relocates a run or a drawing while keeping the
original drawing XML, and the move is refused rather than rebuilt with `add_picture`. The status line says so.

Still out of scope: floating pictures, text wrapping, free placement on the page, rotation, cropping, and a
size dialog. There is no document-wide read-only flag; a locked paragraph, a preview story, or a story that is
not the body shows the outline without handles.

Not verified here: the end-to-end script (`scripts/e2e/shell-image.mjs`). The delegate cannot reach the acde
socket or see the window. Copy of a selected picture puts no picture on the clipboard; the range's plain text
is empty.
