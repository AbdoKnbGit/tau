// A Client module that fails on purpose: its place shows one dimmed line, and
// lab-ui hears ui.fault.
export default function Broken() {
  throw new Error('lab broken on purpose')
}
