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
  const usage = createUsageClient()
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: USAGE_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const force = request instanceof Request
          && new URL(request.url, 'http://dsh.local').searchParams.get('refresh') === '1'
        let apiKey
        try {
          apiKey = await resolveApiKey(ctx)
        } catch (error) {
          return usageResponse(error, 400)
        }
        try {
          return Response.json({ ok: true, usage: await usage.load(apiKey, undefined, force) }, {
            headers: { 'cache-control': 'no-store' },
          })
        } catch (error) {
          const status = error instanceof UsageFailure && error.code === 'INVALID_CREDENTIAL' ? 400 : 502
          return usageResponse(error, status)
        }
      },
    }), 'dsh-simple-cursor: subscription usage')
  })
}


/**
 * @param {unknown} error - credential or usage failure.
 * @param {number} status - response status.
 * @returns {Response} safe JSON failure.
 */
function usageResponse(error, status) {
  const known = error instanceof UsageFailure
  const fallbackCode = status === 400 ? 'INVALID_CREDENTIAL' : 'USAGE_UNAVAILABLE'
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : fallbackCode
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : 'Cursor usage lookup failed'
  return Response.json({
    ok: false,
    error: { code, message },
  }, {
    status,
    headers: { 'cache-control': 'no-store' },
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
