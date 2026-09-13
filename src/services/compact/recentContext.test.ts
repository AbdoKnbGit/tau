import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { prepareRecentContext } from './recentContext.js'

const unitCost = () => 1
const text = (value: string) => ({ type: 'text', text: value })
const call = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: 'relative/file.ts' },
})
const result = (id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: 'exact output\nwith spacing  ',
})
function user(uuid: string, content: unknown = uuid, extra = {}): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
    ...extra,
  } as unknown as Message
}
function assistant(
  uuid: string,
  id = uuid,
  content: unknown = [text(uuid)],
  extra = {},
): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      id,
      content,
      usage: { input_tokens: 190_000, output_tokens: 100 },
    },
    ...extra,
  } as unknown as Message
}
function boundary(tailUuid?: string): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'boundary',
    compactMetadata: {
      trigger: 'auto',
      preTokens: 190_000,
      ...(tailUuid
        ? {
            preservedSegment: {
              headUuid: 'kept-head',
              tailUuid,
              anchorUuid: 'summary',
            },
          }
        : {}),
    },
  } as unknown as Message
}

test('selects the longest affordable suffix and leaves older history', () => {
  const messages = [
    user('old'),
    assistant('old-answer'),
    user('latest'),
    assistant('latest-answer'),
  ]
  const kept = prepareRecentContext(messages, 2, unitCost)!
  assert.equal(kept.startIndex, 2)
  assert.equal(kept.retainedTokens, 2)
  assert.deepEqual(kept.messagesToKeep, messages.slice(2))
  assert.equal(prepareRecentContext(messages, 100, unitCost)!.startIndex, 1)
})

test('invalid budgets and insufficient history do not invoke estimation', () => {
  const never = () => {
    throw new Error('must not estimate')
  }
  for (const budget of [0, -1, NaN, Infinity]) {
    assert.equal(
      prepareRecentContext([user('old'), user('new')], budget, never),
      undefined,
    )
  }
  assert.equal(prepareRecentContext([], 10, never), undefined)
  assert.equal(prepareRecentContext([user('only')], 10, never), undefined)
})

test('a streamed parallel tool round is kept whole or excluded whole', () => {
  const messages = [
    user('old'),
    assistant('a1', 'round', [call('a')]),
    user('r1', [result('a')]),
    assistant('a2', 'round', [call('b')]),
    user('r2', [result('b')]),
    assistant('final'),
  ]
  assert.equal(prepareRecentContext(messages, 4, unitCost)!.startIndex, 5)
  assert.equal(prepareRecentContext(messages, 5, unitCost)!.startIndex, 1)
})

test('response IDs cannot split even across another interleaved assistant response', () => {
  const messages = [
    user('old'),
    assistant('thinking', 'same', [
      { type: 'thinking', thinking: 'exact', signature: 'opaque' },
    ]),
    assistant('other', 'other'),
    assistant('late-text', 'same'),
    assistant('new'),
  ]
  assert.equal(prepareRecentContext(messages, 3, unitCost)!.startIndex, 4)
  assert.equal(prepareRecentContext(messages, 4, unitCost)!.startIndex, 1)
})

test('tool pairing cannot split even across a different assistant response', () => {
  const messages = [
    user('old'),
    assistant('call', 'a', [call('t')]),
    assistant('interleaved', 'b'),
    user('result', [result('t')]),
    assistant('new'),
  ]
  assert.equal(prepareRecentContext(messages, 3, unitCost)!.startIndex, 4)
  assert.equal(prepareRecentContext(messages, 4, unitCost)!.startIndex, 1)
})

test('unmatched, duplicate, and reversed tools are summarized before a safe later round', () => {
  const malformed = [
    [assistant('call', 'a', [call('t')])],
    [user('orphan', [result('t')])],
    [
      assistant('call', 'a', [call('t'), call('t')]),
      user('result', [result('t')]),
    ],
    [
      assistant('call', 'a', [call('t')]),
      user('result', [result('t'), result('t')]),
    ],
    [user('result', [result('t')]), assistant('call', 'a', [call('t')])],
    [user('wrong-role', [call('t')])],
    [
      assistant('missing-id', 'a', [
        { type: 'tool_use', name: 'Read', input: {} },
      ]),
    ],
  ]
  for (const broken of malformed) {
    const messages = [user('old'), ...broken, assistant('safe')]
    assert.deepEqual(
      prepareRecentContext(messages, 100, unitCost)!.messagesToKeep,
      [messages.at(-1)],
    )
    assert.equal(
      prepareRecentContext(messages.slice(0, -1), 100, unitCost),
      undefined,
    )
  }
})

