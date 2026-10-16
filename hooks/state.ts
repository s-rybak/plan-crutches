export const PANE_ID = 'plan-review'

export const bodyKey = (path: string, symbol: string): string => `${path}#${symbol}`
export const newId = (): string => Math.random().toString(36).slice(2, 10)

/** The shape of the page state and its actions; the page refuses a mod of another number. */
export const WEB_PROTOCOL = 4
