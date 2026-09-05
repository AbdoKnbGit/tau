/** Run separately: bun test src/constants/antigravity_report_prefix.test.ts */
import { afterAll, expect, mock, test } from 'bun:test'
import { API_PROVIDERS, type APIProvider } from '../utils/model/providerRegistry.js'

let selectedProvider: APIProvider = 'antigravity'
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => true,
}))
mock.module('../utils/debug.js', () => ({ logForDebugging: () => {} }))
mock.module('../utils/model/providers.js', () => ({ getAPIProvider: () => selectedProvider }))
mock.module('../utils/workloadContext.js', () => ({ getWorkload: () => undefined }))

const { getCLISyspromptPrefix } = await import('./system.js')
const reportOptions = {
  isNonInteractive: true,
  hasAppendSystemPrompt: false,
  querySource: 'report' as const,
}

afterAll(() => mock.restore())

test('Antigravity reports do not acquire a Claude SDK identity', () => {
  for (const hasAppendSystemPrompt of [false, true]) {
    expect(getCLISyspromptPrefix({
      ...reportOptions, requestProvider: 'antigravity', hasAppendSystemPrompt,
    })).toBe('')
  }
})

test('auto-routed Antigravity reports use the effective request provider', () => {
  selectedProvider = 'openai'
  expect(getCLISyspromptPrefix({
    ...reportOptions, requestProvider: 'antigravity',
  })).toBe('')
})

test('every other provider retains its existing report prefix', () => {
  for (const provider of API_PROVIDERS.filter(value => value !== 'antigravity')) {
    selectedProvider = provider
    for (const hasAppendSystemPrompt of [false, true]) {
      expect(getCLISyspromptPrefix({
        ...reportOptions, requestProvider: provider, hasAppendSystemPrompt,
      })).toBe(getCLISyspromptPrefix({ ...reportOptions, hasAppendSystemPrompt }))
    }
  }
})

test('Antigravity chat and unrelated side queries retain their existing prefix', () => {
  selectedProvider = 'antigravity'
  for (const isNonInteractive of [false, true]) {
    for (const hasAppendSystemPrompt of [false, true]) {
      const options = { isNonInteractive, hasAppendSystemPrompt }
      expect(getCLISyspromptPrefix({
        ...options, requestProvider: 'antigravity', querySource: 'repl_main_thread',
      })).toBe(getCLISyspromptPrefix(options))
      expect(getCLISyspromptPrefix({
        ...options, requestProvider: 'antigravity',
      })).toBe(getCLISyspromptPrefix(options))
    }
  }
})
