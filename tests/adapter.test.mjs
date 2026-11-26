import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CursorAdapter, resolveApiKey } from '../adapter.js'
import { contextModelId } from '../catalog.js'

const opus = {
  id: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  description: 'Long-context model',
  parameters: [
    {
      id: 'context',
      values: [
        { value: '300k', displayName: '300K' },
        { value: '1m', displayName: '1M' },
      ],
    },
    {
      id: 'effort',
      values: [
        { value: 'low', displayName: 'Low' },
        { value: 'medium', displayName: 'Medium' },
        { value: 'high', displayName: 'High' },
      ],
    },
  ],
  variants: [
    {
      params: [{ id: 'context', value: '300k' }, { id: 'effort', value: 'low' }],
      displayName: '300K Low',
    },
    {
      params: [{ id: 'context', value: '300k' }, { id: 'effort', value: 'medium' }],
      displayName: '300K Medium',
    },
    {
      params: [{ id: 'context', value: '300k' }, { id: 'effort', value: 'high' }],
      displayName: '300K High',
    },
    {
      params: [{ id: 'context', value: '1m' }, { id: 'effort', value: 'low' }],
      displayName: '1M Low',
    },
    {
      params: [{ id: 'context', value: '1m' }, { id: 'effort', value: 'medium' }],
      displayName: '1M Medium',
      isDefault: true,
      isMaxMode: true,
    },
    {
      params: [{ id: 'context', value: '1m' }, { id: 'effort', value: 'high' }],
      displayName: '1M High',
      isMaxMode: true,
    },
  ],
}

const composer = {
  id: 'composer-2.5',
  displayName: 'Composer 2.5',
  parameters: [{
    id: 'fast',
    values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
  }],
  variants: [{
    params: [{ id: 'fast', value: 'true' }],
    displayName: 'Composer 2.5',
    isDefault: true,
  }],
}

function setup(options = {}) {
  const selections = []
  const adapter = new CursorAdapter({
    bridge: {
      async *stream(_request, extras) {
        selections.push(extras.model)
      },
    },
    contextWindow: () => 128_000,
    resolveApiKey: async () => 'cursor_test',
    loadImage: async () => {
      throw new Error('no image')
    },
    listModels: async () => {
      if (options.listError !== undefined) throw options.listError
      return options.models ?? [opus, composer]
    },
  })
  return { adapter, selections }
}

describe('adapter', () => {
  it('advertises context variants as separate model entries', async () => {
    const { adapter } = setup()
    const models = await adapter.listModels('cursor')
    assert.deepEqual(
      models.filter((model) => model.id.startsWith('claude-opus-5-5')).map((model) => ({
        id: model.id,
        name: model.name,
      })),
      [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · 1M' },
        {
          id: contextModelId('claude-opus-5-5', '300k'),
          name: 'Claude Opus 5.5 · 300K',
        },
      ],
    )
  })

  it('reports the selected variant context window to DSH', async () => {
    const { adapter } = setup()
    const defaultVariant = await adapter.resolveModel('cursor', 'claude-opus-5-5')
    assert.equal(defaultVariant.id, 'claude-opus-5-5')
    assert.equal(defaultVariant.name, 'Claude Opus 5.5 · 1M')
    assert.equal(defaultVariant.context.contextWindow, 1_000_000)
    assert.equal(defaultVariant.reasoning.defaultEffort, 'medium')

    const shortId = contextModelId('claude-opus-5-5', '300k')
    const shortVariant = await adapter.resolveModel('cursor', shortId)
    assert.equal(shortVariant.id, shortId)
    assert.equal(shortVariant.name, 'Claude Opus 5.5 · 300K')
    assert.equal(shortVariant.context.contextWindow, 300_000)
  })

  it('uses the configured capacity only when the catalog has no context parameter', async () => {
    const { adapter } = setup()
    const model = await adapter.resolveModel('cursor', 'composer-2.5')
    assert.equal(model.context.contextWindow, 128_000)
  })

  it('passes the complete selected variant to the SDK bridge', async () => {
    const { adapter, selections } = setup()
    const request = {
      provider: 'cursor',
      model: contextModelId('claude-opus-5-5', '300k'),
      reasoningEffort: 'high',
      messages: [],
    }
    for await (const _chunk of adapter.stream(request)) {
      // The fake bridge yields no chunks.
    }
    assert.deepEqual(selections, [{
      id: 'claude-opus-5-5',
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'high' },
      ],
    }])
  })

  it('falls back to the static catalog and configured capacity on a list failure', async () => {
    const { adapter } = setup({ listError: new Error('catalog unavailable') })
    const models = await adapter.listModels('cursor')
    assert.deepEqual(models.map((model) => model.id), ['composer-2.5', 'auto', 'auto-smart'])
    const resolved = await adapter.resolveModel('cursor', 'composer-2.5')
    assert.equal(resolved.context.contextWindow, 128_000)
  })
})
describe('credential source', () => {
  it('reads CURSOR_API_KEY only from the credentials service', async () => {
    const refs = []
    const ctx = {
      get(name) {
        return name === 'credentials'
          ? { async resolve(ref) { refs.push(ref); return { value: ' cursor_test ' } } }
          : undefined
      },
    }
    assert.equal(await resolveApiKey(ctx), 'cursor_test')
    assert.deepEqual(refs, ['CURSOR_API_KEY'])
  })

  it('does not fall back to an environment variable or SDK login file', async () => {
    const previous = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'cursor_from_environment'
    try {
      const ctx = {
        get(name) {
          return name === 'credentials' ? { async resolve() { return undefined } } : undefined
        },
      }
      await assert.rejects(resolveApiKey(ctx), (error) => error.code === 'MISSING_CREDENTIAL')
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = previous
    }
  })

  it('fails clearly when the credentials service is absent', async () => {
    await assert.rejects(
      resolveApiKey({ get: () => undefined }),
      (error) => error.code === 'MISSING_CREDENTIAL',
    )
  })
})
