// A Client module: drawn on the drawing thread, sandboxed (no $, no Node),
// with its own state, a timer, keys after a click (Esc gives them back), the
// pointer's clicks and crossings (fullscreen), and posts to its hooks.
export default function Clock(props, surface) {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ seconds: 0, key: '-', clicks: 0, over: false })
    surface.every(1000, () => surface.setState({ ...surface.state, seconds: surface.state.seconds + 1 }))
    surface.onKey(event => surface.setState({ ...surface.state, key: event.key }))
    surface.onPointer(event => {
      if (event.type === 'down') {
        const clicks = surface.state.clicks + 1
        surface.setState({ ...surface.state, clicks })
        surface.post({ clicked: clicks })
      } else if (event.type === 'enter' || event.type === 'leave') {
        surface.setState({ ...surface.state, over: event.type === 'enter' })
      }
    })
    surface.post({ mounted: props.label })
  }
  const state = surface.state ?? { seconds: 0, key: '-', clicks: 0, over: false }
  return <Text dimColor={!state.over}>{props.label} {state.seconds}s · key {state.key} · clicks {state.clicks}{state.over ? ' · pointer here' : ''}</Text>
}
