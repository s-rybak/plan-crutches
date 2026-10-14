export const PANE_ID = 'plan-review'

export const bodyKey = (path: string, symbol: string): string => `${path}#${symbol}`
export const newId = (): string => Math.random().toString(36).slice(2, 10)
