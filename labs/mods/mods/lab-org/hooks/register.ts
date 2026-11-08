// The organization's tier (prependPlugins): above every mod a person installs.
// It guards their calls, judges which of them may load, adds $.labkit for all
// of them, reads the whole chain beneath it, and sees every telemetry record.
const seen = new Set<string>()

export function register(on) {
  // Every event the session raises; '*' leaves out telemetry, hooked by name.
  on('*', async ($, e, next) => {
    seen.add(next.event)
    return next(e)
  })

  // A guard above the other mods: nothing writes into secret/.
  on('fs.write', { path: /secret/ }, async () => ({ deny: 'lab-org keeps secret/ closed' }))

  // A mod named lab-refused never joins the chain.
  on('plugin.register', async ($, e, next) =>
    e.name === 'lab-refused' ? { refuse: 'lab-org refuses lab-refused' } : next(e))

  // $.labkit for every module; its method runs here, in lab-org.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, labkit: { hello: async (who: string) => 'hello ' + who + ' from lab-org' } }
  })

  // The whole chain of a turn's start, as it settled beneath this hook.
  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    await $.fs.write('.lab/org-trace.json', JSON.stringify({
      origin: next.origin,
      trace: next.trace.map(entry => ({ plugin: entry.plugin, tier: entry.tier, outcome: entry.outcome })),
    }, null, 2))
    return out
  })

  // /lab-skip continues straight at the append tier, past every user-tier hook.
  on('command.run', { command: 'lab-skip' }, async ($, e, next) => next.to(e, 'append'))

  // An organization's mod sees every telemetry record, both streams.
  on('telemetry.log', async ($, e, next) => {
    await $.fs.write('.lab/org-telemetry-' + e.event + '.json', JSON.stringify(e, null, 2))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await $.fs.write('.lab/org-seen-events.json', JSON.stringify([...seen].sort(), null, 2))
    return next(e)
  })
}
