// A mod a person installs: the model's side. Every model request streams
// through its turn.step hook, which hides the word SECRET on screen and in the
// transcript alike, or answers without the model (/lab-canned); its
// prompt.compose hook adds a section the model reads.
let rewriting = true
let canned = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lab-stream', description: 'Mod lab: turn the turn.step rewrite of SECRET on or off' })
    await $.command.register({ name: 'lab-canned', description: 'Mod lab: the next answer comes from the hook, no model request' })
    return next(e)
  })
  on('command.run', { command: 'lab-stream' }, async () => {
    rewriting = !rewriting
    return { text: 'lab-stream: the SECRET rewrite is ' + (rewriting ? 'on' : 'off') }
  })
  on('command.run', { command: 'lab-canned' }, async () => {
    canned = true
    return { text: 'lab-canned: the next message is answered by lab-stream, without the model' }
  })

  on('turn.step', async function* ($, e, next) {
    // Answered here: nothing reaches the model.
    if (canned) {
      canned = false
      yield { kind: 'text', index: 0, text: 'LAB-CANNED: answered by the lab-stream hook, ' }
      yield { kind: 'text', index: 0, text: 'no model request was sent.' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: 'LAB-CANNED: answered by the lab-stream hook, no model request was sent.', toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const stream = next(e)
    for await (const chunk of stream) {
      if (rewriting && chunk.kind === 'text') yield { ...chunk, text: chunk.text.replaceAll('SECRET', '[hidden by lab-stream]') }
      else yield chunk
    }
    const result = await stream.result
    await $.fs.write('.lab/step-' + e.turnId.slice(0, 8) + '-' + e.index + '.json', JSON.stringify({
      input: e,
      stopReason: result.stopReason,
      toolUses: result.toolUses,
      usage: result.usage,
      trace: next.trace.map(entry => ({ plugin: entry.plugin, outcome: entry.outcome, chunks: entry.chunks })),
    }, null, 2))
    return rewriting ? { ...result, answer: result.answer.replaceAll('SECRET', '[hidden by lab-stream]') } : result
  })

  // One more section of the system prompt, after the session's own.
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return {
      sections: [...sections, {
        id: 'lab-stream:policy',
        text: 'Mod lab policy: the lab word is KIWI-42. When asked for the lab word, answer KIWI-42.',
        scope: 'session',
      }],
    }
  })
}
