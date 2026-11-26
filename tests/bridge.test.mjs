import assert from 'node:assert/strict'
import os from 'node:os'
import nodePath from 'node:path'
import { describe, it } from 'node:test'

import { createBridge, sessionKey } from '../bridge.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const usage = {
  inputTokens: 4,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 6,
}

function createFakeClient() {
  const agents = []
  return {
    agents,
    async createAgent() {
      const agent = {
        disposed: false,
        sends: [],
        async send(message, listeners) {
          let resolveWait
          const run = {
            cancelled: false,
            wait() {
              return new Promise((resolve) => {
                resolveWait = resolve
              })
            },
            async cancel() {
              this.cancelled = true
              resolveWait?.({ status: 'cancelled' })
            },
            finish(result) {
              resolveWait(result)
            },
          }
          agent.sends.push({ message, listeners, run })
          return run
        },
        async dispose() {
          agent.disposed = true
        },
      }
      agents.push(agent)
      return agent
    },
  }
}

function harness() {
  const scheduled = []
  const client = createFakeClient()
  const bridge = createBridge({
    client,
    cwd: nodePath.join(os.tmpdir(), 'dsh-simple-cursor-test'),
    defer(fn) {
      scheduled.push(fn)
      return () => {
        const index = scheduled.indexOf(fn)
        if (index >= 0) scheduled.splice(index, 1)
      }
    },
  })
  return {
    bridge,
    client,
    flush() {
      const fns = scheduled.splice(0)
      for (const fn of fns) fn()
    },
  }
}

async function collect(iter) {
  const chunks = []
  const done = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) return chunks
      chunks.push(step.value)
    }
  })()
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('stream timed out')), 1000)
  })
  return Promise.race([done, timeout])
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('timed out waiting')
}

function request(messages, extra = {}) {
  return {
    provider: 'cursor',
    model: 'composer-2.5',
    sessionId: 'session-1',
    messages,
    ...extra,
  }
}

const extras = {
  apiKey: 'cursor_test',
  model: { id: 'composer-2.5' },
  async loadImage() {
    throw new Error('no image')
  },
}

describe('bridge', () => {
  it('streams text from one local agent and follows up with only the new user text', async () => {
    const { bridge, client } = harness()
    const iter = bridge.stream(request([user('hi')]), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    const first = client.agents[0].sends[0]
    assert.match(first.message.text, /User:\nhi/)
    first.listeners.onText('Hello')
    first.run.finish({ status: 'finished', result: 'Hello', usage })
    const chunks = await collected
    assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'Hello')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.find((chunk) => chunk.type === 'usage').usage.totalTokens, 6)

    const follow = [
      user('hi'),
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      user('again'),
    ]
    const iter2 = bridge.stream(request(follow), extras)[Symbol.asyncIterator]()
    const collected2 = collect(iter2)
    await waitFor(() => client.agents[0].sends.length === 2)
    const second = client.agents[0].sends[1]
    assert.equal(second.message.text, 'User:\nagain')
    assert.equal(client.agents.length, 1)
    second.listeners.onText('ok')
    second.run.finish({ status: 'finished', result: 'ok', usage })
    const more = await collected2
    assert.equal(more.find((chunk) => chunk.type === 'text-delta').text, 'ok')
    await bridge.dispose()
    assert.equal(client.agents[0].disposed, true)
  })

  it('writes a one-shot system prompt ahead of the transcript', async () => {
    const { bridge, client } = harness()
    const iter = bridge.stream(
      request([user('hi')], { purpose: 'session-title', system: 'Name it.' }),
      extras,
    )[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    const send = client.agents[0].sends[0]
    assert.equal(send.message.text, 'System:\nName it.\n\nUser:\nhi')
    send.listeners.onText('Title')
    send.run.finish({ status: 'finished', result: 'Title', usage })
    await collected
    await bridge.dispose()
  })

  it('returns tool calls and resumes the same run with the tool result', async () => {
    const { bridge, client, flush } = harness()
    const tools = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' } }]
    const iter = bridge.stream(request([user('list')], { tools }), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    const send = client.agents[0].sends[0]
    const parked = send.listeners.onTool({ id: 'call-1', name: 'bash', args: { command: 'ls' } })
    parked.catch(() => {})
    flush()
    const chunks = await collected
    assert.equal(chunks.find((chunk) => chunk.type === 'tool-call-delta').id, 'call-1')
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    assert.equal(client.agents[0].disposed, false)

    const continued = [
      user('list'),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file.txt' }] },
    ]
    const iter2 = bridge.stream(request(continued, { tools }), extras)[Symbol.asyncIterator]()
    const collected2 = collect(iter2)
    const payload = await parked
    assert.equal(payload, 'file.txt')
    send.listeners.onText('listed')
    send.run.finish({ status: 'finished', result: 'listed', usage })
    const more = await collected2
    assert.equal(more.find((chunk) => chunk.type === 'text-delta').text, 'listed')
    assert.equal(client.agents.length, 1)
    await bridge.dispose()
  })

  it('opens a new agent when the history is no longer a continuation', async () => {
    const { bridge, client } = harness()
    const iter = bridge.stream(request([user('hi')]), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    client.agents[0].sends[0].listeners.onText('Hello')
    client.agents[0].sends[0].run.finish({ status: 'finished', result: 'Hello', usage })
    await collected

    const iter2 = bridge.stream(request([user('unrelated')]), extras)[Symbol.asyncIterator]()
    const collected2 = collect(iter2)
    await waitFor(() => client.agents.length === 2)
    assert.equal(client.agents[0].disposed, true)
    client.agents[1].sends[0].listeners.onText('new')
    client.agents[1].sends[0].run.finish({ status: 'finished', result: 'new', usage })
    await collected2
    await bridge.dispose()
  })

  it('keeps an auxiliary request off the conversation agent', async () => {
    const { bridge, client } = harness()
    const iter = bridge.stream(request([user('hi')]), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    client.agents[0].sends[0].listeners.onText('Hello')
    client.agents[0].sends[0].run.finish({ status: 'finished', result: 'Hello', usage })
    await collected

    const iter2 = bridge.stream(request([user('title this')], { purpose: 'title' }), extras)[Symbol.asyncIterator]()
    const collected2 = collect(iter2)
    await waitFor(() => client.agents.length === 2)
    assert.equal(client.agents[0].disposed, false)
    client.agents[1].sends[0].listeners.onText('Title')
    client.agents[1].sends[0].run.finish({ status: 'finished', result: 'Title', usage })
    await collected2
    assert.equal(sessionKey({ sessionId: 'session-1', purpose: 'title' }), 'purpose:session-1:title')
    await bridge.dispose()
  })

  it('cancels the run when the request aborts', async () => {
    const { bridge, client } = harness()
    const controller = new AbortController()
    const iter = bridge.stream(request([user('hi')], { signal: controller.signal }), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    controller.abort()
    await assert.rejects(collected, (error) => error.code === 'ABORTED')
    assert.equal(client.agents[0].sends[0].run.cancelled, true)
    assert.equal(client.agents[0].disposed, true)
  })

  it('fails an empty run', async () => {
    const { bridge, client } = harness()
    const iter = bridge.stream(request([user('hi')]), extras)[Symbol.asyncIterator]()
    const collected = collect(iter)
    await waitFor(() => client.agents[0]?.sends.length === 1)
    client.agents[0].sends[0].run.finish({ status: 'finished', result: '' })
    await assert.rejects(collected, (error) => error.code === 'EMPTY_RESPONSE')
    assert.equal(client.agents[0].disposed, true)
  })
})
