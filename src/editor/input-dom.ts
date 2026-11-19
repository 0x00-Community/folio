// DOM wiring for the input layer. The decisions it applies are pure functions in input.ts, so Node can test them
// without a document.
import { comparePos, flatText, indexOf } from '../model.ts'
import type { Pos } from '../model.ts'
import { t } from '../i18n.ts'
import { compositionDelete, deleteSelection, insertText, selectedText } from './edit.ts'
import type { Command, EditorState } from './edit.ts'
import {
  chordOf,
  defaultKeymap,
  dragEndpoints,
  dragUnit,
  IDLE,
  isVerticalMotion,
  planBeforeInput,
  trackGoal,
  transition,
} from './input.ts'
import type { Action, DragUnit, InputMode, Platform } from './input.ts'
import type { Decoration } from './render.ts'

/** The slice of the facade the DOM layer is allowed to see. Page geometry stays behind these names. */
export interface EditingSurface {
  readonly state: EditorState
  readonly platform: Platform
  run(command: Command): boolean
  undo(): boolean
  redo(): boolean
  setPreedit(deco: Decoration | null): void
  focus(): void
  positionAtPoint(clientX: number, clientY: number): Pos | null
  caretColumn(): number | null
  moveLine(direction: 'up' | 'down', extend: boolean, goalX: number | null): number | null
  movePage(direction: 'up' | 'down', extend: boolean, goalX: number | null): number | null
  moveToLineEdge(edge: 'start' | 'end', extend: boolean): void
  setTextSelection(anchor: Pos, head: Pos): void
  fileCommand(op: 'save' | 'saveAs'): void
}

export interface InputBinding {
  detach(): void
  reset(): void
}

const EDGE = 28
const STEP = 32

/**
 * Wires one textarea to the editor. The textarea is the only focus target. Returns the detach function and a reset
 * for a new document, which abandons a composition or a drag without committing it.
 */
