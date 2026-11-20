// The close and replace question. acde has no confirm(), so this is an in-page dialog.
import { t } from '../i18n.ts'
import { openDialog } from './dialog.ts'

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export interface UnsavedDialog {
  readonly open: boolean
  ask(name: string): void
}

/** A modal dialog named by its question, with Save, Don't save and Cancel. Escape cancels. */
export function createUnsavedDialog(onChoice: (choice: UnsavedChoice) => void): UnsavedDialog {
  let open = false
  return {
    get open() {
      return open
    },
    ask(name) {
      if (open) return
      open = true
      const body = document.createElement('div')
      void openDialog<UnsavedChoice>({
        title: t('save.ask', { name }),
        body,
        buttons: [
          { label: t('save'), value: 'save', primary: true },
          { label: t('save.discard'), value: 'discard' },
          { label: t('save.cancel'), value: 'cancel' },
        ],
        cancel: 'cancel',
      }).then((choice) => {
        open = false
        onChoice(choice)
      })
    },
  }
}
