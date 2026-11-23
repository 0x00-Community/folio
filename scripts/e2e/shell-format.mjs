// Character and paragraph formatting. Written without a window: the reviewer runs it.
// Run by the reviewer. This dispatch only syntax-checks the file.
import { ref, act, assert, buttonNamed, check, consoleErrors, ensureDev, evaluate, freshPage, namedRef, summary, until } from './acde.mjs'

const STRINGS = {
  en: {
    input: 'Document text',
    undo: 'Undo',
    redo: 'Redo',
    bold: 'Bold',
    size: 'Font size',
    fontColor: 'Font color',
    fontColorMenu: 'Font color menu',
    automatic: 'Automatic',
    swatch: 'Blue',
    white: 'White',
    highlight: 'Text highlight',
    highlightMenu: 'Text highlight menu',
    noHighlight: 'No highlight',
    highlightSwatch: 'Yellow',
    more: 'More',
    super: 'Superscript',
    sub: 'Subscript',
    clear: 'Clear formatting',
    spacing: 'Line and paragraph spacing',
    addBefore: 'Add space before paragraph',
    removeBefore: 'Remove space before paragraph',
    paragraph: 'Paragraph…',
    title: 'Paragraph',
    special: 'Special',
    by: 'By (in)',
    byValue: '0.333333333333',
    before: 'Before (pt)',
    after: 'After (pt)',
    line: 'Line spacing',
    lineValue: 'At',
    left: 'Left (in)',
    align: 'Alignment',
    ok: 'OK',
    cancel: 'Cancel',
  },
  zh: {
    input: '文档正文',
    undo: '撤销',
    redo: '重做',
    bold: '加粗',
    size: '字号',
    fontColor: '字体颜色',
    fontColorMenu: '字体颜色菜单',
    automatic: '自动',
    swatch: '蓝色',
    white: '白色',
    highlight: '突出显示',
    highlightMenu: '突出显示菜单',
    noHighlight: '无突出显示',
    highlightSwatch: '黄色',
    more: '更多',
    super: '上标',
    sub: '下标',
    clear: '清除格式',
    spacing: '行距和段落间距',
    addBefore: '增加段前间距',
    removeBefore: '删除段前间距',
    paragraph: '段落…',
    title: '段落',
    special: '特殊格式',
    by: '度量值（厘米）',
    byValue: '0.846666666667',
    before: '段前（磅）',
    after: '段后（磅）',
    line: '行距',
    lineValue: '设置值',
    left: '左侧（厘米）',
    align: '对齐方式',
    ok: '确定',
    cancel: '取消',
  },
}

function lang() {
  const value = evaluate('document.documentElement.lang')
  if (value !== 'en' && value !== 'zh') throw new Error(`no strings for lang ${JSON.stringify(value)}`)
  return value
}

function ui() {
  return STRINGS[lang()]
}

function menus() {
  return evaluate('document.querySelectorAll(\'[role="menu"]\').length')
}

