import { getEnterPlanModeToolPrompt } from './prompt.js'

const previous = process.env.USER_TYPE

delete process.env.USER_TYPE
const external = getEnterPlanModeToolPrompt()
if (!external.includes('Use proactively for non-trivial implementation')) {
  throw new Error('external policy must preserve proactive planning')
}
if (!external.includes('multi-file work')) {
  throw new Error('external policy must preserve multi-file planning trigger')
}

process.env.USER_TYPE = 'ant'
const ant = getEnterPlanModeToolPrompt()
if (!ant.includes('Use only when genuine ambiguity')) {
  throw new Error('ant policy must remain ambiguity-gated')
}
if (!ant.includes('routine multi-file changes')) {
  throw new Error('ant policy must preserve multi-file skip')
}

if (previous === undefined) delete process.env.USER_TYPE
else process.env.USER_TYPE = previous

console.log('2 passed, 0 failed')
