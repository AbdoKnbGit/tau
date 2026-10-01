import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const [logFile, mode = 'normal'] = process.argv.slice(2)
const record = event =>
  appendFileSync(logFile, `${JSON.stringify({ ...event, pid: process.pid })}\n`)
record({ event: 'spawn' })
let worker
let input = Buffer.alloc(0)
const send = message => {
  const body = JSON.stringify(message)
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
process.stdin.on('data', data => {
  input = Buffer.concat([input, data])
  for (;;) {
    const end = input.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(
      /Content-Length: (\d+)/i.exec(input.subarray(0, end).toString())[1],
    )
    if (input.length < end + 4 + length) return
    const message = JSON.parse(input.subarray(end + 4, end + 4 + length))
    input = input.subarray(end + 4 + length)
    record({ event: message.method })
    if (message.method === 'initialize') {
      if (mode === 'hung-initialize' || mode === 'orphan-on-exit') {
        worker = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { stdio: 'ignore', windowsHide: true },
        )
        record({ event: 'worker', workerPid: worker.pid })
      }
      if (mode !== 'hung-initialize') {
        setTimeout(
          () =>
            respond(message.id, {
              capabilities: { hoverProvider: true, textDocumentSync: 1 },
            }),
          mode === 'slow' ? 250 : 0,
        )
      }
    } else if (message.method === 'shutdown') {
      if (mode !== 'hung-shutdown') respond(message.id, null)
    } else if (message.method === 'exit') {
      process.exit(0)
    } else if (message.method === 'textDocument/didOpen') {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [
            {
              message: 'fixture diagnostic',
              severity: 1,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
            },
          ],
        },
      })
    } else if (message.id !== undefined) {
      respond(message.id, { contents: 'fixture hover' })
    }
  }
})
process.on('exit', () => {
  if (mode !== 'orphan-on-exit') worker?.kill()
  record({ event: 'exit' })
})
