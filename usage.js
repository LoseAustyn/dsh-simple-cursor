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
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'UsageFailure'
    this.code = code
    this.status = status
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
  } catch (error) {
    if (combined.aborted) throw new UsageFailure('Cursor usage request timed out or was cancelled', 'USAGE_TIMEOUT')
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
 * @param {{ fetch?: typeof fetch, now?: () => number, ttlMs?: number }} [options] - injection seams.
 * @returns {{ load: (apiKey: string, signal?: AbortSignal) => Promise<object> }} cached loader.
 */
export function createUsageClient(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_MS
  let cached

  return {
    async load(apiKey, signal, force = false) {
      const fingerprint = createHash('sha256').update(apiKey).digest('hex')
      const at = now()
      if (!force && cached !== undefined && cached.fingerprint === fingerprint && at - cached.at < ttlMs) {
        return cached.value
      }
      const value = await fetchCursorUsage(apiKey, { fetch: fetchImpl, signal, now })
      cached = { fingerprint, at: now(), value }
      return value
    },
  }
}
