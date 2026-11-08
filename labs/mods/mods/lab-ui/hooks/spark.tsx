// A Client module animating on its own timer, as wide as its region.
const BARS = [0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588].map(code => String.fromCodePoint(code))

export default function Spark(props, surface) {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(150, () => surface.setState(surface.state + 1))
  }
  const phase = surface.state ?? 0
  const width = Math.max(4, Math.min(60, surface.columns || 30))
  let line = ''
  for (let i = 0; i < width; i++) line += BARS[Math.floor((Math.sin((i + phase) / 3) + 1) * 3.5)]
  return <Text color="cyan">{line}</Text>
}
