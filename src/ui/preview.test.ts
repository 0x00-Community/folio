import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PreviewMachine,
  describePrintFailure,
  fittedPagePx,
  isWasmAbort,
  nextPage,
  pdfFileName,
  previewDpi,
  shouldRender,
} from './preview.ts'
import type { PreviewLayout } from './preview.ts'

function fakeLayout(): PreviewLayout & { frees: number } {
  const layout = {
    frees: 0,
    free() {
      layout.frees += 1
    },
  }
  return layout
}

const translate = (key: string, values: Record<string, string | number> = {}): string => {
  return `${key}:${JSON.stringify(values)}`
}

test('closed goes preparing, open, exporting, and back to open', () => {
  const machine = new PreviewMachine()
  assert.equal(machine.phase, 'closed')
  assert.equal(machine.begin(), true)
  assert.equal(machine.phase, 'preparing')
  const layout = fakeLayout()
  assert.equal(machine.settle(layout), 'open')
  assert.equal(machine.phase, 'open')
  assert.equal(layout.frees, 0)
  assert.equal(machine.startExport(), true)
  assert.equal(machine.phase, 'exporting')
  assert.equal(machine.finishExport(), true)
  assert.equal(machine.phase, 'open')
  assert.equal(machine.held(), layout)
})

test('preparing fails and then closes', () => {
  const machine = new PreviewMachine()
  assert.equal(machine.begin(), true)
  machine.fail()
  assert.equal(machine.phase, 'failed')
  machine.dismiss()
  assert.equal(machine.phase, 'closed')
  assert.equal(machine.begin(), true)
})

test('close frees the layout once', () => {
  const revoked: string[] = []
  const machine = new PreviewMachine((url) => { revoked.push(url) })
  machine.begin()
  const layout = fakeLayout()
  machine.settle(layout)
  machine.holdUrl('blob:page')
  machine.close()
  assert.equal(machine.phase, 'closed')
  assert.equal(layout.frees, 1)
  assert.deepEqual(revoked, ['blob:page'])
  machine.close()
  machine.fail()
  assert.equal(layout.frees, 1)
  assert.deepEqual(revoked, ['blob:page'])
  assert.equal(machine.held(), null)
})

test('a second preview cannot start until close has freed the layout', () => {
  const machine = new PreviewMachine()
  assert.equal(machine.begin(), true)
  const first = fakeLayout()
  assert.equal(machine.settle(first), 'open')
  assert.equal(machine.begin(), false, 'open already holds one')
  machine.close()
  assert.equal(first.frees, 1)
  assert.equal(machine.phase, 'closed')
  assert.equal(machine.begin(), true)
  machine.cancel()
  assert.equal(machine.phase, 'cancelling')
  assert.equal(machine.begin(), false, 'the layout call is still out')
  const second = fakeLayout()
  assert.equal(machine.settle(second), 'closed')
  assert.equal(second.frees, 1, 'cancel frees the layout when it returns')
  assert.equal(first.frees, 1)
  assert.equal(machine.phase, 'closed')
  assert.equal(machine.begin(), true)
})

test('cancel before a layout exists does not free anything', () => {
  const machine = new PreviewMachine()
  machine.begin()
  machine.cancel()
  machine.finishCancel()
  assert.equal(machine.phase, 'closed')
  assert.equal(machine.begin(), true)
})

test('a render failure frees the layout on the way from open to closed', () => {
  const machine = new PreviewMachine()
  machine.begin()
  const layout = fakeLayout()
  machine.settle(layout)
  machine.fail()
  assert.equal(machine.phase, 'failed')
  assert.equal(layout.frees, 1)
  machine.dismiss()
  assert.equal(machine.phase, 'closed')
  machine.close()
  assert.equal(layout.frees, 1)
})

test('a wasm abort drops the layout and does not call free', () => {
  const revoked: string[] = []
  const machine = new PreviewMachine((url) => { revoked.push(url) })
  machine.begin()
  const layout = fakeLayout()
  machine.settle(layout)
  machine.holdUrl('blob:dead')
  machine.abort()
  assert.equal(machine.phase, 'unusable')
  assert.equal(layout.frees, 0)
  assert.deepEqual(revoked, ['blob:dead'])
  assert.equal(machine.begin(), false)
  machine.abort()
  assert.equal(layout.frees, 0)
})

