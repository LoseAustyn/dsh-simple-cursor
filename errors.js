/**
 * Failures the bridge and SDK client raise. The adapter turns these into
 * `LlmError` values; this module stays free of the harness package so tests
 * can run without it.
 */

export class BridgeFailure extends Error {
  /**
   * @param {string} message - non-empty failure summary.
   * @param {string} code - harness LLM failure code.
   * @param {{ cause?: unknown, status?: number }} [options] - cause and HTTP status.
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BridgeFailure'
    this.code = code
    this.status = options.status
  }
}

/**
 * @param {string} message - non-empty failure summary.
 * @param {string} code - harness LLM failure code.
 * @param {{ cause?: unknown, status?: number }} [options] - cause and HTTP status.
 * @returns {BridgeFailure} the failure.
 */
export function failure(message, code, options) {
  const text = message.startsWith('dsh-simple-cursor:') ? message : `dsh-simple-cursor: ${message}`
  return new BridgeFailure(text, code, options)
}

/**
 * Map an SDK or transport error onto a harness failure code.
 * The plugin always supplies the saved credentials-store key, so an auth
 * rejection is AUTH rather than a recoverable ambient-login state. The
 * `hadKey` branch remains for lower-level callers and tests.
 * @param {unknown} error - thrown value.
 * @param {boolean} hadKey - whether this call passed an API key.
 * @returns {BridgeFailure} mapped failure. An existing bridge failure is returned unchanged.
 */
export function failureFromUnknown(error, hadKey) {
  if (error instanceof BridgeFailure) return error
  if (error instanceof Error && error.name === 'LlmError' && typeof error.code === 'string' && error.code.length > 0) {
    return new BridgeFailure(error.message, error.code, {
      cause: error,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
    })
  }
  const status = typeof error === 'object' && error !== null && typeof error.status === 'number'
    ? error.status
    : undefined
  const name = typeof error === 'object' && error !== null && typeof error.name === 'string' ? error.name : ''
  const message = error instanceof Error && error.message.length > 0 ? error.message : 'Cursor request failed'
  let code = 'TRANSPORT'
  if (name === 'AbortError' || (error instanceof Error && error.name === 'AbortError')) code = 'ABORTED'
  else if (name === 'AuthenticationError' || status === 401 || status === 403) code = hadKey ? 'AUTH' : 'MISSING_CREDENTIAL'
  else if (name === 'RateLimitError' || status === 429) {
    code = /quota|usage limit/i.test(message) ? 'ACCOUNT_QUOTA' : 'RATE_LIMIT'
  } else if (typeof status === 'number' && status >= 500) code = 'SERVER'
  else if (name === 'ConfigurationError' && /model/i.test(message)) code = 'UNKNOWN_MODEL'
  else if (/context window|context length|too many tokens/i.test(message)) code = 'CONTEXT_WINDOW_EXCEEDED'
  return new BridgeFailure(prefix(message), code, {
    cause: error,
    ...(status === undefined ? {} : { status }),
  })
}

/**
 * @param {string} message - SDK or local message.
 * @returns {string} message that names this plugin when it does not already.
 */
function prefix(message) {
  return message.startsWith('dsh-simple-cursor:') ? message : `dsh-simple-cursor: ${message}`
}
