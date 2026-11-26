/**
 * Plugin configuration for the Cursor model provider.
 * The API key is intentionally absent: the only supported source is the DSH
 * credentials store written from More → Settings → Cursor.
 */

import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

/** Provider route registered with `ctx.llm`. */
export const PROVIDER = 'cursor'

/** Label shown in the model selector. */
export const PROVIDER_NAME = 'Cursor'

/** Credential reference written by More → Settings → Cursor. */
export const CREDENTIAL_REF = 'CURSOR_API_KEY'

const KEYS = new Set(['cwd', 'contextWindow'])

/**
 * Fallback context capacity for models whose Cursor catalog row does not
 * expose a `context` parameter. DSH refuses pressure compaction for a route
 * that reports no capacity, so unknown routes keep a conservative default.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Name a call control the Cursor agent API cannot apply.
 * @param {object} options - DSH generate options.
 * @returns {string | undefined} the unsupported field name.
 */
export function unsupportedCallOption(options) {
  if (options?.temperature !== undefined) return 'temperature'
  if (options?.maxTokens !== undefined) return 'maxTokens'
  if (Array.isArray(options?.stop) && options.stop.length > 0) return 'stop'
  return undefined
}

/**
 * Whether this request is an auxiliary one (title, compaction, review) rather
 * than a conversation turn. DSH always sets `maxTokens` on compaction and
 * session-title requests, so refusing those knobs would break both features;
 * an auxiliary call accepts the Cursor defaults instead.
 * @param {object} options - DSH generate options.
 * @returns {boolean} whether the request names a purpose.
 */
export function isAuxiliaryRequest(options) {
  return options?.purpose !== undefined && options.purpose !== ''
}

/**
 * The call control that fails this request, if any.
 * Auxiliary calls carry controls the harness sets itself, so they run with the
 * agent defaults instead of failing; a conversation turn still fails on a
 * control its agent config chose, because silently dropping it would be worse.
 * @param {object} options - DSH generate options.
 * @returns {string | undefined} the rejected field name.
 */
export function rejectedCallOption(options) {
  return isAuxiliaryRequest(options) ? undefined : unsupportedCallOption(options)
}

/**
 * Directory a local Cursor agent uses when config sets no `cwd`.
 * Built-in Cursor tools stay off, so this directory only holds agent state.
 * @returns {string} absolute directory under the system temp dir.
 */
export function defaultCwd() {
  return nodePath.join(os.tmpdir(), 'dsh-simple-cursor')
}

/**
 * Read the effective context capacity, live when the schema declares it
 * volatile. The Models settings page edits that field, so a reader that
 * cached the apply-time value would ignore the setting.
 * @param {object} config - raw or Cordis-resolved plugin config.
 * @returns {number} positive token capacity.
 */
export function contextWindowOf(config) {
  const raw = config === null || typeof config !== 'object' ? undefined : config.contextWindow
  const value = typeof raw?.get === 'function' ? raw.get() : raw
  if (value === undefined || value === null) return DEFAULT_CONTEXT_WINDOW
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('dsh-simple-cursor: contextWindow must be a positive integer')
  }
  return value
}

/**
 * Validate the plugin config object.
 * @param {unknown} config - raw plugin config, or undefined when the patch sets none.
 * @returns {{
 *   cwd: string | undefined,
 *   contextWindow: number,
 * }} resolved config.
 */
export function resolveConfig(config) {
  if (config === undefined) config = {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('dsh-simple-cursor: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!KEYS.has(key)) throw new Error(`dsh-simple-cursor: unknown config field "${key}"`)
  }
  const cwd = optionalString(config, 'cwd')
  const contextWindow = contextWindowOf(config)
  if (cwd !== undefined) {
    if (!nodePath.isAbsolute(cwd)) throw new Error('dsh-simple-cursor: cwd must be an absolute path')
    let stat
    try {
      stat = fs.statSync(cwd)
    } catch {
      throw new Error(`dsh-simple-cursor: cwd does not exist: ${cwd}`)
    }
    if (!stat.isDirectory()) throw new Error(`dsh-simple-cursor: cwd is not a directory: ${cwd}`)
  }
  return { cwd, contextWindow }
}

/**
 * @param {object} config - config object.
 * @param {string} key - field name.
 * @returns {string | undefined} a trimmed string, or undefined when the field is absent.
 */
function optionalString(config, key) {
  if (!Object.hasOwn(config, key) || config[key] === undefined) return undefined
  if (typeof config[key] !== 'string') throw new Error(`dsh-simple-cursor: ${key} must be a string`)
  const value = config[key].trim()
  return value.length === 0 ? undefined : value
}
