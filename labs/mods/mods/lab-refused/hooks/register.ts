// lab-org refuses this mod at plugin.register: none of this may ever run.
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.fs.write('.lab/refused-ran.json', JSON.stringify('lab-refused ran: plugin.register did not refuse it'))
    return next(e)
  })
}
