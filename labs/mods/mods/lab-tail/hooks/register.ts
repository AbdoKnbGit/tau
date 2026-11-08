// The append tier (appendPlugins): beneath every mod a person installs.
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lab-skip', description: 'Mod lab: lab-org jumps straight here with next.to' })
    return next(e)
  })

  // A link of the append tier in every turn's chain (lab-org's next.trace shows it).
  on('turn.start', async ($, e, next) => next(e))

  // lab-org's next.to(e, 'append') lands here; lab-app's hook for this command
  // sits in the user tier and must not run.
  on('command.run', { command: 'lab-skip' }, async ($, e, next) => {
    await $.fs.write('.lab/tail-skip.json', JSON.stringify({ origin: next.origin }, null, 2))
    return { text: 'lab-tail answered /lab-skip: next.to skipped the user tier' }
  })
}
