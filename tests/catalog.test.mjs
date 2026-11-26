import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  contextModelId, contextOf, contextTokensOf, createCatalog, modelRouteOf, modelSelection, reasoningOf,
  toModelInfo, toModelInfos,
} from '../catalog.js'
import { BridgeFailure } from '../errors.js'

const composer = {
  id: 'composer-2.5',
  displayName: 'Composer 2.5',
  description: 'Coding model',
  parameters: [{
    id: 'effort',
    values: [
      { value: 'low', displayName: 'Low' },
      { value: 'high', displayName: 'High' },
    ],
  }],
}

const opus = {
  id: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  description: 'Long-context model',
  parameters: [
    {
      id: 'context',
      displayName: 'Context',
      values: [
        { value: '300k', displayName: '300K' },
        { value: '1m', displayName: '1M' },
      ],
    },
    {
      id: 'effort',
      displayName: 'Effort',
      values: [
        { value: 'low', displayName: 'Low' },
        { value: 'medium', displayName: 'Medium' },
        { value: 'high', displayName: 'High' },
      ],
    },
    {
      id: 'fast',
      displayName: 'Fast',
      values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
    },
  ],
  variants: [
    {
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '300K Low',
    },
    {
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'medium' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '300K Medium',
    },
    {
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '300K High',
    },
    {
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '1M Low',
    },
    {
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'medium' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '1M Medium',
      isDefault: true,
      isMaxMode: true,
    },
    {
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
      displayName: '1M High',
      isMaxMode: true,
    },
  ],
}

describe('catalog', () => {
  it('maps a catalog row to a selector entry', () => {
    assert.deepEqual(toModelInfo('cursor', composer), {
      provider: 'cursor',
      id: 'composer-2.5',
      name: 'Composer 2.5',
      description: 'Coding model',
    })
  })

  it('expands context variants with the catalog default first', () => {
    assert.deepEqual(toModelInfos('cursor', opus), [
      {
        provider: 'cursor',
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5 · 1M',
        description: 'Long-context model',
      },
      {
        provider: 'cursor',
        id: contextModelId('claude-opus-5-5', '300k'),
        name: 'Claude Opus 5.5 · 300K',
        description: 'Long-context model',
      },
    ])
    assert.equal(contextOf(opus)?.defaultValue, '1m')
    assert.equal(contextTokensOf('1m'), 1_000_000)
    assert.equal(contextTokensOf('300k'), 300_000)
    assert.equal(contextTokensOf('1.5m'), 1_500_000)
    assert.equal(contextTokensOf('nope'), undefined)
  })

  it('parses synthetic context ids back to the Cursor model id', () => {
    const id = contextModelId('claude-opus-5-5', '300k')
    assert.deepEqual(modelRouteOf(id), { id: 'claude-opus-5-5', contextValue: '300k' })
    assert.deepEqual(modelRouteOf('claude-opus-5-5'), {
      id: 'claude-opus-5-5',
      contextValue: undefined,
    })
  })

  it('uses the catalog default variant for reasoning defaults', () => {
    const reasoning = reasoningOf(opus)
    assert.equal(reasoning?.parameterId, 'effort')
    assert.equal(reasoning?.defaultEffort, 'medium')
  })

  it('passes a complete matching variant and Max Mode flag', () => {
    assert.deepEqual(modelSelection('claude-opus-5-5', 'high', [opus]), {
      id: 'claude-opus-5-5',
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
      maxMode: true,
    })
  })

  it('keeps the default context when the caller omits an effort', () => {
    assert.deepEqual(modelSelection('claude-opus-5-5', undefined, [opus]), {
      id: 'claude-opus-5-5',
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'medium' },
        { id: 'fast', value: 'false' },
      ],
      maxMode: true,
    })
  })

  it('maps a non-default context selector to its variant', () => {
    const id = contextModelId('claude-opus-5-5', '300k')
    assert.deepEqual(modelSelection(id, 'high', [opus]), {
      id: 'claude-opus-5-5',
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    })
  })

  it('still accepts a synthetic context id while the catalog is unavailable', () => {
    const id = contextModelId('claude-opus-5-5', '300k')
    assert.deepEqual(modelSelection(id, undefined, undefined), {
      id: 'claude-opus-5-5',
      params: [{ id: 'context', value: '300k' }],
    })
  })

  it('rejects a context the model does not list', () => {
    const id = contextModelId('claude-opus-5-5', '2m')
    assert.throws(
      () => modelSelection(id, undefined, [opus]),
      (error) => error instanceof BridgeFailure && error.code === 'UNSUPPORTED_CONTEXT',
    )
  })

  it('exposes a reasoning parameter and passes the selected value', () => {
    const reasoning = reasoningOf(composer)
    assert.equal(reasoning?.parameterId, 'effort')
    assert.equal(reasoning?.defaultEffort, 'low')
    assert.deepEqual(modelSelection('composer-2.5', 'high', [composer]), {
      id: 'composer-2.5',
      params: [{ id: 'effort', value: 'high' }],
    })
    assert.deepEqual(modelSelection('composer-2.5', undefined, [composer]), { id: 'composer-2.5' })
  })

  it('rejects an effort the model does not list', () => {
    assert.throws(
      () => modelSelection('composer-2.5', 'max', [composer]),
      (error) => error instanceof BridgeFailure && error.code === 'UNSUPPORTED_REASONING_EFFORT',
    )
  })

  it('reuses a successful list until the ttl passes', async () => {
    let now = 0
    let calls = 0
    const catalog = createCatalog({
      now: () => now,
      ttlMs: 1000,
      list: async () => {
        calls += 1
        return [composer]
      },
    })
    assert.equal((await catalog.load('key')).length, 1)
    assert.equal((await catalog.load('key')).length, 1)
    assert.equal(calls, 1)
    now = 1000
    await catalog.load('key')
    assert.equal(calls, 2)
  })
})