test('a text-plus-tool-result user message never becomes the suffix head', () => {
  const messages = [
    user('old'),
    assistant('call', 'a', [call('t')]),
    user('mixed', [text('extra'), result('t')]),
    assistant('new'),
  ]
  assert.equal(prepareRecentContext(messages, 2, unitCost)!.startIndex, 3)
})

test('meta, virtual, transcript-only, and API-error messages do not start a suffix', () => {
  const excluded = [
    user('meta', 'context', { isMeta: true }),
    user('virtual', 'context', { isVirtual: true }),
    user('hidden', 'context', { isVisibleInTranscriptOnly: true }),
    assistant('error', 'error', [text('failed')], { isApiErrorMessage: true }),
  ]
  for (const message of excluded) {
    assert.equal(
      prepareRecentContext([user('old'), message], 10, unitCost),
      undefined,
    )
  }
})

test('previous boundaries, summaries, and preserved segments cannot be retained again', () => {
  const messages = [
    user('obsolete'),
    boundary('kept-tail'),
    user('summary', 'summary', { isCompactSummary: true }),
    user('kept-head'),
    assistant('kept-tail'),
    user('new'),
    assistant('new-answer'),
  ]
  assert.equal(prepareRecentContext(messages, 100, unitCost)!.startIndex, 5)
  const withoutSegment = [
    boundary(),
    user('summary', 'summary', { isCompactSummary: true }),
    assistant('new'),
  ]
  assert.equal(
    prepareRecentContext(withoutSegment, 100, unitCost)!.startIndex,
    2,
  )
  assert.equal(
    prepareRecentContext([boundary('missing'), user('new')], 100, unitCost),
    undefined,
  )
  assert.equal(
    prepareRecentContext(messages.slice(0, 5), 100, unitCost),
    undefined,
  )
})

test('only the latest compact boundary determines the previous preserved segment', () => {
  const messages = [
    boundary('missing-old-tail'),
    { ...boundary(), uuid: 'new-boundary' } as Message,
    user('new'),
  ]
  assert.equal(prepareRecentContext(messages, 100, unitCost)!.startIndex, 2)
})

test('keeps object identity and signed/media/provider content exactly unchanged', () => {
  const content = [
    {
      type: 'thinking',
      thinking: 'reasoning\r\n  ',
      signature: 'opaque-signature',
    },
    { type: 'redacted_thinking', data: 'opaque-data' },
    {
      type: 'server_tool_use',
      id: 'server',
      name: 'web_search',
      input: { query: 'example' },
    },
    { type: 'web_search_tool_result', tool_use_id: 'server', content: [] },
    {
      type: 'text',
      text: 'exact answer\n   ',
      provider_metadata: { opaque: true },
    },
  ]
  const messages = [
    user('old'),
    user('image', [
      { type: 'image', source: { type: 'base64', data: 'opaque' } },
    ]),
    assistant('answer', 'response', content),
  ]
  const serialized = JSON.stringify(messages)
  Object.freeze(messages)
  for (const message of messages) Object.freeze(message)
  const kept = prepareRecentContext(messages, 2, unitCost)!
  assert.equal(kept.messagesToKeep[0], messages[1])
  assert.equal(kept.messagesToKeep[1], messages[2])
  assert.equal(JSON.stringify(messages), serialized)
})

test('omits progress while preserving original startIndex and non-progress suffix order', () => {
  const progress = { type: 'progress' } as Message
  const messages = [
    user('old'),
    progress,
    user('new'),
    progress,
    assistant('answer'),
    progress,
  ]
  let estimates = 0
  const kept = prepareRecentContext(messages, 2, message => {
    assert.notEqual(message.type, 'progress')
    estimates++
    return 1
  })!
  assert.equal(kept.startIndex, 2)
  assert.deepEqual(kept.messagesToKeep, [messages[2], messages[4]])
  assert.equal(kept.retainedTokens, 2)
  assert.equal(estimates, 2)
})

