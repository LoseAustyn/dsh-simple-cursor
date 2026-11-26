/**
 * LLM adapter. Cursor runs are local agents billed to the signed-in account.
 * Call controls the agent API does not accept fail the request.
 */

import { LlmAdapter, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'

import {
  FALLBACK_MODELS, contextOf, contextTokensOf, createCatalog, modelRouteOf, modelSelection, reasoningOf, toModelInfo, toModelInfos,
} from './catalog.js'
import { CREDENTIAL_REF, PROVIDER_NAME, rejectedCallOption } from './config.js'
import { BridgeFailure, failureFromUnknown } from './errors.js'

export class CursorAdapter extends LlmAdapter {
  /**
   * @param {{
   *   bridge: { stream: Function },
   *   contextWindow: () => number,
   *   resolveApiKey: () => Promise<string>,
   *   loadImage: Function,
   *   listModels: (apiKey: string | undefined) => Promise<object[]>,
   * }} dependencies - bridge, live context capacity, and account catalog.
   */
  constructor(dependencies) {
    super()
    this.dependencies = dependencies
    this.catalog = createCatalog({ list: (apiKey) => dependencies.listModels(apiKey) })
    this.warned = false
  }

  /** @param {string} provider - registered route. @returns {{ id: string, name: string }} display metadata. */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * @param {string} provider - registered route.
   * @returns {Promise<object[]>} advertised models. A catalog failure still returns the fallback list.
   */
  async listModels(provider) {
    try {
      const models = await this.catalog.load(await this.dependencies.resolveApiKey())
      return models.flatMap((model) => toModelInfos(provider, model))
    } catch (error) {
      this.warnOnce(error)
      return FALLBACK_MODELS.map((model) => toModelInfo(provider, model))
    }
  }

  /**
   * @param {string} provider - registered route.
   * @param {string} model - model id.
   * @returns {Promise<object>} identity, context capacity, and reasoning efforts when the catalog lists them.
   */
  async resolveModel(provider, model) {
    const route = modelRouteOf(model)
    let found
    try {
      const models = await this.catalog.load(await this.dependencies.resolveApiKey())
      found = models.find((item) => item.id === route.id)
    } catch (error) {
      this.warnOnce(error)
      found = FALLBACK_MODELS.find((item) => item.id === route.id)
    }
    const reasoning = reasoningOf(found)
    const fallback = FALLBACK_MODELS.find((item) => item.id === route.id)
    const context = contextOf(found)
    const contextValue = route.contextValue ?? context?.defaultValue
    const contextLabel = context?.options.find((option) => option.value === contextValue)?.name
    const baseName = found?.displayName || fallback?.displayName || route.id
    return {
      provider,
      id: model,
      name: contextLabel === undefined ? baseName : `${baseName} · ${contextLabel}`,
      ...(typeof found?.description === 'string' && found.description.length > 0 ? { description: found.description } : {}),
      context: { contextWindow: contextTokensOf(contextValue) ?? this.dependencies.contextWindow() },
      ...(reasoning === undefined ? {} : {
        reasoning: {
          efforts: reasoning.efforts,
          defaultEffort: reasoning.defaultEffort,
        },
      }),
    }
  }

  /**
   * @param {object} options - DSH generate options.
   * @returns {AsyncGenerator<object>} stream chunks.
   */
  async *stream(options) {
    const unsupported = rejectedCallOption(options)
    if (unsupported !== undefined) {
      throw new LlmError(
        `dsh-simple-cursor: Cursor agent runs do not accept ${unsupported}`,
        'UNSUPPORTED_OPTION',
      )
    }
    const apiKey = await this.dependencies.resolveApiKey()
    let models
    try {
      models = await this.catalog.load(apiKey)
    } catch (error) {
      this.warnOnce(error)
      if (options.reasoningEffort !== undefined) throw toLlmError(error, true)
      models = undefined
    }
    let selection
    try {
      selection = modelSelection(options.model, options.reasoningEffort, models)
    } catch (error) {
      throw toLlmError(error, true)
    }
    try {
      yield* this.dependencies.bridge.stream(options, {
        apiKey,
        model: selection,
        loadImage: (attachment, signal) => this.dependencies.loadImage(attachment, signal),
      })
    } catch (error) {
      throw toLlmError(error, true)
    }
  }

  /**
   * @param {unknown} error - catalog failure.
   * @returns {void}
   */
  warnOnce(error) {
    if (this.warned) return
    this.warned = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dsh-simple-cursor] model list unavailable: ${message}`)
  }
}

/**
 * @param {unknown} error - bridge, SDK, or harness failure.
 * @param {boolean} hadKey - whether the call passed an API key.
 * @returns {LlmError} harness failure.
 */
function toLlmError(error, hadKey) {
  if (error instanceof LlmError) return error
  const mapped = error instanceof BridgeFailure ? error : failureFromUnknown(error, hadKey)
  const status = typeof mapped.status === 'number' && mapped.status >= 100 && mapped.status <= 599
    ? mapped.status
    : undefined
  return new LlmError(mapped.message, mapped.code, {
    cause: error,
    ...(status === undefined ? {} : { status }),
  })
}

/**
 * Resolve the one supported key source: More → Settings → Cursor writes the
 * value into the DSH credentials service under `CURSOR_API_KEY`. Environment
 * variables, profile configuration, and the SDK login file are deliberately
 * not consulted.
 * @param {object} ctx - host context.
 * @returns {Promise<string>} usable key.
 */
export async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') {
    throw new LlmError(
      'dsh-simple-cursor: the credentials service is unavailable; save the Cursor API key in More → Settings → Cursor',
      'MISSING_CREDENTIAL',
    )
  }
  let hit
  try {
    hit = await credentials.resolve(CREDENTIAL_REF)
  } catch (error) {
    throw new LlmError(
      'dsh-simple-cursor: could not read CURSOR_API_KEY from the credentials service; save it again in More → Settings → Cursor',
      'MISSING_CREDENTIAL',
      { cause: error },
    )
  }
  if (hit === undefined || hit === null || typeof hit.value !== 'string') {
    throw new LlmError(
      'dsh-simple-cursor: CURSOR_API_KEY is not configured; save it in More → Settings → Cursor',
      'MISSING_CREDENTIAL',
    )
  }
  const checked = normalizeApiKey(hit.value)
  if (!checked.ok) {
    throw new LlmError(
      checked.reason === 'empty'
        ? 'dsh-simple-cursor: the saved Cursor API key is blank; save it again in More → Settings → Cursor'
        : 'dsh-simple-cursor: the saved Cursor API key contains characters no HTTP header can carry; save the raw key again in More → Settings → Cursor',
      'INVALID_CREDENTIAL',
    )
  }
  return checked.value
}
