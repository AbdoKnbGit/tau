// Scripted model for fake-network runs (live runs use the real model).
// Only the actions a scenario needs to exercise tau's own paths:
//   subagent  main spawns a general-purpose sub-agent, which answers at once
//   midturn   main runs one slow shell command, then answers
//   anything else, and every helper request: a plain text answer
import { nativeCall, view } from './formats.mjs'

export function script(format, body) {
  const f = format === 'ollama' ? 'chat' : format
  const v = view(f, body)
  const main = v.tools.length > 0
  if (!main) return { main, action: 'ok' }
  const call = c => [nativeCall(f, c)]
  switch (process.env.E2E_SCENARIO) {
    case 'subagent': {
      const inSub = v.all.includes('LMI-SUB') && !v.all.includes('LMI-MAIN')
      if (inSub) return { main, action: 'sub done' }
      return {
        main,
        action: v.step === 0
          ? call({ name: 'Agent', input: {
            description: 'Report the codeword',
            prompt: 'LMI-SUB Reply with the lmi_early codeword from your MCP server instructions. Do not call any tools.',
            subagent_type: 'general-purpose',
          } })
          : 'ok',
      }
    }
    case 'midturn':
    case 'sdkmidturn':
      return {
        main,
        action: v.step === 0
          ? call({ name: 'Bash', input: { command: 'node -e "setTimeout(()=>{},4000)"', description: 'Wait four seconds' } })
          : 'ok',
      }
    default:
      return { main, action: 'ok' }
  }
}