test('estimates each examined message once and stops when the suffix exceeds its cap', () => {
  const messages = Array.from({ length: 10_000 }, (_, i) =>
    user(`message-${i}`),
  )
  const examined = new Set<Message>()
  const kept = prepareRecentContext(messages, 100, message => {
    assert.equal(examined.has(message), false)
    examined.add(message)
    return 1
  })!
  assert.equal(kept.startIndex, 9_900)
  assert.equal(examined.size, 101)
})

test('invalid estimates and missing response IDs cannot enter the retained suffix', () => {
  const messages = [user('old'), assistant('invalid'), assistant('safe')]
  for (const invalid of [NaN, Infinity, -1]) {
    assert.equal(
      prepareRecentContext(messages, 10, message =>
        message === messages[1] ? invalid : 1,
      )!.startIndex,
      2,
    )
    assert.equal(
      prepareRecentContext(messages, 10, () => invalid),
      undefined,
    )
  }
  assert.equal(
    prepareRecentContext(
      [user('old'), assistant('missing', ''), assistant('safe')],
      10,
      unitCost,
    )!.startIndex,
    2,
  )
})

test('missing and duplicate UUIDs cannot become ambiguous persisted segment endpoints', () => {
  for (const broken of [user(''), user('old')]) {
    const messages = [user('old'), broken, assistant('safe')]
    assert.equal(prepareRecentContext(messages, 10, unitCost)!.startIndex, 2)
  }
})

test('malformed content blocks are quarantined without invoking their estimator', () => {
  const malformedContent = [
    [null],
    [undefined],
    new Array(1),
    [{ text: 'missing type' }],
    [{ type: undefined }],
    [{ type: '' }],
    ['untyped block'],
    [42],
    [text('valid'), null],
    null,
    42,
    { type: 'text', text: 'content must be an array or string' },
  ]
  for (const content of malformedContent) {
    const broken = assistant('broken', 'broken-response', content)
    const safe = assistant('safe')
    const messages = [user('old'), broken, safe]
    const kept = prepareRecentContext(messages, 100, message => {
      assert.equal(message, safe)
      return 1
    })
    assert.deepEqual(kept?.messagesToKeep, [safe])
    assert.equal(
      prepareRecentContext(messages.slice(0, -1), 100, unitCost),
      undefined,
    )
  }
})

test('malformed tool-result content is also quarantined', () => {
  for (const content of [
    [null],
    new Array(1),
    [{ text: 'missing type' }],
    42,
    null,
  ]) {
    const messages = [
      user('old'),
      assistant('call', 'call', [call('t')]),
      user('broken-result', [{ ...result('t'), content }]),
      assistant('safe'),
    ]
    assert.equal(prepareRecentContext(messages, 100, unitCost)?.startIndex, 3)
    assert.equal(
      prepareRecentContext(messages.slice(0, -1), 100, unitCost),
      undefined,
    )
  }
})

test('missing conversation payloads and sparse message arrays do not throw', () => {
  const malformed = [
    null,
    undefined,
    { type: 'assistant', uuid: 'broken' },
    { type: 'assistant', uuid: 'broken', message: null },
    { type: 'user', uuid: 'broken' },
  ]
  for (const broken of malformed) {
    const messages = [user('old'), broken, assistant('safe')] as Message[]
    assert.equal(prepareRecentContext(messages, 100, unitCost)?.startIndex, 2)
  }
  const sparse = [user('old'), , assistant('safe')] as Message[]
  assert.equal(prepareRecentContext(sparse, 100, unitCost)?.startIndex, 2)
})

test('a compact boundary without metadata remains a boundary', () => {
  const oldBoundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'old-boundary',
  } as Message
  const messages = [user('old'), oldBoundary, assistant('new')]
  assert.equal(prepareRecentContext(messages, 100, unitCost)?.startIndex, 2)
})

test('well-formed blocks with new provider types remain opaque and unmodified', () => {
  const extension = {
    type: 'future_content_block',
    provider_data: { untouched: true },
  }
  const answer = assistant('new', 'new', [extension])
  const kept = prepareRecentContext([user('old'), answer], 100, unitCost)!
  assert.equal(kept.messagesToKeep[0], answer)
})
