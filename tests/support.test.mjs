import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBlockWriter, mapUsage } from '../chunks.js'
import {
  DEFAULT_CONTEXT_WINDOW, contextWindowOf, rejectedCallOption, resolveConfig, unsupportedCallOption,
} from '../config.js'
import { failureFromUnknown } from '../errors.js'
import { Config } from '../schema.js'
import { localAgentOptions } from '../sdk.js'

describe('chunks', () => {
  it('closes a text block before a tool call', () => {
    const writer = createBlockWriter()
    const text = writer.text('Hi')
    const tool = writer.tool({ id: 'call-1', name: 'bash', args: { command: 'ls' } })
    const end = writer.close()
    assert.deepEqual(text.map((chunk) => chunk.type), ['block-start', 'text-delta'])
    assert.equal(tool[0].type, 'block-end')
    assert.equal(tool[1].index, 1)
    assert.equal(tool.at(-1).block.arguments, '{"command":"ls"}')
    assert.deepEqual(end, [])
    assert.deepEqual(writer.blocks().map((block) => block.type), ['text', 'tool-call'])
  })

  it('keeps cache counts when the total includes them', () => {
    assert.deepEqual(mapUsage({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 16,
      reasoningTokens: 1,
    }), {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
      totalTokens: 16,
    })
  })

  it('omits cache counts when the total already matches input plus output', () => {
    assert.deepEqual(mapUsage({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      totalTokens: 12,
    }), {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    })
  })
})

describe('config', () => {
  it('defaults an empty config', () => {
    assert.deepEqual(resolveConfig(undefined), {
      cwd: undefined,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    })
  })

  it('rejects an unknown field and removed key configuration fields', () => {
    assert.throws(() => resolveConfig({ token: 'x' }), /unknown config field/)
    assert.throws(() => resolveConfig({ apiKey: 'cursor_inline' }), /unknown config field "apiKey"/)
    assert.throws(() => resolveConfig({ apiKeyEnv: 'CURSOR_API_KEY' }), /unknown config field "apiKeyEnv"/)
  })

  it('accepts a fallback context capacity and rejects a non-positive one', () => {
    assert.equal(resolveConfig({ contextWindow: 200_000 }).contextWindow, 200_000)
    assert.throws(() => resolveConfig({ contextWindow: 0 }), /contextWindow must be a positive integer/)
    assert.throws(() => resolveConfig({ contextWindow: 1.5 }), /contextWindow must be a positive integer/)
    assert.throws(() => resolveConfig({ contextWindow: '128000' }), /contextWindow must be a positive integer/)
  })

  it('reads a volatile context capacity live', () => {
    let value = 64_000
    const live = { contextWindow: { get: () => value } }
    assert.equal(contextWindowOf(live), 64_000)
    value = 96_000
    assert.equal(contextWindowOf(live), 96_000)
    assert.equal(contextWindowOf(undefined), DEFAULT_CONTEXT_WINDOW)
  })

  it('names call controls the agent API cannot apply', () => {
    assert.equal(unsupportedCallOption({}), undefined)
    assert.equal(unsupportedCallOption({ maxTokens: 128 }), 'maxTokens')
    assert.equal(unsupportedCallOption({ stop: [] }), undefined)
    assert.equal(unsupportedCallOption({ temperature: 0 }), 'temperature')
  })

  it('runs an auxiliary request with agent defaults instead of failing it', () => {
    assert.equal(rejectedCallOption({ maxTokens: 64, purpose: 'compaction' }), undefined)
    assert.equal(rejectedCallOption({ maxTokens: 64, purpose: 'session-title' }), undefined)
    assert.equal(rejectedCallOption({ maxTokens: 64, purpose: '' }), 'maxTokens')
    assert.equal(rejectedCallOption({ maxTokens: 64 }), 'maxTokens')
  })
})

describe('config schema', () => {
  it('is a native schema the Loader validates the profile entry against', () => {
    assert.equal(Config[Symbol.for('schemastery')], true)
    assert.equal(Config.type, 'object')
    assert.equal(typeof Config.meta, 'object')
    assert.equal(Config.dict.contextWindow.meta.default, DEFAULT_CONTEXT_WINDOW)
    // The only supported key source is the credentials store written by the
    // plugin's own Settings section; profile key fields must not exist.
    assert.equal(Config.dict.apiKey, undefined)
    assert.equal(Config.dict.apiKeyEnv, undefined)
    assert.equal(Config.dict.contextWindow.meta.volatile, undefined)
  })

  it('resolves defaults into the config the adapter reads', () => {
    const resolved = Config({})
    assert.equal(resolved.contextWindow, DEFAULT_CONTEXT_WINDOW)
    assert.deepEqual(resolveConfig(resolved), {
      cwd: undefined,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    })
  })
})

describe('sdk options', () => {
  it('keeps only the mcp tool group and skips ambient settings', () => {
    assert.deepEqual(localAgentOptions({ apiKey: undefined, model: { id: 'composer-2.5' }, cwd: '/tmp/dsh' }), {
      name: 'DSH',
      model: { id: 'composer-2.5' },
      tools: ['mcp'],
      local: { cwd: '/tmp/dsh', settingSources: [] },
    })
  })
})

describe('failure mapping', () => {
  it('treats an authentication error without a supplied key as a missing credential', () => {
    const error = new Error('not logged in')
    error.name = 'AuthenticationError'
    error.status = 401
    assert.equal(failureFromUnknown(error, false).code, 'MISSING_CREDENTIAL')
    assert.equal(failureFromUnknown(error, true).code, 'AUTH')
  })

  it('maps a usage-limit rate error to the account quota', () => {
    const error = new Error('Usage limit exceeded')
    error.name = 'RateLimitError'
    error.status = 429
    assert.equal(failureFromUnknown(error, true).code, 'ACCOUNT_QUOTA')
  })
})
