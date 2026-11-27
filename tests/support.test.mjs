import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { describe, it } from 'node:test'

import { createBlockWriter, mapUsage } from '../chunks.js'
import {
  DEFAULT_CONTEXT_WINDOW, contextWindowOf, rejectedCallOption, resolveConfig, unsupportedCallOption,
} from '../config.js'
import { failureFromUnknown, sanitizeErrorMessage } from '../errors.js'
import { createQueue } from '../queue.js'
import { Config } from '../schema.js'
import { cleanupAgentTranscripts, createInMemoryStore, localAgentOptions } from '../sdk.js'

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

  it('rejects symbolic links and sensitive system or credential directories for cwd', () => {
    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-sc-cfg-'))
    const realDir = nodePath.join(tmpRoot, 'workspace')
    const linkDir = nodePath.join(tmpRoot, 'link')
    fs.mkdirSync(realDir)
    fs.symlinkSync(realDir, linkDir)
    try {
      assert.equal(resolveConfig({ cwd: realDir }).cwd, realDir)
      assert.throws(() => resolveConfig({ cwd: linkDir }), /symbolic link/)
      assert.throws(() => resolveConfig({ cwd: '/' }), /owned by the current user|sensitive directory/)
      if (fs.existsSync('/etc')) {
        assert.throws(() => resolveConfig({ cwd: '/etc' }), /owned by the current user|sensitive directory/)
      }
      const sshDir = nodePath.join(os.homedir(), '.ssh')
      if (fs.existsSync(sshDir)) {
        assert.throws(() => resolveConfig({ cwd: sshDir }), /sensitive directory/)
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
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

  it('forwards fs and store overrides while keeping the locked tool boundary', () => {
    const fakeFs = { kind: 'empty' }
    const store = createInMemoryStore()
    assert.deepEqual(localAgentOptions({
      apiKey: 'cursor_test',
      model: { id: 'composer-2.5' },
      cwd: '/tmp/dsh',
      fs: fakeFs,
      store,
    }), {
      name: 'DSH',
      apiKey: 'cursor_test',
      model: { id: 'composer-2.5' },
      tools: ['mcp'],
      local: { cwd: '/tmp/dsh', settingSources: [], fs: fakeFs, store },
    })
  })

  it('stores agents, checkpoints, runs, and events in memory and cleans transcripts for disposed agents', async () => {
    const store = createInMemoryStore()
    await store.agents.create({
      agent: { agentId: 'agent-1', cwd: '/tmp/dsh', status: 'idle', createdAt: 1, updatedAt: 1 },
    })
    assert.equal((await store.agents.get({ agentId: 'agent-1' })).agentId, 'agent-1')
    await store.checkpoints.create({ agentId: 'agent-1', blobId: 'b1', data: new Uint8Array([1, 2]) })
    assert.equal((await store.checkpoints.get({ agentId: 'agent-1', blobId: 'b1' })).length, 2)
    const event = await store.runEvents.append({ runId: 'run-1', eventType: 'text', payload: { text: 'hi' } })
    assert.equal(event.seq, 1)

    const tmpRoot = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-sc-clean-'))
    try {
      const cwd = '/tmp/dsh-simple-cursor'
      const slug = 'tmp-dsh-simple-cursor'
      const transcriptsRoot = nodePath.join(tmpRoot, 'projects', slug, 'agent-transcripts')
      const target = nodePath.join(transcriptsRoot, 'agent-1')
      const sibling = nodePath.join(transcriptsRoot, 'agent-2')
      await fsp.mkdir(target, { recursive: true })
      await fsp.mkdir(sibling, { recursive: true })
      await fsp.writeFile(nodePath.join(target, 'agent-1.jsonl'), '{"role":"user"}\n')
      await fsp.writeFile(nodePath.join(sibling, 'agent-2.jsonl'), '{"role":"user"}\n')

      await cleanupAgentTranscripts(cwd, 'agent-1', { dataDir: tmpRoot })
      assert.equal(fs.existsSync(target), false)
      assert.equal(fs.existsSync(sibling), true)
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true })
    }
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

  it('redacts bearer tokens, api keys, and url queries from mapped error messages', () => {
    const raw = 'Authorization: Bearer secret_tok failed for cursor_abcdef123456 at https://user:pass@api2.cursor.sh/rpc?key=secret\nline2'
    const sanitized = sanitizeErrorMessage(raw)
    assert.equal(sanitized.includes('secret_tok'), false)
    assert.equal(sanitized.includes('cursor_abcdef123456'), false)
    assert.equal(sanitized.includes('?key=secret'), false)
    assert.equal(sanitized.includes('user:pass@'), false)
    assert.equal(sanitized.includes('\n'), false)

    const mapped = failureFromUnknown(new Error(raw), true)
    assert.equal(mapped.message.includes('secret_tok'), false)
    assert.equal(mapped.message.includes('cursor_abcdef123456'), false)
  })
})

describe('queue bounds', () => {
  it('fails closed when buffered events exceed maxItems', async () => {
    const queue = createQueue({ maxItems: 2 })
    queue.push({ type: 'text', text: '1' })
    queue.push({ type: 'text', text: '2' })
    queue.push({ type: 'text', text: '3' })
    assert.deepEqual(await queue.next(), { type: 'text', text: '1' })
    assert.deepEqual(await queue.next(), { type: 'text', text: '2' })
    await assert.rejects(queue.next(), (error) => error.code === 'TRANSPORT')
  })
})
