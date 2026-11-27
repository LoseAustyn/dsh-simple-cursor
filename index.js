/**
 * Cursor subscription provider. Registers the `cursor` model route and
 * releases local agents when the plugin unloads.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

import { CursorAdapter, resolveApiKey } from './adapter.js'
import { createBridge } from './bridge.js'
import { PROVIDER, contextWindowOf, defaultCwd, resolveConfig } from './config.js'
import { Config } from './schema.js'
import { createSdkClient } from './sdk.js'
import { createUsageClient, USAGE_ROUTE_PATH, UsageFailure } from './usage.js'

/** Cordis Config schema; the Settings page derives its Cursor namespace from it. */
export { Config }
export const name = 'simple-cursor'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {unknown} config - plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  warnUnsafeBackendEnv()
  const options = resolveConfig(config)
  const sdk = createSdkClient()
  const bridge = createBridge({
    client: sdk,
    cwd: options.cwd ?? defaultCwd(),
  })
  const adapter = new CursorAdapter({
    bridge,
    // Read live: the Models settings page edits this volatile field, so the
    // apply-time value would ignore what the user just saved.
    contextWindow: () => contextWindowOf(config),
    resolveApiKey: () => resolveApiKey(ctx),
    listModels: (apiKey) => sdk.listModels(apiKey),
    loadImage: (attachment, signal) => loadImage(ctx, attachment, signal),
  })
  // The API key is not read here: the Settings section (client.js) writes it
  // into the credentials service, and `resolveApiKey` reads that per request.
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    return () => {
      registration()
      return bridge.dispose()
    }
  })

  // Subscription usage is fetched on the Host, authenticated with the key from
  // the credentials store. The browser gets only normalized plan and meter
  // fields through the existing authenticated DSH API transport.
  const usage = createUsageClient({ minRefreshMs: 3_000 })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: USAGE_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const force = request instanceof Request
          && new URL(request.url, 'http://dsh.local').searchParams.get('refresh') === '1'
        const signal = request instanceof Request ? request.signal : undefined
        let apiKey
        try {
          apiKey = await resolveApiKey(ctx)
        } catch (error) {
          return usageResponse(error, 400)
        }
        try {
          return Response.json({ ok: true, usage: await usage.load(apiKey, signal, force) }, {
            headers: { 'cache-control': 'no-store' },
          })
        } catch (error) {
          if (error instanceof UsageFailure) {
            const status = error.code === 'INVALID_CREDENTIAL'
              ? 400
              : error.code === 'RATE_LIMIT'
                ? 429
                : 502
            const headers = error.retryAfterSeconds !== undefined
              ? { 'retry-after': String(error.retryAfterSeconds) }
              : undefined
            return usageResponse(error, status, headers)
          }
          return usageResponse(error, 502)
        }
      },
    }), 'dsh-simple-cursor: subscription usage')
  })
}

/**
 * Warn once at startup if `CURSOR_BACKEND_URL` is set, especially when pointing
 * at localhost/non-HTTPS because `@cursor/sdk` sets `NODE_TLS_REJECT_UNAUTHORIZED="0"`
 * globally for the entire Node process on localhost backend URLs.
 * @returns {void}
 */
function warnUnsafeBackendEnv() {
  const raw = process.env.CURSOR_BACKEND_URL
  if (typeof raw !== 'string' || raw.trim().length === 0) return
  let localOrInsecure = false
  try {
    const parsed = new URL(raw.trim())
    const host = parsed.hostname.toLowerCase()
    localOrInsecure = parsed.protocol !== 'https:'
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === '[::1]'
      || host === '::1'
  } catch {
    localOrInsecure = true
  }
  if (localOrInsecure) {
    console.warn('[dsh-simple-cursor] CURSOR_BACKEND_URL points to a local or non-HTTPS endpoint; @cursor/sdk disables process-wide TLS verification for localhost URLs')
  } else {
    console.warn('[dsh-simple-cursor] CURSOR_BACKEND_URL is set; Cursor requests will target the overridden backend')
  }
}

/**
 * @param {unknown} error - credential or usage failure.
 * @param {number} status - response status.
 * @param {Record<string, string>} [extraHeaders] - optional response headers.
 * @returns {Response} safe JSON failure.
 */
function usageResponse(error, status, extraHeaders) {
  const known = error instanceof UsageFailure
    || (error instanceof LlmError && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL'))
  const fallbackCode = status === 400
    ? 'INVALID_CREDENTIAL'
    : status === 429
      ? 'RATE_LIMIT'
      : 'USAGE_UNAVAILABLE'
  const code = known && typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : fallbackCode
  const message = known && error.message.length > 0
    ? error.message
    : 'Cursor usage lookup failed'
  return Response.json({
    ok: false,
    error: { code, message },
  }, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}
/**
 * @param {object} ctx - host context.
 * @param {object} attachment - image attachment reference.
 * @param {AbortSignal | undefined} signal - request cancellation.
 * @returns {Promise<{ data: string, mimeType: string, dimension?: { width: number, height: number } }>} SDK image.
 */
async function loadImage(ctx, attachment, signal) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || attachments === null || typeof attachments.readImage !== 'function') {
    throw new LlmError(
      'dsh-simple-cursor: this request includes an image, but the attachments service is not available',
      'UNSUPPORTED_CONTENT',
    )
  }
  const stored = await attachments.readImage(attachment, signal)
  return {
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: attachment.mediaType,
    ...(typeof attachment.width === 'number' && typeof attachment.height === 'number'
      ? { dimension: { width: attachment.width, height: attachment.height } }
      : {}),
  }
}
