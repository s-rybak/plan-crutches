import type { ClientModule, ClientPointerEvent } from 'claude-code'

/** What the hooks module hands a selectable code block. Plain data only. */
export type SelectableProps = {
  lines: string[]
  path: string
  format: 'source' | 'diff'
  startLine: number
  target: { path: string; symbol?: string }
  hint: string
  placeholder: string
  cancelLabel: string
  selectedLabel: string
}

type State = {
  anchor?: number
  head?: number
  dragging: boolean
  popup: boolean
}

const POPUP_ROWS = 5
const POPUP_MIN_COLUMNS = 24

const EMPTY: State = { dragging: false, popup: false }

function range(state: State): [number, number] | null {
  if (state.anchor === undefined || state.head === undefined) return null
  return [Math.min(state.anchor, state.head), Math.max(state.anchor, state.head)]
}

/** The text a selection stands for: diff markers dropped, hunk headers skipped. */
function selectedText(lines: readonly string[], format: 'source' | 'diff', from: number, to: number): string {
  const picked: string[] = []
  for (let i = from; i <= to; i++) {
    const line = lines[i] ?? ''
    if (format === 'diff') {
      if (line.startsWith('@@')) continue
      picked.push(line.slice(1))
    } else {
      picked.push(line)
    }
  }
  return picked.join('\n')
}

function popupTop(from: number, to: number, rows: number): number {
  const below = to + 1
  if (rows === 0 || below + POPUP_ROWS <= rows) return below
  return Math.max(0, from - POPUP_ROWS)
}

const Selectable: ClientModule<SelectableProps, State> = (props, surface) => {
  const { Box, Text, Code, Input, Button } = surface.elements
  const state = surface.state ?? EMPTY
  const lineCount = props.lines.length
  const clampRow = (y: number): number => Math.max(0, Math.min(lineCount - 1, y))

  surface.onPointer((event: ClientPointerEvent) => {
    const current = surface.state ?? EMPTY
    if (event.type === 'down' && event.button === 'left') {
      if (current.popup) {
        const selected = range(current)
        if (selected) {
          const top = popupTop(selected[0], selected[1], surface.rows)
          if (event.y >= top && event.y < top + POPUP_ROWS) return
        }
      }
      const row = clampRow(event.y)
      surface.setState({ anchor: row, head: row, dragging: true, popup: false })
      return
    }
    if (event.type === 'move' && current.dragging && event.button === 'left') {
      const row = clampRow(event.y)
      if (row !== current.head) surface.setState({ ...current, head: row })
      return
    }
    if (event.type === 'up' && current.dragging) {
      const selected = range(current)
      surface.setState(selected ? { ...current, dragging: false, popup: true } : EMPTY)
    }
  })

  const selected = range(state)
  const source = props.lines.join('\n')
  if (!selected || lineCount === 0) {
    return (
      <Box flexDirection="column">
        <Code source={source || ' '} path={props.path} format={props.format} startLine={props.format === 'source' ? props.startLine : undefined} wrap="truncate-end" />
        <Text dimColor>{props.hint}</Text>
      </Box>
    )
  }

  const [from, to] = selected
  const width = Math.max(POPUP_MIN_COLUMNS, Math.min(surface.columns || 60, 72) - 2)
  const top = popupTop(from, to, surface.rows)
  const text = selectedText(props.lines, props.format, from, to)
  const close = () => surface.setState(EMPTY)
  const submit = (value: string) => {
    const comment = value.trim()
    if (comment) {
      surface.post({
        type: 'comment',
        target: {
          path: props.target.path,
          ...(props.target.symbol ? { symbol: props.target.symbol } : {}),
          selection: text.slice(0, 2000),
          lines: [props.startLine + from, props.startLine + to],
        },
        text: comment,
      })
    }
    close()
  }

  return (
    <Box flexDirection="column">
      {props.lines.map((line, index) => {
        const inside = index >= from && index <= to
        return (
          <Text wrap="truncate-end" inverse={inside} color={inside ? 'permission' : undefined}>
            {line || ' '}
          </Text>
        )
      })}
      {state.popup && (
        <Box position="absolute" top={top} left={1} width={width} flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
          <Text dimColor>
            {props.selectedLabel.split('{n}').join(String(to - from + 1))} · {props.startLine + from}-{props.startLine + to}
          </Text>
          <Input key="selection-comment" placeholder={props.placeholder} autoFocus onSubmit={submit} />
          <Button key="selection-cancel" plain dimColor onPress={close}>
            {props.cancelLabel}
          </Button>
        </Box>
      )}
    </Box>
  )
}

export default Selectable
