import { act, assert, check, consoleErrors, ensureDev, evaluate, namedRef, summary, until } from './acde.mjs'

// Tab, Shift+Tab, and the indent buttons on a numbered list. The table save path is a later unit, so this script does not save.

const STRINGS = {
  en: {
    input: 'Document text',
    number: 'Numbered list',
    decrease: 'Decrease indent',
    increase: 'Increase indent',
  },
  zh: {
    input: '文档正文',
    number: '编号',
    decrease: '减少缩进',
    increase: '增加缩进',
  },
}

function go(search) {
  try {
    evaluate(`location.assign(location.pathname + ${JSON.stringify(search)})`)
  } catch {
    // Reloading the page aborts the eval.
  }
}

let bootToken = ''
function goTracked(search) {
  const match = search.match(/(?:^|[?&])boot=([^&]+)/)
  bootToken = match ? decodeURIComponent(match[1]) : ''
  go(search)
}

function names() {
  const lang = evaluate('document.documentElement.lang')
  const table = STRINGS[lang]
  if (!table) throw new Error(`no strings for lang ${JSON.stringify(lang)}`)
  return table
}

function inputRef() {
  const errors = []
  for (const name of ['Document text', '文档正文']) {
    try {
      return namedRef(name)
    } catch (error) {
      errors.push(String(error.message || error))
    }
  }
  throw new Error(errors.join('\n'))
}

function focusSink() {
  const sink = inputRef()
  act(sink, 'focus')
  return sink
}

function labeled(name) {
  return evaluate(`(() => {
    const want = ${JSON.stringify(name)}
    const el = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === want)
    if (!el) return null
    return { tag: el.tagName, pressed: el.getAttribute('aria-pressed') }
  })()`)
}

function listFact() {
  return evaluate(`(() => {
    const doc = window.__word.editor.state.doc
    const paras = []
    for (const block of doc.body) {
      if (block.kind !== 'p') continue
      let text = ''
      for (const inline of block.inlines) if (inline.kind === 'text') text += inline.text
      const numbering = block.props.numbering || null
      paras.push({ text, level: numbering ? numbering.level : null })
    }
    const pages = []
    for (const el of document.querySelectorAll('.page[data-mounted="1"] .page-body .blk.p')) {
      if (el.getAttribute('aria-hidden') === 'true') continue
      const marker = el.querySelector('.marker')
      pages.push({ label: el.getAttribute('aria-label'), marker: marker ? marker.textContent : null })
    }
    const active = document.activeElement
    return { paras, pages, active: active ? active.getAttribute('aria-label') : null }
  })()`)
}

function para(fact, text) {
  return fact.paras.find((item) => item.text === text)
}

function marker(fact, label) {
  const hit = fact.pages.find((item) => item.label === label)
  return hit ? hit.marker : undefined
}

function markersOf(fact) {
  return ['alpha', 'beta', 'gamma'].map((label) => marker(fact, label)).join(',')
}

await ensureDev()
const token = `lists-${Date.now()}`
goTracked(`?boot=${token}`)
await until(
  `new URLSearchParams(location.search).get('boot') === ${JSON.stringify(bootToken)} && !!(window.__word && window.__word.editor)`,
  { timeout: 60000, label: 'shell' },
)

const ui = names()
const platform = evaluate('window.__word.platform')
assert(platform === 'mac' || platform === 'other', `platform ${platform}`)
const mod = platform === 'mac' ? 'meta' : 'ctrl'

