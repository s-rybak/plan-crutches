import { clearTokens, loadTokens, saveTokens } from '../legacy/tokens'
import type { StoredTokens } from '../legacy/tokens'
import { requestTokens } from '../api/client'

export async function handleLogin(request: { body: { email: string; password: string } }): Promise<StoredTokens | null> {
  const tokens = await requestTokens(request.body)
  if (!tokens) return null
  saveTokens(tokens)
  return tokens
}

export function handleLogout(): void {
  clearTokens()
}

export function handleMe(): string | null {
  const tokens = loadTokens()
  return tokens ? tokens.access : null
}

export class TokenRefresher {
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    this.timer = setInterval(() => {
      const tokens = loadTokens()
      if (tokens) saveTokens(tokens)
    }, 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
