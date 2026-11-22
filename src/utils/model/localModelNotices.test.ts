import { beforeEach, describe, expect, test } from 'bun:test'
import {
  onLocalModelNotice,
  publishLocalModelNotice,
  resetLocalModelNoticesForTests,
} from './localModelNotices.js'

beforeEach(() => {
  resetLocalModelNoticesForTests()
})

describe('local model notices', () => {
  test('a notice published before the REPL listens is delivered when it does', () => {
    publishLocalModelNotice({ key: 'a', text: 'first' })
    const seen: string[] = []
    const stop = onLocalModelNotice(notice => seen.push(notice.text))
    expect(seen).toEqual(['first'])
    publishLocalModelNotice({ key: 'b', text: 'second' })
    expect(seen).toEqual(['first', 'second'])
    stop()
  })

  test('each key is shown once per process', () => {
    const seen: string[] = []
    const stop = onLocalModelNotice(notice => seen.push(notice.text))
    publishLocalModelNotice({ key: 'a', text: 'once' })
    publishLocalModelNotice({ key: 'a', text: 'again' })
    expect(seen).toEqual(['once'])
    stop()
  })

  test('a listener that stopped hears nothing more', () => {
    const seen: string[] = []
    const stop = onLocalModelNotice(notice => seen.push(notice.text))
    stop()
    publishLocalModelNotice({ key: 'a', text: 'later' })
    expect(seen).toEqual([])
  })
})