await check('three paragraphs become one numbered list', async () => {
  let sink = focusSink()
  act(sink, 'type', 'alpha')
  act(sink, 'key', 'enter')
  act(sink, 'type', 'beta')
  act(sink, 'key', 'enter')
  act(sink, 'type', 'gamma')
  sink = focusSink()
  act(sink, 'key', `${mod}+a`)
  act(namedRef(ui.number), 'click')
  await until(`document.querySelectorAll('.page[data-mounted="1"] .page-body .marker').length >= 3`, {
    label: 'numbered markers',
  })
  const fact = listFact()
  console.log(`  numbered ${JSON.stringify(fact)}`)
  assert(para(fact, 'alpha') && para(fact, 'alpha').level === 0, `alpha ${JSON.stringify(para(fact, 'alpha'))}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 0, `beta ${JSON.stringify(para(fact, 'beta'))}`)
  assert(para(fact, 'gamma') && para(fact, 'gamma').level === 0, `gamma ${JSON.stringify(para(fact, 'gamma'))}`)
  assert(markersOf(fact) === '1.,2.,3.', `markers ${markersOf(fact)}`)
})

await check('tab raises the second item and keeps focus in the editor', async () => {
  act(namedRef('beta'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'tab')
  const fact = listFact()
  console.log(`  tab ${JSON.stringify(fact)}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 1, `beta level ${JSON.stringify(para(fact, 'beta'))}`)
  assert(markersOf(fact) === '1.,1.,2.', `markers ${markersOf(fact)}`)
  assert(fact.active === ui.input, `focus ${fact.active}`)
})

await check('shift+tab lowers the second item', async () => {
  const sink = focusSink()
  act(sink, 'key', 'shift+tab')
  const fact = listFact()
  console.log(`  shift+tab ${JSON.stringify(fact)}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 0, `beta level ${JSON.stringify(para(fact, 'beta'))}`)
  assert(markersOf(fact) === '1.,2.,3.', `markers ${markersOf(fact)}`)
})

await check('the indent buttons are next to the list and are not toggles', async () => {
  const decrease = labeled(ui.decrease)
  const increase = labeled(ui.increase)
  assert(decrease && decrease.tag === 'BUTTON', `decrease ${JSON.stringify(decrease)}`)
  assert(increase && increase.tag === 'BUTTON', `increase ${JSON.stringify(increase)}`)
  assert(decrease.pressed === null, `decrease is a toggle ${decrease.pressed}`)
  assert(increase.pressed === null, `increase is a toggle ${increase.pressed}`)
})

await check('increase indent and decrease indent change the second item', async () => {
  act(namedRef(ui.increase), 'click')
  let fact = listFact()
  console.log(`  increase ${JSON.stringify(fact)}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 1, `beta level ${JSON.stringify(para(fact, 'beta'))}`)
  assert(markersOf(fact) === '1.,1.,2.', `markers ${markersOf(fact)}`)
  act(namedRef(ui.decrease), 'click')
  fact = listFact()
  console.log(`  decrease ${JSON.stringify(fact)}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 0, `beta level ${JSON.stringify(para(fact, 'beta'))}`)
  assert(markersOf(fact) === '1.,2.,3.', `markers ${markersOf(fact)}`)
})

await check('backspace at the start of the first item renumbers the rest', async () => {
  act(namedRef('alpha'), 'click')
  const sink = focusSink()
  act(sink, 'key', 'home')
  for (let i = 0; i < 8; i++) act(sink, 'key', 'arrowleft')
  act(sink, 'key', 'backspace')
  const fact = listFact()
  console.log(`  cleared ${JSON.stringify(fact)}`)
  const alpha = para(fact, 'alpha')
  assert(alpha && alpha.level === null, `alpha stayed numbered ${JSON.stringify(alpha)}`)
  assert(para(fact, 'beta') && para(fact, 'beta').level === 0, `beta ${JSON.stringify(para(fact, 'beta'))}`)
  assert(para(fact, 'gamma') && para(fact, 'gamma').level === 0, `gamma ${JSON.stringify(para(fact, 'gamma'))}`)
  assert(markersOf(fact) === ',1.,2.', `markers ${markersOf(fact)}`)
})

await check('console has no errors', async () => {
  const errors = consoleErrors()
  assert(errors.length === 0, errors.join('\n'))
})

summary()
