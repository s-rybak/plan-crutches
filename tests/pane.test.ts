import { describe, expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane' as const,
  requestId: 'plan-review',
  props: {
    title: 'Plan Review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }

describe('plan review pane', () => {
  test('shows the no-plan note before any plan arrives', async $ => {
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /No plan under review/ })).toBeDefined()
    await ui.press({ key: 'lang' })
    expect(await ui.find({ text: /Немає плану/ })).toBeDefined()
    await ui.unmount()
  })

  test('draws the demo plan and takes comments on the desktop', async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/tmp/plan-crutches-test-home' })
    const ran = await $.command.run({ command: 'plan-review', args: 'demo', ...RUN })
    expect(ran.text ?? '').toContain('demo plan opened')
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await ui.find({ text: /AUTH-42/ })).toBeDefined()
    expect(await ui.find({ key: 'row:file:src/auth/session.ts' })).toBeDefined()
    expect((await ui.find({ key: 'submit' }))?.text).toContain('Approve')

    await ui.press({ key: 'toggle:dir:src' })
    expect(await ui.find({ key: 'row:file:src/auth/session.ts' })).toBeUndefined()
    await ui.press({ key: 'toggle:dir:src' })
    expect(await ui.find({ key: 'row:file:src/auth/session.ts' })).toBeDefined()

    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    expect((await ui.find({ key: 'submit' }))?.text).toContain('1')

    await ui.press({ key: 'row:dir:src/auth' })
    await ui.press({ key: 'comment:dir:src/auth' })
    await ui.input({ key: 'input:dir:src/auth', text: 'Rename to sessions.' })
    expect(await ui.find({ text: /Rename to sessions\./ })).toBeDefined()

    await ui.press({ key: 'row:file:src/auth/session.ts' })
    expect(await ui.find({ text: /refreshSession/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'comment:src/auth/session.ts#refreshSession' })
    await ui.input({ key: 'input:src/auth/session.ts#refreshSession', text: 'Return a Result type.' })
    expect(await ui.find({ text: /Return a Result type\./ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect((await ui.find({ key: 'submit' }))?.text).toContain('3')
    await ui.unmount()
  })

  test('draws the demo plan on the terminal too', async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/tmp/plan-crutches-test-home' })
    await $.command.run({ command: 'plan-review', args: 'demo', ...RUN })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await ui.find({ key: 'row:file:docs/auth.md' })).toBeDefined()
    await ui.unmount()
  })

  test('selects lines with the mouse and comments from the popup', async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/tmp/plan-crutches-test-home' })
    await $.command.run({ command: 'plan-review', args: 'demo', ...RUN })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    await ui.press({ key: 'row:file:src/auth/session.ts' })
    const block = 'sel:src/auth/session.ts:preview'
    await ui.resize({ columns: 80, rows: 30, in: block })
    expect(await ui.find({ in: block, text: /Drag the mouse/ })).toBeDefined()

    await ui.pointer({ type: 'down', button: 'left', x: 3, y: 1, in: block })
    await ui.pointer({ type: 'move', button: 'left', x: 3, y: 3, in: block })
    await ui.pointer({ type: 'up', button: 'left', x: 3, y: 3, in: block })
    expect(await ui.find({ in: block, text: /3 lines selected/ })).toBeDefined()
    expect(await ui.find({ in: block, key: 'selection-comment' })).toBeDefined()

    await ui.post(
      { type: 'comment', target: { path: 'src/auth/session.ts', selection: 'export type Session', lines: [2, 4] }, text: 'Split this type.' },
      { in: block },
    )
    expect(await ui.find({ text: /Split this type\./ })).toBeDefined()
    expect(await ui.find({ text: /lines 2-4/ })).toBeDefined()
    expect((await ui.find({ key: 'back' }))).toBeDefined()
    await ui.press({ key: 'back' })
    expect((await ui.find({ key: 'submit' }))?.text).toContain('1')
    await ui.unmount()
  })
})
