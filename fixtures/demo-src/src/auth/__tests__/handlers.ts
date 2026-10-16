// A test of the demo project: it calls the legacy store, and the diagram must
// not count it as a caller (test files stay out of the diagram).
import { loadTokens, saveTokens } from '../../legacy/tokens'
import { handleMe } from '../handlers'

export function testHandleMe(): void {
  saveTokens({ access: 'a', refresh: 'r' })
  if (handleMe() !== 'a') throw new Error('handleMe should read the saved token')
  if (!loadTokens()) throw new Error('loadTokens should find the saved token')
}