test('a url that arrives after close is revoked and not kept', () => {
  const revoked: string[] = []
  const machine = new PreviewMachine((url) => { revoked.push(url) })
  machine.holdUrl('blob:early')
  assert.deepEqual(revoked, ['blob:early'])
  machine.begin()
  machine.settle(fakeLayout())
  machine.close()
  machine.holdUrl('blob:late')
  assert.deepEqual(revoked, ['blob:early', 'blob:late'])
})

test('export is refused except from an open preview', () => {
  const machine = new PreviewMachine()
  assert.equal(machine.startExport(), false)
  machine.begin()
  assert.equal(machine.startExport(), false)
  machine.settle(fakeLayout())
  assert.equal(machine.startExport(), true)
  assert.equal(machine.startExport(), false)
  assert.equal(machine.finishExport(), true)
  assert.equal(machine.finishExport(), false)
})

test('rendering runs only while the preview is open or exporting', () => {
  assert.equal(shouldRender('open'), true)
  assert.equal(shouldRender('exporting'), true)
  for (const phase of ['closed', 'preparing', 'cancelling', 'failed', 'unusable'] as const) {
    assert.equal(shouldRender(phase), false, phase)
  }
})

test('visible pages are rasterized before the page on either side', () => {
  const done = new Set<number>()
  assert.equal(nextPage(10, [5, 6], done), 5)
  done.add(5)
  assert.equal(nextPage(10, [5, 6], done), 6)
  done.add(6)
  assert.equal(nextPage(10, [5, 6], done), 4)
  done.add(4)
  assert.equal(nextPage(10, [5, 6], done), 7)
  assert.equal(nextPage(3, [], done), null)
  assert.equal(nextPage(2, [0], new Set([0])), 1)
})

test('dpi follows the device pixel ratio and stops at 144', () => {
  assert.equal(previewDpi(1), 96)
  assert.equal(previewDpi(1.25), 120)
  assert.equal(previewDpi(1.5), 144)
  assert.equal(previewDpi(2), 144)
  assert.equal(previewDpi(0), 96)
  assert.equal(previewDpi(Number.NaN), 96)
  assert.equal(previewDpi(-2), 96)
})

test('the image css size comes from the page size and fits the width', () => {
  const full = fittedPagePx(612, 792, 2000)
  assert.equal(full.width, 816)
  assert.equal(full.height, 1056)
  const narrow = fittedPagePx(612, 792, 408)
  assert.equal(narrow.width, 408)
  assert.equal(narrow.height, 528)
})

test('the pdf name is the document name with a pdf suffix', () => {
  assert.equal(pdfFileName('basic.docx'), 'basic.pdf')
  assert.equal(pdfFileName('基本.DOCX'), '基本.pdf')
  assert.equal(pdfFileName('notes'), 'notes.pdf')
  assert.equal(pdfFileName(''), 'document.pdf')
  assert.equal(pdfFileName('already.pdf'), 'already.pdf')
})

test('a layout or render failure keeps the engine message, and a panic says to reopen', () => {
  const font = Object.assign(new Error('宋体'), { name: 'PrintError', kind: 'font', family: '宋体' })
  assert.deepEqual(describePrintFailure(font, translate), {
    message: 'print.error.font:{"family":"宋体"}',
    abort: false,
  })
  const render = Object.assign(new Error('png'), { name: 'PrintError', kind: 'render', detail: 'png' })
  assert.equal(describePrintFailure(render, translate).abort, false)
  assert.equal(describePrintFailure(render, translate).message, 'print.error.render:{"detail":"png"}')
  const write = Object.assign(new Error('refused'), { name: 'SaveWriteError', detail: 'refused' })
  assert.equal(describePrintFailure(write, translate).message, 'print.error.layout:{"detail":"refused"}')
  const abort = new WebAssembly.RuntimeError('unreachable')
  assert.equal(isWasmAbort(abort), true)
  assert.deepEqual(describePrintFailure(abort, translate), { message: 'print.reopen:{}', abort: true })
  assert.equal(isWasmAbort(new Error('nope')), false)
})
