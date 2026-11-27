/**
 * Failures the bridge and SDK client raise. The adapter turns these into
 * `LlmError` values; this module stays free of the harness package so tests
 * can run without it.
 */

/**
 * Redact bearer tokens, API key literals, URL query strings/userinfo, and
 * control characters from an error string so upstream payloads do not leak
 * into user-facing diagnostics or logs.
 * @param {unknown} raw - candidate error message.
 * @param {string} [fallback] - replacement when nothing usable remains.
 * @returns {string} bounded safe message.
 */
export function sanitizeErrorMessage(raw, fallback = 'Cursor request failed') {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:cursor|sk)_[A-Za-z0-9._-]{6,}/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}/gi, '[redacted]')
    .replace(/(https?:\/\/)([^/\s@]+@)?([^\s?#]+)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, '$1$3')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (cleaned.length === 0) return fallback
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned
}

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
  const rawMessage = error instanceof Error && error.message.length > 0 ? error.message : 'Cursor request failed'
  const message = sanitizeErrorMessage(rawMessage, 'Cursor request failed')
  let code = 'TRANSPORT'
  if (name === 'AbortError' || (error instanceof Error && error.name === 'AbortError')) code = 'ABORTED'
  else if (name === 'AuthenticationError' || status === 401 || status === 403) code = hadKey ? 'AUTH' : 'MISSING_CREDENTIAL'
  else if (name === 'RateLimitError' || status === 429) {
    code = /quota|usage limit/i.test(rawMessage) ? 'ACCOUNT_QUOTA' : 'RATE_LIMIT'
  } else if (typeof status === 'number' && status >= 500) code = 'SERVER'
  else if (name === 'ConfigurationError' && /model/i.test(rawMessage)) code = 'UNKNOWN_MODEL'
  else if (/context window|context length|too many tokens/i.test(rawMessage)) code = 'CONTEXT_WINDOW_EXCEEDED'
  const safeMessage = code === 'MISSING_CREDENTIAL'
    ? 'dsh-simple-cursor: Cursor API key is missing; save it in More → Settings → Cursor'
    : code === 'AUTH'
      ? 'dsh-simple-cursor: Cursor rejected the saved API key; save a valid key in More → Settings → Cursor'
      : prefix(message)
  return new BridgeFailure(safeMessage, code, {
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
