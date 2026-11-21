/**
 * Layout or a render of it failed.
 * `font` names the family, `layout` and `render` carry the engine's detail.
 * A patch `write` refuses is `SaveWriteError`, the same error as save.
 */
export class PrintError extends Error {
  readonly kind: 'font' | 'layout' | 'render'
  readonly family: string | undefined
  readonly detail: string | undefined

  constructor(kind: 'font' | 'layout' | 'render', value: string) {
    super(value)
    this.name = 'PrintError'
    this.kind = kind
    this.family = kind === 'font' ? value : undefined
    this.detail = kind === 'font' ? undefined : value
  }
}
