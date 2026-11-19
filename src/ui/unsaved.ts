// The close and replace question. acde has no confirm(), so this is an in-page dialog.
import { t } from '../i18n.ts'

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export interface UnsavedDialog {
  readonly open: boolean
  ask(name: string): void
}

const CHOICES: readonly UnsavedChoice[] = ['save', 'discard', 'cancel']

/** A modal dialog named by its question, with Save, Don't save and Cancel. Escape cancels. */
export function createUnsavedDialog(onChoice: (choice: UnsavedChoice) => void): UnsavedDialog {
  const backdrop = document.createElement('div')
  backdrop.className = 'unsaved'
  backdrop.hidden = true
  const dialog = document.createElement('div')
  dialog.className = 'unsaved-panel'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'unsaved-question')
  const question = document.createElement('p')
  question.id = 'unsaved-question'
  const actions = document.createElement('div')
  actions.className = 'unsaved-actions'
  const buttons = {
    save: choiceButton('save', true),
    discard: choiceButton('save.discard', false),
    cancel: choiceButton('save.cancel', false),
  }
  actions.append(buttons.save, buttons.discard, buttons.cancel)
  dialog.append(question, actions)
  backdrop.append(dialog)
  document.body.append(backdrop)

  const order = [buttons.save, buttons.discard, buttons.cancel]

  function choiceButton(key: string, primary: boolean): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    if (primary) button.className = 'primary'
    button.textContent = t(key)
    return button
  }

  function hide(): void {
    if (!backdrop.hidden) backdrop.hidden = true
  }

  function choose(choice: UnsavedChoice): void {
    hide()
    onChoice(choice)
  }

  for (const choice of CHOICES) {
    buttons[choice].addEventListener('click', () => choose(choice))
  }

  document.addEventListener('keydown', (event) => {
    if (backdrop.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      choose('cancel')
      return
    }
    if (event.key !== 'Tab') {
      const target = event.target
      const onButton = target instanceof HTMLButtonElement && dialog.contains(target)
      if (onButton && (event.key === 'Enter' || event.key === ' ')) return
      event.preventDefault()
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const index = order.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.shiftKey ? -1 : 1
    const next = order[(index + step + order.length) % order.length] ?? buttons.save
    next.focus()
  }, true)

  return {
    get open() {
      return !backdrop.hidden
    },
    ask(name) {
      const text = t('save.ask', { name })
      if (question.textContent !== text) question.textContent = text
      if (backdrop.hidden) backdrop.hidden = false
      buttons.save.focus()
    },
  }
}
