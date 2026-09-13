import { describe, expect, test } from 'bun:test'
import {
  getAnnouncedMermaidDiagrams,
  getMermaidDiagramsChange,
  getMermaidDiagramsReminder,
  getMermaidNotDrawnReminder,
} from './mermaidDiagramsReminder.js'

const announced = (enabled: boolean) => ({
  type: 'attachment',
  attachment: { type: 'mermaid_diagrams', enabled },
})
const user = { type: 'user' }
const other = { type: 'attachment', attachment: { type: 'date_change' } }

describe('getMermaidDiagramsChange', () => {
  test('says nothing while diagrams stay off', () => {
    expect(getMermaidDiagramsChange(false, [])).toBeNull()
    expect(getMermaidDiagramsChange(false, [user, other])).toBeNull()
  })

  test('announces once when diagrams are on', () => {
    expect(getMermaidDiagramsChange(true, [user])).toBe(true)
    expect(getMermaidDiagramsChange(true, [user, announced(true), user])).toBeNull()
  })

  test('announces a switch-off once, then stays quiet', () => {
    const history = [user, announced(true), user]
    expect(getMermaidDiagramsChange(false, history)).toBe(false)
    expect(getMermaidDiagramsChange(false, [...history, announced(false)])).toBeNull()
  })

  test('follows the latest announcement', () => {
    expect(getAnnouncedMermaidDiagrams([announced(true), announced(false)])).toBe(false)
    expect(
      getAnnouncedMermaidDiagrams([announced(true), announced(false), announced(true)]),
    ).toBe(true)
  })

  test('announces again once compaction has dropped the earlier one', () => {
    expect(getMermaidDiagramsChange(true, [{ type: 'system' }, user])).toBe(true)
  })
})

describe('getMermaidDiagramsReminder', () => {
  test('on: asks for a diagram and a description, and how to keep it drawable', () => {
    const text = getMermaidDiagramsReminder(true)
    for (const phrase of [
      '```mermaid',
      'terminal',
      'short plain-language description',
      'Never use tools',
      'flowchart TD',
      'sequenceDiagram',
      'stateDiagram-v2',
      'classDiagram',
      'erDiagram',
      'never more than 3 side by side',
      'no emoji, HTML',
      'on its own line',
      'split a bigger picture',
    ]) {
      expect(text).toContain(phrase)
    }
    expect(text.length).toBeLessThan(1400)
  })

  test('off: tells the model to stop using mermaid by default', () => {
    const text = getMermaidDiagramsReminder(false)
    expect(text).toContain('off')
    expect(text).toContain('Only write mermaid when the user asks')
  })
})

describe('getMermaidNotDrawnReminder', () => {
  test('says why and how to draw the next one', () => {
    const text = getMermaidNotDrawnReminder([
      'it needs 678 columns and the terminal has 120',
      'pie diagrams are not supported',
    ])
    expect(text).toContain('could not be drawn')
    expect(text).toContain('it needs 678 columns and the terminal has 120; pie diagrams are not supported')
    expect(text).toContain('at most 3 boxes side by side')
    expect(text.length).toBeLessThan(600)
  })
})
