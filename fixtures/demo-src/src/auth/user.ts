import { apiGet } from '../api/client'
import { readSession } from './storage'

export type User = {
  id: string
  email: string
  displayName: string
}

async function loadUser(userId: string): Promise<User | null> {
  const response = await apiGet(`/users/${userId}`)
  if (response.status === 404) return null
  return response.json() as Promise<User>
}

export async function getCurrentUser(): Promise<User | null> {
  const session = readSession()
  if (!session) return null
  return loadUser(session.userId)
}

export function displayNameOf(user: User): string {
  return user.displayName || user.email
}