export function attachInput(editor: EditingSurface, sink: HTMLTextAreaElement, host: HTMLElement): InputBinding {
  const keymap = defaultKeymap(editor.platform)
  const controller = new AbortController()
  const signal = controller.signal
  let mode: InputMode = IDLE
  let goal: number | null = null
  let fromKey = false
  let skipInsert: string | null = null
  let pastePending = false
  let drag: { move: (event: MouseEvent) => void; up: (event: MouseEvent) => void } | null = null

  sink.setAttribute('aria-label', t('inputLabel'))

  function arm(flag: 'key' | 'insert', value: string | null): void {
    if (flag === 'key') fromKey = true
    else skipInsert = value
    queueMicrotask(() => {
      if (flag === 'key') fromKey = false
      else if (skipInsert === value) skipInsert = null
    })
  }

  function endDrag(): void {
    if (!drag) return
    document.removeEventListener('mousemove', drag.move, true)
    document.removeEventListener('mouseup', drag.up, true)
    drag = null
  }

  function applyAction(action: Action, column: number | null): void {
    switch (action.kind) {
      case 'command':
        editor.run(action.command)
        return
      case 'history':
        if (action.step === 'undo') editor.undo()
        else editor.redo()
        return
      case 'clipboard':
        applyClipboard(action.op)
        return
      case 'file':
        editor.fileCommand(action.op)
        return
      case 'visual':
        applyVisual(action, column)
        return
    }
  }

  function applyVisual(action: Extract<Action, { kind: 'visual' }>, column: number | null): void {
    const extend = action.extend
    switch (action.motion) {
      case 'lineUp':
        goal = editor.moveLine('up', extend, column)
        return
      case 'lineDown':
        goal = editor.moveLine('down', extend, column)
        return
      case 'pageUp':
        goal = editor.movePage('up', extend, column)
        return
      case 'pageDown':
        goal = editor.movePage('down', extend, column)
        return
      case 'lineStart':
        editor.moveToLineEdge('start', extend)
        return
      case 'lineEnd':
        editor.moveToLineEdge('end', extend)
        return
    }
  }

  function copySelection(): void {
    const text = selectedText(editor.state)
    try {
      // Fires a copy event while the key gesture is current, so onCopy can fill clipboardData.
      document.execCommand('copy')
    } catch {
      // execCommand is missing in some runtimes; writeText below is the other path.
    }
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {})
  }

  function applyClipboard(op: 'copy' | 'cut' | 'paste'): void {
    if (op === 'paste') {
      pastePending = true
      const clipboard = navigator.clipboard
      if (!clipboard) return
      void clipboard
        .readText()
        .then((text) => {
          if (!pastePending) return
          pastePending = false
          if (text.length === 0) return
          goal = null
          editor.run(insertText(text))
        })
        .catch(() => {
          pastePending = false
        })
      return
    }
    copySelection()
    if (op === 'cut') {
      goal = null
      editor.run(deleteSelection)
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || mode.kind === 'composing') return
    const action = keymap.get(chordOf(event, editor.platform))
    if (!action) return
    event.preventDefault()
    arm('key', null)
    const vertical = action.kind === 'visual' && isVerticalMotion(action.motion)
    const column = trackGoal(goal, action, vertical && goal === null ? editor.caretColumn() : goal)
    goal = column
    applyAction(action, column)
  }

  function onBeforeInput(event: InputEvent): void {
    if (fromKey) {
      event.preventDefault()
      return
    }
    const data = event.data
    if (
      skipInsert !== null &&
      data === skipInsert &&
      (event.inputType === 'insertText' || event.inputType === 'insertFromComposition')
    ) {
      event.preventDefault()
      skipInsert = null
      return
    }
    const plan = planBeforeInput(event.inputType, data, mode.kind === 'composing' || event.isComposing)
    if (plan.kind !== 'run') return
    event.preventDefault()
    goal = null
    editor.run(plan.command)
  }

  function onCompositionStart(): void {
    endDrag()
    const sel = editor.state.sel
    if (sel.kind === 'text' && (sel.anchor.p !== sel.head.p || sel.anchor.o !== sel.head.o)) {
      editor.run(compositionDelete())
    }
    const next = editor.state.sel
    if (next.kind !== 'text') return
    mode = transition(mode, { kind: 'compositionStart', at: next.head })
    goal = null
  }

  function onCompositionUpdate(event: CompositionEvent): void {
    if (mode.kind !== 'composing') return
    if (event.data.length === 0) editor.setPreedit(null)
    else editor.setPreedit({ kind: 'preedit', pos: mode.at, text: event.data })
  }

  function onCompositionEnd(event: CompositionEvent): void {
    const wasComposing = mode.kind === 'composing'
    const data = event.data.length > 0 ? event.data : sink.value
    mode = transition(mode, { kind: 'compositionEnd' })
    goal = null
    editor.setPreedit(null)
    sink.value = ''
    // A blur resets the mode first and abandons the preedit. A commit that still owns the mode inserts once.
    if (!wasComposing || data.length === 0) return
    arm('insert', data)
    editor.run(insertText(data))
  }

  function onCopy(event: ClipboardEvent): void {
    event.preventDefault()
    event.clipboardData?.setData('text/plain', selectedText(editor.state))
  }

  function onCut(event: ClipboardEvent): void {
    event.preventDefault()
    if (fromKey) return
    const text = selectedText(editor.state)
    event.clipboardData?.setData('text/plain', text)
    goal = null
    if (text.length > 0) editor.run(deleteSelection)
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text.length === 0) return
    pastePending = false
    goal = null
    editor.run(insertText(text))
  }

  function selectGesture(anchor: Pos, head: Pos, unit: DragUnit): void {
    try {
      const index = indexOf(editor.state.doc)
      const anchorLoc = index.get(anchor.p)
      const headLoc = index.get(head.p)
      if (anchorLoc.story !== 'body' || headLoc.story !== 'body') return
      const same = anchor.p === head.p
      const headBefore = !same && comparePos(index, head, anchor) < 0
      const offsets = dragEndpoints(
        flatText(anchorLoc.para),
        anchor.o,
        flatText(headLoc.para),
        head.o,
        same,
        headBefore,
        unit,
      )
      editor.setTextSelection({ p: anchor.p, o: offsets.anchor }, { p: head.p, o: offsets.head })
    } catch {
      return
    }
  }

  function autoscroll(clientX: number, clientY: number): void {
    const box = host.getBoundingClientRect()
    if (clientY < box.top + EDGE) host.scrollTop -= STEP
    else if (clientY > box.bottom - EDGE) host.scrollTop += STEP
    if (clientX < box.left + EDGE) host.scrollLeft -= STEP
    else if (clientX > box.right - EDGE) host.scrollLeft += STEP
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== 0 || mode.kind === 'composing') return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target === sink) return
    const target = event.target
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    if (!element?.closest('.page')) return
    const pos = editor.positionAtPoint(event.clientX, event.clientY)
    if (!pos) return
    event.preventDefault()
    editor.focus()
    const unit = dragUnit(event.detail)
    const sel = editor.state.sel
    const anchor = event.shiftKey && sel.kind === 'text' ? sel.anchor : pos
    endDrag()
    mode = transition(mode, { kind: 'pointerDown', at: anchor, unit })
    goal = null
    selectGesture(anchor, pos, unit)
    const move = (ev: MouseEvent): void => {
      if (mode.kind !== 'dragging') return
      ev.preventDefault()
      autoscroll(ev.clientX, ev.clientY)
      const next = editor.positionAtPoint(ev.clientX, ev.clientY)
      if (next) selectGesture(anchor, next, unit)
    }
    const up = (): void => {
      endDrag()
      mode = transition(mode, { kind: 'pointerUp' })
    }
    drag = { move, up }
    document.addEventListener('mousemove', move, true)
    document.addEventListener('mouseup', up, true)
  }

  function onBlur(): void {
    const composing = mode.kind === 'composing'
    endDrag()
    mode = transition(mode, { kind: 'reset' })
    goal = null
    sink.value = ''
    if (composing) editor.setPreedit(null)
  }

  sink.addEventListener('keydown', onKeyDown, { signal })
  sink.addEventListener('beforeinput', onBeforeInput, { signal })
  sink.addEventListener('compositionstart', onCompositionStart, { signal })
  sink.addEventListener('compositionupdate', onCompositionUpdate, { signal })
  sink.addEventListener('compositionend', onCompositionEnd, { signal })
  sink.addEventListener('copy', onCopy, { signal })
  sink.addEventListener('cut', onCut, { signal })
  sink.addEventListener('paste', onPaste, { signal })
  sink.addEventListener('blur', onBlur, { signal })
  host.addEventListener('mousedown', onMouseDown, { capture: true, signal })

  return {
    detach() {
      endDrag()
      controller.abort()
      mode = IDLE
      goal = null
      pastePending = false
    },
    reset() {
      const composing = mode.kind === 'composing'
      endDrag()
      mode = IDLE
      goal = null
      pastePending = false
      sink.value = ''
      if (composing) editor.setPreedit(null)
    },
  }
}