function dialogOpen() {
  return evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return false
    const backdrop = dialog.closest('.unsaved')
    return !!(backdrop && backdrop.hidden !== true)
  })()`) === true
}

function menuNotModal() {
  return evaluate(`(() => {
    const backdrop = document.querySelector('.unsaved')
    return !backdrop || backdrop.hidden === true
  })()`) === true
}

function past() {
  return evaluate('window.__word.editor.state.history.past.length')
}

function undo() {
  act(buttonNamed(ui().undo), 'click')
}

function runs() {
  return evaluate(`(() => {
    const para = window.__word.editor.state.doc.body.find((block) => block.kind === 'p')
    if (!para) return []
    return para.inlines.filter((inline) => inline.kind === 'text').map((inline) => ({
      text: inline.text,
      color: inline.marks.color || null,
      highlight: inline.marks.highlight || null,
      vert: inline.marks.vertAlign || null,
      bold: inline.marks.bold === true,
      size: inline.marks.sizePt == null ? null : inline.marks.sizePt,
    }))
  })()`)
}

// The run that holds `text`. After an undo a word joins its neighbours again, so the match is by content.
function runText(text) {
  const all = runs()
  const found = all.find((run) => run.text === text) || all.find((run) => run.text.includes(text))
  assert(found, `no run ${JSON.stringify(text)} in ${JSON.stringify(runs())}`)
  return found
}

function props() {
  return evaluate(`(() => {
    const para = window.__word.editor.state.doc.body.find((block) => block.kind === 'p')
    const spacing = para && para.props.spacing || {}
    const indent = para && para.props.indent || {}
    return {
      before: spacing.before == null ? 0 : spacing.before,
      after: spacing.after == null ? 0 : spacing.after,
      line: spacing.line || null,
      first: indent.firstLine == null ? 0 : indent.firstLine,
      hanging: indent.hanging == null ? 0 : indent.hanging,
    }
  })()`)
}

function barColor(label = ui().fontColor) {
  const wanted = JSON.stringify(label)
  return evaluate(`(() => {
    const bar = [...document.querySelectorAll('[aria-label] .bar')].find((node) => node.closest('[aria-label]').getAttribute('aria-label') === ${wanted})
    if (!bar) return ''
    return getComputedStyle(bar).backgroundColor.replace(/\\s/g, '')
  })()`)
}

function controlValue(name) {
  return evaluate(`(() => {
    const node = document.querySelector('[aria-label=${JSON.stringify(name)}]')
    return node ? node.value : null
  })()`)
}

function optionValues(name) {
  return evaluate(`(() => {
    const select = document.querySelector('[aria-label=${JSON.stringify(name)}]')
    if (!select || !select.options) return []
    return [...select.options].map((option) => option.value)
  })()`)
}

function checkedHasMark(role) {
  return evaluate(`(() => {
    const item = [...document.querySelectorAll('[role=${JSON.stringify(role)}]')]
      .find((node) => node.getAttribute('aria-checked') === 'true')
    return !!(item && item.querySelector('.mark svg'))
  })()`)
}

function selectRange(start, end) {
  const applied = evaluate(`(() => {
    const editor = window.__word.editor
    const para = editor.state.doc.body.find((block) => block.kind === 'p')
    const sel = { kind: 'text', anchor: { p: para.id, o: ${start} }, head: { p: para.id, o: ${end} } }
    // run answers false when the selection is already this one.
    editor.run(window.__word.setSelection(sel))
    const now = editor.state.sel
    return now.kind === 'text' && now.anchor.p === para.id && now.anchor.o === ${start} && now.head.o === ${end}
  })()`)
  assert(applied === true, `selection ${start}-${end} did not apply`)
}

function replaceField(name, value) {
  const platform = evaluate('window.__word.platform')
  const mod = platform === 'mac' ? 'meta' : 'ctrl'
  // inspect --find matches by substring, and a short name such as "At" is inside many others.
  const field = ref(`input[aria-label=${JSON.stringify(name)}]`)
  act(field, 'focus')
  act(field, 'key', `${mod}+a`)
  act(field, 'type', value)
}

function openNamed(name) {
  act(buttonNamed(name), 'click')
  assert(menus() === 1, `${name} did not open a menu`)
  assert(menuNotModal(), `${name} was treated as a dialog`)
}

function closeMenu() {
  evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  assert(menus() === 0, 'a closed menu is still in the DOM')
}

function rgb(hex) {
  const value = Number.parseInt(hex, 16)
  return `rgb(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255})`
}

function near(actual, expected) {
  return typeof actual === 'number' && Math.abs(actual - expected) < 0.05
}

function oneRow() {
  const tops = evaluate(`(() => [...document.querySelectorAll('#toolbar > .group')].map((el) => el.getBoundingClientRect().top))()`)
  assert(Array.isArray(tops) && tops.length >= 8, `groups ${JSON.stringify(tops)}`)
  const first = tops[0]
  assert(tops.every((top) => Math.abs(top - first) < 1), `toolbar wrapped ${JSON.stringify(tops)}`)
}

function findControls() {
  const names = ui()
  for (const name of [names.fontColor, names.fontColorMenu, names.highlight, names.highlightMenu, names.more, names.spacing]) {
    buttonNamed(name)
  }
  openNamed(names.fontColorMenu)
  buttonNamed(names.automatic, 'menuitemradio')
  buttonNamed(names.swatch, 'menuitemradio')
  buttonNamed(names.white, 'menuitemradio')
  closeMenu()
  openNamed(names.highlightMenu)
  buttonNamed(names.noHighlight, 'menuitemradio')
  buttonNamed(names.highlightSwatch, 'menuitemradio')
  closeMenu()
  openNamed(names.more)
  buttonNamed(names.super, 'menuitemcheckbox')
  buttonNamed(names.sub, 'menuitemcheckbox')
  buttonNamed(names.clear, 'menuitem')
  closeMenu()
  openNamed(names.spacing)
  buttonNamed('1.5', 'menuitemradio')
  buttonNamed(names.addBefore, 'menuitem')
  buttonNamed(names.paragraph, 'menuitem')
  closeMenu()
  oneRow()
}

await ensureDev()
await freshPage('!!(window.__word && window.__word.editor)', { label: 'editor' })

await check('the new controls are named in this language and the bar is one row', async () => {
  findControls()
})

await check('font color applies, repeats, and clears, one undo each', async () => {
  const names = ui()
  const sink = namedRef(names.input)
  act(sink, 'focus')
  act(sink, 'type', 'alpha beta')
  selectRange(0, 5)
  const before = past()
  openNamed(names.fontColorMenu)
  act(buttonNamed(names.swatch, 'menuitemradio'), 'click')
  assert(menus() === 0, 'the palette stayed open')
  assert(past() === before + 1, `color history ${past()} from ${before}`)
  assert(runText('alpha').color === '0070C0', JSON.stringify(runs()))
  assert(barColor() === rgb('0070C0'), `bar ${barColor()}`)
  selectRange(6, 10)
  const again = past()
  act(buttonNamed(names.fontColor), 'click')
  assert(past() === again + 1, `repeat history ${past()}`)
  assert(runText('beta').color === '0070C0', JSON.stringify(runs()))
  undo()
  assert(runText('beta').color === null, JSON.stringify(runs()))
  assert(runText('alpha').color === '0070C0', 'undo removed the first word too')
  selectRange(0, 5)
  const clearing = past()
  openNamed(names.fontColorMenu)
  act(buttonNamed(names.automatic, 'menuitemradio'), 'click')
  assert(past() === clearing + 1, `automatic history ${past()}`)
  assert(runText('alpha').color === null, JSON.stringify(runs()))
  assert(barColor() === rgb('0070C0'), `automatic changed the bar ${barColor()}`)
  undo()
  assert(runText('alpha').color === '0070C0', 'undo did not restore the color')
})

await check('highlight applies, repeats, and clears, one undo each', async () => {
  const names = ui()
  assert(barColor(names.highlight) === rgb('FFFF00'), `highlight bar ${barColor(names.highlight)}`)
  selectRange(0, 5)
  const before = past()
  openNamed(names.highlightMenu)
  act(buttonNamed(names.highlightSwatch, 'menuitemradio'), 'click')
  assert(past() === before + 1, `highlight history ${past()}`)
  assert(runText('alpha').highlight === 'yellow', JSON.stringify(runs()))
  selectRange(6, 10)
  act(buttonNamed(names.highlight), 'click')
  assert(runText('beta').highlight === 'yellow', JSON.stringify(runs()))
  undo()
  assert(runText('beta').highlight === null, JSON.stringify(runs()))
  selectRange(0, 5)
  openNamed(names.highlightMenu)
  act(buttonNamed(names.noHighlight, 'menuitemradio'), 'click')
  assert(runText('alpha').highlight === null, JSON.stringify(runs()))
  undo()
  assert(runText('alpha').highlight === 'yellow', 'undo did not restore the highlight')
})

await check('superscript and subscript are exclusive and toggle off', async () => {
  const names = ui()
  selectRange(0, 5)
  const before = past()
  openNamed(names.more)
  act(buttonNamed(names.super, 'menuitemcheckbox'), 'click')
  assert(past() === before + 1, `superscript history ${past()}`)
  assert(runText('alpha').vert === 'super', JSON.stringify(runs()))
  openNamed(names.more)
  assert(checkedHasMark('menuitemcheckbox') === true, 'the checked superscript has no mark')
  closeMenu()
  selectRange(0, 5)
  openNamed(names.more)
  act(buttonNamed(names.sub, 'menuitemcheckbox'), 'click')
  assert(runText('alpha').vert === 'sub', JSON.stringify(runs()))
  assert(runs().every((run) => run.vert !== 'super'), JSON.stringify(runs()))
  selectRange(0, 5)
  openNamed(names.more)
  act(buttonNamed(names.sub, 'menuitemcheckbox'), 'click')
  assert(runText('alpha').vert === null, JSON.stringify(runs()))
  undo()
  assert(runText('alpha').vert === 'sub', 'undo did not restore subscript')
  undo()
  assert(runText('alpha').vert === 'super', 'undo did not restore superscript')
  undo()
  assert(runText('alpha').vert === null, JSON.stringify(runs()))
})

await check('clear formatting leaves a bold colored 20 pt word plain', async () => {
  const names = ui()
  selectRange(6, 10)
  act(buttonNamed(names.bold), 'click')
  act(buttonNamed(names.fontColor), 'click')
  act(namedRef(names.size), 'select', '20')
  assert(runText('beta').bold === true, JSON.stringify(runs()))
  assert(runText('beta').color === '0070C0', JSON.stringify(runs()))
  assert(runText('beta').size === 20, JSON.stringify(runs()))
  const before = past()
  openNamed(names.more)
  act(buttonNamed(names.clear, 'menuitem'), 'click')
  assert(past() === before + 1, `clear history ${past()}`)
  const beta = runText('beta')
  assert(beta.bold === false && beta.color === null && beta.size === null && beta.vert === null, JSON.stringify(beta))
  undo()
  const back = runText('beta')
  assert(back.bold === true && back.color === '0070C0' && back.size === 20, JSON.stringify(back))
})

await check('line spacing 1.5 and space before can be added and removed', async () => {
  const names = ui()
  const before = past()
  openNamed(names.spacing)
  act(buttonNamed('1.5', 'menuitemradio'), 'click')
  assert(past() === before + 1, `line history ${past()}`)
  assert(props().line && props().line.rule === 'auto' && Math.abs(props().line.multiple - 1.5) < 0.001, JSON.stringify(props()))
  openNamed(names.spacing)
  assert(checkedHasMark('menuitemradio') === true, 'the checked line spacing has no mark')
  closeMenu()
  openNamed(names.spacing)
  act(buttonNamed(names.addBefore, 'menuitem'), 'click')
  assert(near(props().before, 12), JSON.stringify(props()))
  openNamed(names.spacing)
  act(buttonNamed(names.removeBefore, 'menuitem'), 'click')
  assert(near(props().before, 0), JSON.stringify(props()))
})

await check('the paragraph dialog opens with values, hides distribute, and OK alone is not an edit', async () => {
  const names = ui()
  const original = props()
  const history = past()
  openNamed(names.spacing)
  act(buttonNamed(names.paragraph, 'menuitem'), 'click')
  await until('document.querySelector(\'[role="dialog"]\') !== null', { label: 'paragraph dialog values' })
  assert(dialogOpen(), 'the paragraph dialog is not modal')
  assert(controlValue(names.left) !== '', 'left indent is blank')
  assert(controlValue(names.before) !== '', 'space before is blank')
  assert(controlValue(names.after) !== '', 'space after is blank')
  assert(controlValue(names.line) !== '', 'line spacing is blank')
  const aligns = optionValues(names.align)
  assert(Array.isArray(aligns) && !aligns.includes('distribute'), `distribute offered ${JSON.stringify(aligns)}`)
  act(buttonNamed(names.ok), 'click')
  await until('document.querySelector(\'.unsaved\') === null || document.querySelector(\'.unsaved\').hidden === true', { label: 'dialog accepted' })
  assert(past() === history, `OK added history ${past()} from ${history}`)
  assert(JSON.stringify(props()) === JSON.stringify(original), `OK changed ${JSON.stringify(props())}`)
})

await check('the paragraph dialog cancels, rejects an out-of-range value, and applies one undo', async () => {
  const names = ui()
  const original = props()
  openNamed(names.spacing)
  act(buttonNamed(names.paragraph, 'menuitem'), 'click')
  await until('document.querySelector(\'[role="dialog"]\') !== null', { label: 'paragraph dialog' })
  assert(dialogOpen(), 'the paragraph dialog is not modal')
  replaceField(names.before, '9')
  act(buttonNamed(names.cancel), 'click')
  await until('document.querySelector(\'.unsaved\') === null || document.querySelector(\'.unsaved\').hidden === true', { label: 'dialog closed' })
  assert(JSON.stringify(props()) === JSON.stringify(original), `cancel changed ${JSON.stringify(props())}`)

  openNamed(names.spacing)
  act(buttonNamed(names.paragraph, 'menuitem'), 'click')
  await until('document.querySelector(\'[role="dialog"]\') !== null', { label: 'paragraph dialog again' })
  replaceField(names.before, '2000')
  const disabled = evaluate(`(() => {
    const button = document.querySelector('.unsaved-actions button.primary')
    return !!(button && button.disabled)
  })()`)
  assert(disabled === true, 'an out-of-range value left OK enabled')
  act(namedRef(names.special), 'select', 'first')
  replaceField(names.by, names.byValue)
  replaceField(names.before, '6')
  replaceField(names.after, '6')
  act(namedRef(names.line), 'select', 'exact')
  replaceField(names.lineValue, '20')
  const history = past()
  act(buttonNamed(names.ok), 'click')
  await until('document.querySelector(\'.unsaved\') === null || document.querySelector(\'.unsaved\').hidden === true', { label: 'dialog applied' })
  assert(past() === history + 1, `dialog history ${past()} from ${history}`)
  const applied = props()
  assert(near(applied.first, 24), `first ${applied.first}`)
  assert(near(applied.before, 6), `before ${applied.before}`)
  assert(near(applied.after, 6), `after ${applied.after}`)
  assert(applied.line && applied.line.rule === 'exact' && near(applied.line.pt, 20), JSON.stringify(applied.line))
  undo()
  const restored = props()
  assert(near(restored.first, original.first), `undo first ${restored.first}`)
  assert(near(restored.before, original.before), `undo before ${restored.before}`)
  assert(near(restored.after, original.after), `undo after ${restored.after}`)
  assert(JSON.stringify(restored.line) === JSON.stringify(original.line), `undo line ${JSON.stringify(restored.line)}`)
  act(buttonNamed(names.redo), 'click')
  assert(near(props().first, 24), 'redo did not restore the paragraph')
})

await check('at least line spacing is applied and can be saved', async () => {
  const names = ui()
  const history = past()
  openNamed(names.spacing)
  act(buttonNamed(names.paragraph, 'menuitem'), 'click')
  await until('document.querySelector(\'[role="dialog"]\') !== null', { label: 'at least dialog' })
  act(namedRef(names.line), 'select', 'atLeast')
  replaceField(names.lineValue, '18')
  act(buttonNamed(names.ok), 'click')
  await until('document.querySelector(\'.unsaved\') === null || document.querySelector(\'.unsaved\').hidden === true', { label: 'at least applied' })
  assert(past() === history + 1, `at least history ${past()} from ${history}`)
  const line = props().line
  assert(line && line.rule === 'atLeast' && near(line.pt, 18), JSON.stringify(line))
})

await check('save and reopen keeps the formatting', async () => {
  await until('window.__word.editor.status().pagesFinal === true', { timeout: 60000, label: 'pages final' })
  const before = {
    runs: runs(),
    props: props(),
  }
  const saved = evaluate('window.__word.save()')
  assert(saved && typeof saved.base64 === 'string' && saved.base64.length > 0, 'save returned no bytes')
  evaluate(`(() => {
    window.__wordReady = false
    window.__wordError = ''
    Promise.resolve(window.__word.openBytes(${JSON.stringify(saved.base64)})).then(
      () => { window.__wordReady = true },
      (error) => { window.__wordError = String(error && error.message || error); window.__wordReady = true },
    )
    return 1
  })()`)
  await until('window.__wordReady === true', { timeout: 60000, label: 'reopened' })
  const error = evaluate('window.__wordError || ""')
  assert(!error, error)
  await until('window.__word.editor.status().pagesFinal === true', { timeout: 60000, label: 'reopened pages' })
  const alpha = runText('alpha')
  assert(alpha.color === '0070C0', JSON.stringify(runs()))
  assert(alpha.highlight === 'yellow', JSON.stringify(runs()))
  const again = props()
  assert(near(again.first, before.props.first) && near(again.before, before.props.before), JSON.stringify(again))
  assert(again.line && before.props.line && again.line.rule === before.props.line.rule, JSON.stringify(again.line))
})

await check('the other language names the same controls', async () => {
  const other = lang() === 'zh' ? 'en' : 'zh'
  const token = `fmt-${Date.now().toString(36)}`
  try {
    evaluate(`location.assign(location.pathname + ${JSON.stringify(`?lang=${other}&boot=${token}`)})`)
  } catch {
    // Reloading aborts the eval.
  }
  await until(
    `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(token)} && document.documentElement.lang === ${JSON.stringify(other)} && !!(window.__word && window.__word.editor)`,
    { timeout: 60000, label: other },
  )
  findControls()
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

await summary()
