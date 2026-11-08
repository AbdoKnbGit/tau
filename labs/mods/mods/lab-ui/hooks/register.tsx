// A mod a person installs: everything it draws. The band above the prompt
// (always), the lab pane (/lab-pane), three panes with tabs (/lab-tabs), a pane
// whose Client fails (/lab-faults); Client modules that tick, animate and take
// keys and clicks; every element and control; and the focus, scroll, close,
// message and fault events.
import { atom, read, update } from 'claude-code'

const CLICKS = atom({ plugin: 'lab-ui', key: 'clicks' }, 0)
// Another plugin's value: any plugin reads it, only lab-app writes it.
const APP_COUNT = atom({ plugin: 'lab-app', key: 'count' }, 0)
let note = '', color = 'green', blits = 0, lastMessage = '-'

/** A Raster's cells: three little-endian 32-bit words per cell (code point,
 * foreground 0x00RRGGBB, background), as base64. */
function rasterCells(columns: number, rows: number, phase: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const at = (row * columns + column) * 3
      const shade = Math.floor((((column + phase) % columns) / columns) * 255)
      words[at] = 0x2588
      words[at + 1] = (shade << 16) | (80 << 8) | (255 - shade)
      words[at + 2] = 0x01000000
    }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    for (const [name, description] of [
      ['lab-pane', 'Mod lab: open the lab pane (every element and control, two Client modules)'],
      ['lab-tabs', 'Mod lab: open three panes: tabs, holdToasts, closeOnEscape, a background color'],
      ['lab-faults', 'Mod lab: open a pane whose Client fails on purpose'],
      ['lab-close', 'Mod lab: close every lab pane (ui.close for each)'],
    ]) await $.command.register({ name, description })
    return next(e)
  })

  on('command.run', { command: 'lab-pane' }, async ($, e) => {
    const placed = await $.ui.open({ id: 'lab', title: 'Lab pane', focus: true, rows: 20, columns: 80 })
    return { text: 'lab-pane: ' + JSON.stringify(placed) }
  })
  on('command.run', { command: 'lab-tabs' }, async ($, e) => {
    const a = await $.ui.open({ id: 'tab-a', title: 'Tab A (holdToasts)', holdToasts: true, backgroundColor: '#1d2540', columns: 80 })
    const b = await $.ui.open({ id: 'tab-b', title: 'Tab B (closeOnEscape)', closeOnEscape: true, columns: 80 })
    const c = await $.ui.open({ id: 'tab-c', title: 'Tab C', focus: true, columns: 80 })
    return { text: 'lab-tabs: ' + JSON.stringify({ a, b, c }) }
  })
  on('command.run', { command: 'lab-faults' }, async ($, e) => {
    const placed = await $.ui.open({ id: 'faults', title: 'Faults', focus: true, columns: 80 })
    return { text: 'lab-faults: ' + JSON.stringify(placed) }
  })
  on('command.run', { command: 'lab-close' }, async ($, e) => {
    const panes = await $.ui.panes()
    for (const pane of panes) await $.ui.close({ id: pane.id })
    return { text: 'lab-close: closed ' + (panes.map(pane => pane.id).join(', ') || 'nothing') }
  })

  // The band above the prompt: two plugins' $.state values (it redraws when
  // either changes, nobody calling invalidate) and a Client clock.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const clicks = await read($, CLICKS)
    const count = await read($, APP_COUNT)
    return <Box flexDirection="column">
      <Text><Text bold>lab-ui band</Text> · clicks {clicks} · lab-app count {count} · {e.props.isWorking ? 'turn running' : 'idle'} · <Button label="+1" hotkey="p" onPress={() => update($, CLICKS, n => n + 1)} /></Text>
      <Client key="clock" module="./clock.tsx" props={{ label: 'band clock' }} />
    </Box>
  })

  on('ui.render', { component: 'Pane' }, async ($, e) => {
    const { Box, Text, Button, Link, Code, Markdown, Input, Select, Raster, Svg, Client } = $.ui.resolve(e)
    // Where the pane sits and how big, as the terminal reports it to the mod.
    const geometry = <Text dimColor>{e.props.placement} · viewport {e.viewport?.columns}x{e.viewport?.rows} · body {e.props.bodyColumns} columns</Text>
    if (e.requestId === 'faults') return <Box flexDirection="column">
      {geometry}
      <Text>This pane's Client throws on purpose: one dimmed line takes its place, and ui.fault reaches lab-ui.</Text>
      <Client key="broken" module="./broken.tsx" />
    </Box>
    if (e.requestId !== 'lab') return <Box flexDirection="column">
      <Text bold>{e.props.title}</Text>
      {geometry}
      <Text>Ctrl+X Tab moves the keys between the band and the pane; Tab on a tab name shows that pane.</Text>
      {e.requestId === 'tab-a' ? <Text>holdToasts: run /lab-toast now; the toast waits until this pane is not shown.</Text> : null}
      {e.requestId === 'tab-b' ? <Text>closeOnEscape: Esc at an empty prompt closes this pane.</Text> : null}
    </Box>
    const clicks = await read($, CLICKS)
    return <Box flexDirection="column">
      {geometry}
      <Text bold>Lab pane · clicks {clicks} · note "{note}" · color {color} · blits {blits} · last Client message {lastMessage}</Text>
      <Box flexDirection="row" gap={2}>
        <Button label="Add" hotkey="a" autoFocus onPress={() => update($, CLICKS, n => n + 1)} />
        <Button label="Blit" hotkey="b" onPress={async () => {
          blits++
          await $.ui.blit({ requestId: 'lab', key: 'grad', cells: rasterCells(24, 2, blits * 3), columns: 24, rows: 2 })
        }} />
        <Button label="Collapse band" action="abovePrompt:toggle" />
        <Button label="Copy" hotkey="c" onPress={async () => { await $.ui.copy({ text: 'copied from the lab pane' }) }} />
      </Box>
      <Input key="note" label="Note" rows={3} placeholder="type, paste, arrows; Enter submits"
        onInput={value => { note = value }}
        onSubmit={async value => { note = value; await $.fs.write('.lab/note.txt', value); $.ui.invalidate('ui.render') }} />
      <Select key="color" label="Color" options={[{ value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }, { value: 'red', label: 'Red' }]}
        onSelect={value => { color = value; $.ui.invalidate('ui.render') }} />
      <Box key="hoverbox" hover={{ backgroundColor: 'blue' }}><Text>Hover this row (fullscreen): a keyed Box with a hover style</Text></Box>
      <Text><Text hover={{ scope: 'pair', bold: true, color: 'green' }}>hover me</Text> and <Text hover={{ scope: 'pair', bold: true, color: 'green' }}>me</Text> light up together (one scope)</Text>
      <Link href="https://example.com/lab">A link to example.com</Link>
      <Code language="ts" source={"const lab = 'mods'\nconsole.log(lab)"} />
      <Markdown text={'**Markdown** with `code` and a list:\n- one\n- two'} />
      <Svg><Text dimColor>An Svg draws its children as a fragment in the terminal.</Text></Svg>
      <Raster key="grad" columns={24} rows={2} cells={rasterCells(24, 2, 0)} />
      <Client key="spark" module="./spark.tsx" props={{ label: 'spark' }} width={40} height={1} />
      <Client key="pane-clock" module="./clock.tsx" props={{ label: 'pane clock' }} />
      {Array.from({ length: 12 }, (_, index) => <Text dimColor>scroll row {index + 1}</Text>)}
    </Box>
  })

  on('ui.focus', async ($, e, next) => {
    await $.fs.write('.lab/ui-focus.json', JSON.stringify(e, null, 2))
    return next(e)
  })
  on('ui.scroll', async ($, e, next) => {
    await $.fs.write('.lab/ui-scroll.json', JSON.stringify(e, null, 2))
    return next(e)
  })
  on('ui.close', async ($, e, next) => {
    $.ui.toast('pane ' + e.id + ' closed (ui.close)', { timeoutMs: 6000 })
    return next(e)
  })
  // What a Client posts reaches only this plugin's hooks; { props } answers
  // the posting instance its next props.
  on('ui.message', async ($, e, next) => {
    lastMessage = JSON.stringify(e.data)
    await $.fs.write('.lab/client-message-' + e.element + '.json', JSON.stringify(e, null, 2))
    $.ui.invalidate('ui.render')
    return { props: { label: (e.element === 'clock' ? 'band clock' : 'pane clock') + ' (answered)' } }
  })
  on('ui.fault', async ($, e, next) => {
    await $.fs.write('.lab/client-fault.json', JSON.stringify(e, null, 2))
    return next(e)
  })
}
