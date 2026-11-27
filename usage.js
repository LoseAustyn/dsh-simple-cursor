/**
 * Cursor subscription usage for the Settings page.
 *
 * The saved user API key stays on the Host. It is exchanged once per fetch for
 * a short-lived access token, which authorizes the same DashboardService RPC
 * the Cursor client uses. Only normalized percentages, plan metadata, and
 * reset times travel to the browser.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

/** Package version, read from the manifest so the user agent cannot drift. */
const packageVersion = createRequire(import.meta.url)('./package.json').version

/** Host-side exact Fetch route read by the Settings section. */
export const USAGE_ROUTE_PATH = '/api/dsh-simple-cursor/usage'

/** User agent sent to Cursor; carries the package version. */
export const USER_AGENT = `dsh-simple-cursor/${packageVersion}`

const DEFAULT_BASE_URL = 'https://api2.cursor.sh'
const EXCHANGE_PATH = '/auth/exchange_user_api_key'
const CURRENT_PERIOD_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const PLAN_INFO_PATH = '/aiserver.v1.DashboardService/GetPlanInfo'
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CACHE_MS = 30_000

/** A usage lookup failure with a stable code for the Settings UI. */
export class UsageFailure extends Error {
  /**
   * @param {string} message - safe message; never includes a credential.
   * @param {string} code - stable failure code.
   * @param {number | undefined} [status] - upstream HTTP status, when available.
   * @param {number | undefined} [retryAfterSeconds] - suggested retry delay in seconds.
   */
  constructor(message, code, status, retryAfterSeconds) {
    super(message)
    this.name = 'UsageFailure'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * @param {unknown} value - candidate number.
 * @returns {number | undefined} finite number.
 */
function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * @param {unknown} value - millisecond value, numeric string, or date string.
 * @returns {string | undefined} ISO timestamp.
 */
function isoTime(value) {
  const number = finiteNumber(value)
  const date = number === undefined ? new Date(String(value)) : new Date(number)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * @param {unknown} value - Cursor's IncludedUsagePeriod enum.
 * @returns {'monthly' | 'weekly' | undefined} normalized period.
 */
function usagePeriod(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'monthly' || normalized === 'included_usage_period_monthly') return 'monthly'
  if (normalized === 'weekly' || normalized === 'included_usage_period_weekly') return 'weekly'
  return undefined
}

/**
 * @param {unknown} value - candidate string.
 * @returns {string | undefined} trimmed non-empty string.
 */
function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

/**
 * @param {Response} response - upstream response.
 * @returns {Promise<object | undefined>} parsed JSON object.
 */
async function readJson(response) {
  try {
    const body = await response.text()
    if (body.length === 0) return undefined
    const parsed = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {string} baseUrl - Cursor API origin.
 * @param {string} path - request path.
 * @param {object} headers - request headers.
 * @param {typeof fetch} fetchImpl - fetch implementation.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<Response>} upstream response.
 */
async function send(baseUrl, path, headers, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    return await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'user-agent': USER_AGENT,
        ...headers,
      },
      body: '{}',
      signal: combined,
    })
  } catch {
    if (signal?.aborted) throw new UsageFailure('Cursor usage request was cancelled', 'USAGE_TIMEOUT')
    if (timeout.aborted) throw new UsageFailure('Cursor usage request timed out', 'USAGE_TIMEOUT')
    throw new UsageFailure('Could not reach the Cursor usage service', 'USAGE_UNAVAILABLE')
  }
}

/**
 * Exchange a user API key for the short-lived token used by DashboardService.
 * @param {string} apiKey - saved user API key.
 * @param {typeof fetch} fetchImpl - fetch implementation.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<string>} short-lived access token; never returned to the browser.
 */
async function exchangeApiKey(apiKey, fetchImpl, signal) {
  const response = await send(DEFAULT_BASE_URL, EXCHANGE_PATH, {
    authorization: `Bearer ${apiKey}`,
  }, fetchImpl, signal)
  const body = await readJson(response)
  if (!response.ok) {
    throw new UsageFailure(
      response.status === 401 || response.status === 403
        ? 'The saved Cursor API key is not valid'
        : 'Cursor rejected the usage request',
      response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : 'USAGE_UNAVAILABLE',
      response.status,
    )
  }
  const accessToken = nonEmptyString(body?.accessToken)
  if (accessToken === undefined) {
    throw new UsageFailure('Cursor did not return a usage access token', 'USAGE_UNAVAILABLE')
  }
  return accessToken
}

/**
 * @param {string} accessToken - short-lived Cursor access token.
 * @param {string} path - DashboardService method path.
 * @param {typeof fetch} fetchImpl - fetch implementation.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<object | undefined>} parsed RPC response.
 */
async function dashboardCall(accessToken, path, fetchImpl, signal) {
  const response = await send(DEFAULT_BASE_URL, path, {
    authorization: `Bearer ${accessToken}`,
  }, fetchImpl, signal)
  const body = await readJson(response)
  if (!response.ok) {
    throw new UsageFailure(
      response.status === 401 || response.status === 403
        ? 'Cursor rejected the usage credentials'
        : 'Cursor could not return subscription usage',
      response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : 'USAGE_UNAVAILABLE',
      response.status,
    )
  }
  return body
}

/**
 * Turn Cursor's protobuf-JSON response into the small shape the browser needs.
 * @param {object | undefined} usage - GetCurrentPeriodUsage response.
 * @param {object | undefined} plan - GetPlanInfo response.
 * @param {number} nowMs - fetch time.
 * @returns {object} normalized usage snapshot.
 */
