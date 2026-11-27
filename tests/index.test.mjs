import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from '../index.js'
import { USAGE_ROUTE_PATH } from '../usage.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mount(credentials) {
  let route
  const injected = []
  const ctx = {
    get(name) {
      return name === 'credentials' ? credentials : undefined
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    llm: {
      registerAdapter() {
        return () => {}
      },
    },
    inject(names, callback) {
      injected.push([...names])
      callback({
        ...ctx,
        connection: {
          fetch: {
            register(value) {
              route = value
              return () => {}
            },
          },
        },
      })
    },
  }
  apply(ctx, {})
  return { route, injected }
}

describe('host usage route', () => {
  it('registers one authenticated GET route through connection.fetch', () => {
    const { route, injected } = mount({ async resolve() { return undefined } })
    assert.deepEqual(injected, [['connection']])
    assert.equal(route.path, USAGE_ROUTE_PATH)
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  })

  it('returns normalized usage without exposing the saved key or access token', async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/auth/exchange_user_api_key')) {
        return json({ accessToken: 'access_test' })
      }
      if (String(url).endsWith('/GetCurrentPeriodUsage')) {
        return json({
          billingCycleEnd: '1796694197000',
          planUsage: { totalPercentUsed: 7.25, autoPercentUsed: 7.3, apiPercentUsed: 6.4 },
        })
      }
      return json({
        planInfo: {
          planName: 'Pro',
          price: '$20/mo',
          includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY',
        },
      })
    }
    try {
      const { route } = mount({
        async resolve(ref) {
          assert.equal(ref, 'CURSOR_API_KEY')
          return { value: 'cursor_test' }
        },
      })
      const response = await route.fetch()
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.usage.plan.name, 'Pro')
      assert.equal(body.usage.usage.totalPercent, 7.25)
      const text = JSON.stringify(body)
      assert.equal(text.includes('cursor_test'), false)
      assert.equal(text.includes('access_test'), false)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    } finally {
      globalThis.fetch = previous
    }
  })

  it('reports a missing saved key without falling back to ambient sources', async () => {
    const previous = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'cursor_environment'
    try {
      const { route } = mount({ async resolve() { return undefined } })
      const response = await route.fetch()
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'MISSING_CREDENTIAL')
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = previous
    }
  })

  it('propagates request cancellation, rate-limits rapid refresh=1, and hides unexpected error details', async () => {
    const previousFetch = globalThis.fetch
    let observedSignal
    let upstreamCalls = 0
    globalThis.fetch = async (url, init) => {
      upstreamCalls += 1
      observedSignal = init.signal
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (String(url).endsWith('/auth/exchange_user_api_key')) {
        return json({ accessToken: 'access_test' })
      }
      if (String(url).endsWith('/GetCurrentPeriodUsage')) {
        return json({ billingCycleEnd: '1796694197000', planUsage: { totalPercentUsed: 12 } })
      }
      return json({ planInfo: { planName: 'Pro' } })
    }
    try {
      const { route } = mount({ async resolve() { return { value: 'cursor_test' } } })

      const abortedController = new AbortController()
      abortedController.abort()
      const cancelled = await route.fetch(new Request('http://dsh.local/api/dsh-simple-cursor/usage', {
        signal: abortedController.signal,
      }))
      assert.equal(cancelled.status, 502)
      const cancelledBody = await cancelled.json()
      assert.equal(cancelledBody.error.code, 'USAGE_TIMEOUT')
      assert.equal(upstreamCalls, 0)

      const firstRefresh = await route.fetch(new Request('http://dsh.local/api/dsh-simple-cursor/usage?refresh=1'))
      assert.equal(firstRefresh.status, 200)
      assert.equal(observedSignal instanceof AbortSignal, true)
      assert.equal(upstreamCalls, 3)

      const secondRefresh = await route.fetch(new Request('http://dsh.local/api/dsh-simple-cursor/usage?refresh=1'))
      assert.equal(secondRefresh.status, 429)
      assert.equal(Number(secondRefresh.headers.get('retry-after')) >= 1, true)
      const limitedBody = await secondRefresh.json()
      assert.equal(limitedBody.error.code, 'RATE_LIMIT')
      assert.equal(upstreamCalls, 3)

      const { route: brokenRoute } = mount({
        async resolve() {
          throw Object.assign(new Error('raw internal secret_leak'), { code: 'INTERNAL_LEAK' })
        },
      })
      const failed = await brokenRoute.fetch()
      assert.equal(failed.status, 400)
      const failedBody = await failed.json()
      assert.equal(failedBody.error.code, 'MISSING_CREDENTIAL')
      assert.equal(JSON.stringify(failedBody).includes('secret_leak'), false)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('warns on startup when CURSOR_BACKEND_URL overrides the backend to localhost', () => {
    const previousUrl = process.env.CURSOR_BACKEND_URL
    const previousWarn = console.warn
    const warnings = []
    process.env.CURSOR_BACKEND_URL = 'http://localhost:8080'
    console.warn = (msg) => warnings.push(String(msg))
    try {
      mount({ async resolve() { return undefined } })
      assert.equal(warnings.some((item) => item.includes('CURSOR_BACKEND_URL') && item.includes('TLS')), true)
    } finally {
      console.warn = previousWarn
      if (previousUrl === undefined) delete process.env.CURSOR_BACKEND_URL
      else process.env.CURSOR_BACKEND_URL = previousUrl
    }
  })
})
