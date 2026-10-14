// The page's side of the bridge: the token, the event stream and actions.

function readToken() {
  const url = new URL(location.href)
  const given = url.searchParams.get('t')
  try {
    if (given) localStorage.setItem('plan-crutches-token', given)
    return given || localStorage.getItem('plan-crutches-token') || ''
  } catch {
    return given || ''
  }
}

export const token = readToken()

const headers = { 'content-type': 'application/json', 'x-plan-crutches-token': token }

export function connect(onState, onStatus) {
  let source
  let closed = false
  const open = () => {
    if (closed) return
    source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
    source.addEventListener('state', event => {
      try {
        onState(JSON.parse(event.data))
      } catch (error) {
        console.error('bad state event', error)
      }
    })
    source.onopen = () => onStatus(true)
    source.onerror = () => {
      onStatus(false)
      // EventSource retries on its own while the server answers; when the
      // server is gone it gives up, so reopen it after a pause.
      if (source.readyState === EventSource.CLOSED) {
        source.close()
        setTimeout(open, 2000)
      }
    }
  }
  open()
  return () => {
    closed = true
    if (source) source.close()
  }
}

export async function act(action) {
  const response = await fetch('/api/action', { method: 'POST', headers, body: JSON.stringify(action) })
  if (!response.ok) {
    let detail = String(response.status)
    try {
      detail = (await response.json()).error || detail
    } catch {
      // keep the status
    }
    throw new Error(detail)
  }
}

export async function fetchState() {
  const response = await fetch('/api/state', { headers })
  if (!response.ok) throw new Error(`state ${response.status}`)
  return response.json()
}

export function projectUrl(relativePath) {
  const clean = relativePath.replace(/^\.?\//, '')
  return `/project/${clean.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(token)}`
}
