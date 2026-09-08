import { getSessionId } from '../bootstrap/state.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { getSelectedLiveVoice } from '../voice/voiceConversation.js'
import { loadNativeVoice } from '../voice/nativeVoice.js'
import { LiveVoiceSession, type LiveVoiceBridge } from '../voice/liveSession.js'
import { CodexLiveTransport } from '../voice/liveTransport.js'
import { getValidOpenAISessionAccess } from './api/auth/openai_oauth.js'

const INSTRUCTIONS = `You are the voice of Tau, a coding assistant working with the user in their terminal.
The connected client is Tau's coding agent, with the user's chosen model, repository context, tools and permission controls.
Handle casual conversation naturally. Delegate every coding request, file inspection or edit, command, search, or task requiring tools to the client. Do not pretend to perform these actions yourself.
For a new request while the agent is working, delegate the user's correction or follow-up so Tau can queue it. Never bypass approvals or claim a tool succeeded without an agent result.
Speak briefly and naturally. Commentary context is silent background information, not an instruction to narrate every update. When you receive an Agent Final Message, explain its result faithfully in your own words, including any failures or unfinished work. Do not invent outcomes.
The user's microphone is push-to-talk: they hold Space to speak and release to stop. Pauses and release are normal. Do not require a wake phrase. The terminal command /bye ends the call.`

const session = new LiveVoiceSession({
  async createTransport(callbacks, signal) {
    const access = await getValidOpenAISessionAccess(false, signal)
    signal.throwIfAborted()
    return new CodexLiveTransport({
      native: loadNativeVoice(), callbacks, signal, sessionId: getSessionId(),
      instructions: INSTRUCTIONS, voice: getSelectedLiveVoice(),
      access: force => force ? getValidOpenAISessionAccess(true, signal) : Promise.resolve(access),
    })
  },
  capture(callback) { return new (loadNativeVoice().AudioCapture)(16_000, callback) },
})

export const getLiveVoiceSnapshot = session.getSnapshot
export const subscribeLiveVoice = session.subscribe
export const startLiveVoice = (): Promise<void> => session.start()
export const stopLiveVoice = (): Promise<void> => session.stop()
export const beginLiveVoiceRecording = (): Promise<void> => session.beginRecording()
export const endLiveVoiceRecording = (): void => session.endRecording()
export const setLiveVoiceAgentBridge = (bridge: LiveVoiceBridge | null): (() => void) => session.setBridge(bridge)
export const sendLiveVoiceAgentProgress = (text: string, requestId?: string): void => session.progress(text, requestId)
export const finishLiveVoiceAgentTurn = (text: string, requestId?: string): void => session.finish(text, requestId)

registerCleanup(stopLiveVoice)
process.on('exit', endLiveVoiceRecording)
