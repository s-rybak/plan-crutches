// Legacy token store. Kept tokens in localStorage with no expiry handling.
const KEY = 'auth.tokens'

export type StoredTokens = { access: string; refresh: string }

export function saveTokens(tokens: StoredTokens): void {
  localStorage.setItem(KEY, JSON.stringify(tokens))
}

export function loadTokens(): StoredTokens | null {
  const raw = localStorage.getItem(KEY)
  return raw ? (JSON.parse(raw) as StoredTokens) : null
}

export function clearTokens(): void {
  localStorage.removeItem(KEY)
}
