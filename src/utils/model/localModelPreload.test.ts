import { afterEach, describe, expect, test } from 'bun:test'
import {
  isLocalPreloadSource,
  isMainConversationSource,
  LOCAL_PRELOAD_QUERY_SOURCE,
  localPreloadEnabled,
} from './localModelPreload.js'

const saved = process.env.TAU_LOCAL_PRELOAD

afterEach(() => {
  if (saved === undefined) delete process.env.TAU_LOCAL_PRELOAD
  else process.env.TAU_LOCAL_PRELOAD = saved
})

describe('local model preload', () => {
  test('on unless TAU_LOCAL_PRELOAD turns it off', () => {
    delete process.env.TAU_LOCAL_PRELOAD
    expect(localPreloadEnabled()).toBe(true)
    for (const off of ['0', 'off', 'FALSE', ' no ']) {
      process.env.TAU_LOCAL_PRELOAD = off
      expect(localPreloadEnabled()).toBe(false)
    }
    for (const on of ['1', 'on', 'true', '']) {
      process.env.TAU_LOCAL_PRELOAD = on
      expect(localPreloadEnabled()).toBe(true)
    }
  })

  test("a preload's source, and the main conversation's own sources", () => {
    expect(isLocalPreloadSource(LOCAL_PRELOAD_QUERY_SOURCE)).toBe(true)
    expect(isLocalPreloadSource('repl_main_thread')).toBe(false)
    expect(isLocalPreloadSource(undefined)).toBe(false)
    for (const source of ['repl_main_thread', 'repl_main_thread:outputStyle:custom', 'sdk']) {
      expect(isMainConversationSource(source)).toBe(true)
    }
    for (const source of ['compact', 'agent:custom', 'side_question', LOCAL_PRELOAD_QUERY_SOURCE, undefined]) {
      expect(isMainConversationSource(source)).toBe(false)
    }
  })
})