export function normalizeUsage(usage, plan, nowMs = Date.now()) {
  const planUsage = usage?.planUsage
  const spendLimit = usage?.spendLimitUsage
  const totalPercent = finiteNumber(planUsage?.totalPercentUsed)
  const autoPercent = finiteNumber(planUsage?.autoPercentUsed)
  const apiPercent = finiteNumber(planUsage?.apiPercentUsed)
  const individualLimit = finiteNumber(spendLimit?.individualLimit)
  const individualUsed = finiteNumber(spendLimit?.individualUsed)
  const overallLimit = finiteNumber(spendLimit?.overallLimit)
  const overallUsed = finiteNumber(spendLimit?.overallUsed)
  const onDemand = individualLimit !== undefined || individualUsed !== undefined
    ? {
        usedCents: individualUsed ?? null,
        limitCents: individualLimit ?? null,
        remainingCents: finiteNumber(spendLimit?.individualRemaining) ?? null,
      }
    : overallLimit !== undefined || overallUsed !== undefined
      ? {
          usedCents: overallUsed ?? null,
          limitCents: overallLimit ?? null,
          remainingCents: finiteNumber(spendLimit?.overallRemaining) ?? null,
        }
      : null
  const info = plan?.planInfo
  return {
    plan: {
      name: nonEmptyString(info?.planName) ?? null,
      price: nonEmptyString(info?.price) ?? null,
      period: usagePeriod(info?.includedUsagePeriod) ?? null,
    },
    billingCycle: {
      start: isoTime(usage?.billingCycleStart) ?? null,
      end: isoTime(usage?.billingCycleEnd) ?? null,
    },
    usage: {
      totalPercent: totalPercent ?? null,
      autoPercent: autoPercent ?? null,
      apiPercent: apiPercent ?? null,
      poolCents: finiteNumber(planUsage?.totalSpend) ?? null,
      includedCents: finiteNumber(planUsage?.includedSpend) ?? null,
      bonusCents: finiteNumber(planUsage?.bonusSpend) ?? null,
      limitCents: finiteNumber(planUsage?.limit) ?? null,
      onDemand,
    },
    fetchedAt: new Date(nowMs).toISOString(),
  }
}

/**
 * Fetch and normalize one usage snapshot.
 * @param {string} apiKey - saved user API key.
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, now?: () => number }} [options] - injection seams.
 * @returns {Promise<object>} normalized usage snapshot.
 */
export async function fetchCursorUsage(apiKey, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const accessToken = await exchangeApiKey(apiKey, fetchImpl, options.signal)
  const [usageResult, planResult] = await Promise.allSettled([
    dashboardCall(accessToken, CURRENT_PERIOD_PATH, fetchImpl, options.signal),
    dashboardCall(accessToken, PLAN_INFO_PATH, fetchImpl, options.signal),
  ])
  if (usageResult.status === 'rejected') throw usageResult.reason
  return normalizeUsage(
    usageResult.value,
    planResult.status === 'fulfilled' ? planResult.value : undefined,
    now(),
  )
}

/**
 * Build a short-lived usage client so opening Settings repeatedly does not
 * hammer Cursor. The cache is keyed by a hash, never by the key itself.
 * Concurrent requests for the same key share one upstream lookup while
 * respecting each caller's abort signal.
 * @param {{ fetch?: typeof fetch, now?: () => number, ttlMs?: number, minRefreshMs?: number }} [options] - injection seams.
 * @returns {{ load: (apiKey: string, signal?: AbortSignal, force?: boolean) => Promise<object> }} cached loader.
 */
export function createUsageClient(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_MS
  const minRefreshMs = options.minRefreshMs ?? 0
  let cached
  let inflight
  let lastForce

  return {
    async load(apiKey, signal, force = false) {
      if (signal?.aborted) {
        throw new UsageFailure('Cursor usage request was cancelled', 'USAGE_TIMEOUT')
      }
      const fingerprint = createHash('sha256').update(apiKey).digest('hex')
      const at = now()
      if (!force && cached !== undefined && cached.fingerprint === fingerprint && at - cached.at < ttlMs) {
        return cached.value
      }

      let active = inflight !== undefined
        && inflight.fingerprint === fingerprint
        && !inflight.controller.signal.aborted
        ? inflight
        : undefined
      if (active === undefined) {
        if (force && minRefreshMs > 0 && lastForce !== undefined
          && lastForce.fingerprint === fingerprint && at - lastForce.at < minRefreshMs) {
          const retryAfterSeconds = Math.max(1, Math.ceil((minRefreshMs - (at - lastForce.at)) / 1000))
          throw new UsageFailure(
            'Please wait before refreshing Cursor usage again',
            'RATE_LIMIT',
            429,
            retryAfterSeconds,
          )
        }
        if (force) lastForce = { fingerprint, at }
        const controller = new AbortController()
        const entry = {
          fingerprint,
          controller,
          callers: 0,
          promise: null,
        }
        entry.promise = fetchCursorUsage(apiKey, { fetch: fetchImpl, signal: controller.signal, now })
          .then((value) => {
            cached = { fingerprint, at: now(), value }
            return value
          })
          .finally(() => {
            if (inflight === entry) inflight = undefined
          })
        inflight = entry
        active = entry
      }

      active.callers += 1
      try {
        if (signal === undefined) return await active.promise
        return await new Promise((resolve, reject) => {
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            active.callers -= 1
            if (active.callers <= 0) {
              if (inflight === active) inflight = undefined
              active.controller.abort()
            }
            reject(new UsageFailure('Cursor usage request was cancelled', 'USAGE_TIMEOUT'))
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          active.promise.then(
            (value) => {
              if (settled) return
              settled = true
              active.callers -= 1
              signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
            (error) => {
              if (settled) return
              settled = true
              active.callers -= 1
              signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
        })
      } finally {
        if (signal === undefined) active.callers -= 1
      }
    },
  }
}
