import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { createUsageClient, fetchCursorUsage, normalizeUsage, UsageFailure, USER_AGENT } from '../usage.js'

const { version } = createRequire(import.meta.url)('../package.json')

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fixture() {
  const calls = []
  const request = async (url, init) => {
    calls.push({ url: String(url), init })
    assert.equal(init.headers['user-agent'], USER_AGENT)
    if (String(url).endsWith('/auth/exchange_user_api_key')) {
      assert.equal(init.headers.authorization, 'Bearer cursor_test')
      return json({ accessToken: 'access_test', refreshToken: 'refresh_test' })
    }
    assert.equal(init.headers.authorization, 'Bearer access_test')
    if (String(url).endsWith('/GetCurrentPeriodUsage')) {
      return json({
        billingCycleStart: '1794102197000',
        billingCycleEnd: '1796694197000',
        planUsage: {
          totalSpend: 3586,
          includedSpend: 2000,
          bonusSpend: 1586,
          limit: 2000,
          autoPercentUsed: 7.326666666666666,
          apiPercentUsed: 6.4222222222222225,
          totalPercentUsed: 7.244444444444445,
        },
        spendLimitUsage: {
          individualLimit: 5000,
          individualUsed: 1250,
          individualRemaining: 3750,
          limitType: 'user',
        },
      })
    }
    if (String(url).endsWith('/GetPlanInfo')) {
      return json({
        planInfo: {
          planName: 'Pro',
          price: '$20/mo',
          includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY',
        },
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  return { calls, request }
}

describe('subscription usage', () => {
  it('reports the package version in its user agent', () => {
    assert.equal(USER_AGENT, `dsh-simple-cursor/${version}`)
  })

  it('exchanges the saved key and normalizes plan, meters, and reset data', async () => {
    const { calls, request } = fixture()
    const now = Date.parse('2026-11-25T00:00:00.000Z')
    const usage = await fetchCursorUsage('cursor_test', { fetch: request, now: () => now })

    assert.equal(calls.length, 3)
    assert.deepEqual(usage, {
      plan: { name: 'Pro', price: '$20/mo', period: 'monthly' },
      billingCycle: {
        start: '2026-11-08T01:43:17.000Z',
        end: '2026-12-08T01:43:17.000Z',
      },
      usage: {
        totalPercent: 7.244444444444445,
        autoPercent: 7.326666666666666,
        apiPercent: 6.4222222222222225,
        poolCents: 3586,
        includedCents: 2000,
        bonusCents: 1586,
        limitCents: 2000,
        onDemand: {
          usedCents: 1250,
          limitCents: 5000,
          remainingCents: 3750,
        },
      },
      fetchedAt: '2026-11-25T00:00:00.000Z',
    })
    const serialized = JSON.stringify(usage)
    assert.equal(serialized.includes('cursor_test'), false)
    assert.equal(serialized.includes('access_test'), false)
  })

  it('keeps usage when plan metadata is unavailable', async () => {
    const request = async (url, init) => {
      if (String(url).endsWith('/auth/exchange_user_api_key')) return json({ accessToken: 'access_test' })
      if (String(url).endsWith('/GetCurrentPeriodUsage')) {
        return json({ billingCycleEnd: '1796694197000', planUsage: { totalPercentUsed: 42 } })
      }
      return json({ message: 'plan unavailable' }, 500)
    }
    const usage = await fetchCursorUsage('cursor_test', { fetch: request })
    assert.equal(usage.plan.name, null)
    assert.equal(usage.usage.totalPercent, 42)
    assert.equal(usage.billingCycle.end, '2026-12-08T01:43:17.000Z')
  })

  it('maps an invalid saved key to INVALID_CREDENTIAL', async () => {
    const request = async () => json({ error: 'invalid key' }, 401)
    await assert.rejects(
      fetchCursorUsage('cursor_test', { fetch: request }),
      (error) => error instanceof UsageFailure && error.code === 'INVALID_CREDENTIAL',
    )
  })

  it('maps a forbidden exchange to INVALID_CREDENTIAL', async () => {
    const request = async () => json({ error: 'forbidden' }, 403)
    await assert.rejects(
      fetchCursorUsage('cursor_test', { fetch: request }),
      (error) => error instanceof UsageFailure
        && error.code === 'INVALID_CREDENTIAL'
        && error.status === 403,
    )
  })

  it('maps a rejected DashboardService call to INVALID_CREDENTIAL', async () => {
    for (const status of [401, 403]) {
      const request = async (url) => {
        if (String(url).endsWith('/auth/exchange_user_api_key')) return json({ accessToken: 'access_test' })
        return json({ error: 'denied' }, status)
      }
      await assert.rejects(
        fetchCursorUsage('cursor_test', { fetch: request }),
        (error) => error instanceof UsageFailure
          && error.code === 'INVALID_CREDENTIAL'
          && error.status === status,
      )
    }
  })

  it('caches a successful snapshot for the configured ttl', async () => {
    const { calls, request } = fixture()
    let now = 1000
    const client = createUsageClient({ fetch: request, now: () => now, ttlMs: 5000 })
    await client.load('cursor_test')
    assert.equal(calls.length, 3)
    await client.load('cursor_test')
    assert.equal(calls.length, 3)
    await client.load('cursor_test', undefined, true)
    assert.equal(calls.length, 6)
    now = 7000
    await client.load('cursor_test')
    assert.equal(calls.length, 9)
  })

  it('normalizes only safe primitive fields', () => {
    const result = normalizeUsage({
      billingCycleEnd: '1796694197000',
      planUsage: { autoPercentUsed: 1.5, totalSpend: 2000 },
    }, undefined, 0)
    assert.equal(result.usage.autoPercent, 1.5)
    assert.equal(result.usage.totalPercent, null)
    assert.equal(result.plan.name, null)
    assert.equal(result.fetchedAt, '1970-01-01T00:00:00.000Z')
  })

  it('deduplicates concurrent in-flight usage lookups and respects caller abort signals', async () => {
    let exchangeCalls = 0
    let releaseExchange
    const gate = new Promise((resolve) => { releaseExchange = resolve })
    const request = async (url, init) => {
      if (String(url).endsWith('/auth/exchange_user_api_key')) {
        exchangeCalls += 1
        await gate
        if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return json({ accessToken: 'access_test' })
      }
      if (String(url).endsWith('/GetCurrentPeriodUsage')) {
        return json({ billingCycleEnd: '1796694197000', planUsage: { totalPercentUsed: 10 } })
      }
      return json({ planInfo: { planName: 'Pro' } })
    }
    const client = createUsageClient({ fetch: request, minRefreshMs: 3000 })
    const c1 = new AbortController()
    const c2 = new AbortController()
    const p1 = client.load('cursor_test', c1.signal)
    const p2 = client.load('cursor_test', c2.signal)
    assert.equal(exchangeCalls, 1)

    c1.abort()
    await assert.rejects(p1, (error) => error instanceof UsageFailure && error.code === 'USAGE_TIMEOUT')
    releaseExchange()
    const usage = await p2
    assert.equal(usage.usage.totalPercent, 10)
    assert.equal(exchangeCalls, 1)
  })

  it('enforces a minimum interval between forced refreshes', async () => {
    const { calls, request } = fixture()
    let now = 1000
    const client = createUsageClient({ fetch: request, now: () => now, minRefreshMs: 3000 })
    await client.load('cursor_test', undefined, true)
    assert.equal(calls.length, 3)

    now = 2500
    await assert.rejects(
      client.load('cursor_test', undefined, true),
      (error) => error instanceof UsageFailure
        && error.code === 'RATE_LIMIT'
        && error.status === 429
        && error.retryAfterSeconds === 2,
    )
    assert.equal(calls.length, 3)

    now = 4500
    await client.load('cursor_test', undefined, true)
    assert.equal(calls.length, 6)
  })
})
