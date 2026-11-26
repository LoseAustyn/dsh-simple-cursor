import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalMessages, classify, renderTranscript, toolResultPayload, withSystemPrompt } from '../transcript.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

describe('transcript', () => {
  it('renders a system prompt and an image placeholder into one user message', () => {
    const image = { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }
    const rendered = renderTranscript([
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, image] },
    ])
    assert.match(rendered.text, /System:\nBe brief\./)
    assert.match(rendered.text, /User:\nLook\n\[image 1\]/)
    assert.equal(rendered.images.length, 1)
  })

  it('continues a text turn with only the new user message', () => {
    const seen = canonicalMessages([user('hi'), assistant('hello')])
    const next = [user('hi'), assistant('hello'), user('again')]
    const plan = classify(seen, next, new Set())
    assert.equal(plan.kind, 'follow-up')
    assert.deepEqual(plan.messages, [user('again')])
  })

  it('recognizes a held tool result and rejects a rewritten history', () => {
    const seen = canonicalMessages([user('hi')])
    const next = [
      user('hi'),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
    ]
    assert.equal(classify(seen, next, new Set(['call-1'])).kind, 'tools')
    assert.equal(classify(seen, [user('other')], new Set()).kind, 'fresh')
    assert.equal(classify(seen, next, new Set()).kind, 'fresh')
  })

  it('puts a one-shot system prompt ahead of the transcript', () => {
    assert.equal(withSystemPrompt(undefined, 'User:\nhi'), 'User:\nhi')
    assert.equal(withSystemPrompt('  ', 'User:\nhi'), 'User:\nhi')
    assert.equal(withSystemPrompt('Name it.', 'User:\nhi'), 'System:\nName it.\n\nUser:\nhi')
    assert.equal(withSystemPrompt('Name it.', ''), 'System:\nName it.')
  })

  it('returns an error envelope for a failed tool result', async () => {
    const payload = await toolResultPayload({
      role: 'tool',
      toolCallId: 'call-1',
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    }, async () => {
      throw new Error('unused')
    })
    assert.deepEqual(payload, { content: [{ type: 'text', text: 'nope' }], isError: true })
  })
})
