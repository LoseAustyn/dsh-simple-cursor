import { failure } from './errors.js'

/**
 * Account model catalog. A successful list is reused for one minute.
 * Parameter ids that select reasoning effort are exposed to the DSH selector;
 * a model-level `context` parameter is expanded into one selectable entry per
 * context size. Other Cursor parameters stay on the catalog variant defaults.
 */

/** Parameter ids treated as the model's selectable reasoning effort. */
export const REASONING_PARAMETER_IDS = new Set(['reasoning', 'reasoning_effort', 'effort', 'thinking'])

/** Cursor's catalog parameter that selects a model's context size. */
export const CONTEXT_PARAMETER_ID = 'context'

/** Separator used only in DSH model ids that select a non-default context. */
const CONTEXT_ROUTE_SEPARATOR = '::context='

/** Models advertised when the live catalog cannot be loaded. */
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'composer-2.5', displayName: 'Composer 2.5' }),
  Object.freeze({ id: 'auto', displayName: 'Auto' }),
  Object.freeze({ id: 'auto-smart', displayName: 'Auto' }),
])

/**
 * @typedef {{ value: string, name: string }} ContextOption
 * @typedef {{ parameterId: string, options: ContextOption[], defaultValue: string }} ModelContext
 */

/**
 * @param {object | undefined} model - one catalog row.
 * @returns {object | undefined} the catalog's default variant.
 */
function defaultVariantOf(model) {
  if (!Array.isArray(model?.variants)) return undefined
  return model.variants.find((variant) => variant?.isDefault === true)
}

/**
 * @param {object | undefined} variant - catalog variant.
 * @param {string | undefined} parameterId - parameter to read.
 * @returns {string | undefined} string value carried by the variant.
 */
function parameterValueOfVariant(variant, parameterId) {
  if (parameterId === undefined || !Array.isArray(variant?.params)) return undefined
  const parameter = variant.params.find((item) => item?.id === parameterId && typeof item.value === 'string')
  return parameter?.value
}

/**
 * @param {object | undefined} variant - catalog variant.
 * @param {string | undefined} parameterId - parameter id.
 * @param {string} value - expected value.
 * @returns {boolean} whether a variant carries the exact parameter value.
 */
function variantHasParameter(variant, parameterId, value) {
  return parameterId !== undefined && parameterValueOfVariant(variant, parameterId) === value
}

/**
 * @param {object[] | undefined} params - SDK model parameters.
 * @returns {{ id: string, value: string }[]} detached parameter list.
 */
function cloneParams(params) {
  if (!Array.isArray(params)) return []
  return params
    .filter((parameter) => typeof parameter?.id === 'string' && typeof parameter.value === 'string')
    .map((parameter) => ({ id: parameter.id, value: parameter.value }))
}

/**
 * @param {object[]} params - mutable parameter list.
 * @param {string} id - parameter id.
 * @param {string} value - parameter value.
 * @returns {void}
 */
function setParam(params, id, value) {
  const existing = params.find((parameter) => parameter.id === id)
  if (existing === undefined) params.push({ id, value })
  else existing.value = value
}

/**
 * @param {object | undefined} model - one catalog row.
 * @returns {string} selector base name.
 */
function baseNameOf(model) {
  return typeof model?.displayName === 'string' && model.displayName.length > 0 ? model.displayName : model?.id
}

/**
 * @param {string} provider - registered provider route.
 * @param {{ id: string, displayName?: string, description?: string }} model - catalog or fallback row.
 * @returns {object} selector model entry with the plain model id.
 */
export function toModelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: baseNameOf(model),
    ...(typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {}),
  }
}

/**
 * Expand a catalog row into one selector entry per advertised context size.
 * The catalog's default context keeps the plain model id; alternatives get an
 * opaque suffix that `modelSelection()` maps back to the SDK model selection.
 * @param {string} provider - registered provider route.
 * @param {object} model - catalog row.
 * @returns {object[]} selector model entries.
 */
export function toModelInfos(provider, model) {
  const context = contextOf(model)
  if (context === undefined) return [toModelInfo(provider, model)]
  const ordered = [
    ...context.options.filter((option) => option.value === context.defaultValue),
    ...context.options.filter((option) => option.value !== context.defaultValue),
  ]
  return ordered.map((option) => ({
    provider,
    id: option.value === context.defaultValue ? model.id : contextModelId(model.id, option.value),
    name: `${baseNameOf(model)} · ${option.name}`,
    ...(typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {}),
  }))
}

/**
 * Read the context parameter and its selectable values from one model row.
 * @param {object | undefined} model - one catalog row.
 * @returns {ModelContext | undefined} context options, or undefined when the model does not expose one.
 */
export function contextOf(model) {
  const parameter = Array.isArray(model?.parameters)
    ? model.parameters.find((item) => item?.id === CONTEXT_PARAMETER_ID)
    : undefined
  if (parameter === undefined || !Array.isArray(parameter.values)) return undefined
  /** @type {ContextOption[]} */
  const options = []
  const seen = new Set()
  for (const item of parameter.values) {
    if (typeof item?.value !== 'string' || item.value.length === 0 || seen.has(item.value)) continue
    seen.add(item.value)
    options.push({
      value: item.value,
      name: typeof item.displayName === 'string' && item.displayName.length > 0 ? item.displayName : item.value,
    })
  }
  if (options.length === 0) return undefined
  const preferred = parameterValueOfVariant(defaultVariantOf(model), parameter.id)
  return {
    parameterId: parameter.id,
    options,
    defaultValue: options.some((option) => option.value === preferred) ? preferred : options[0].value,
  }
}

/**
 * Convert a Cursor context label (`300k`, `1m`, ...) to tokens.
 * @param {unknown} value - catalog context value.
 * @returns {number | undefined} positive token count, or undefined when unrecognized.
 */
export function contextTokensOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const tokens = Number(text)
    return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
  }
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])$/.exec(text)
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const factor = match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000
  const tokens = Math.round(amount * factor)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

/**
 * Build the synthetic DSH model id for one non-default context size.
 * @param {string} modelId - Cursor model id.
 * @param {string} contextValue - Cursor catalog context value.
 * @returns {string} DSH selector id.
 */
export function contextModelId(modelId, contextValue) {
  return `${modelId}${CONTEXT_ROUTE_SEPARATOR}${encodeURIComponent(contextValue)}`
}

/**
 * Split a DSH selector id into its Cursor model id and optional context value.
 * Plain ids pass through unchanged so existing saved selections keep working.
 * @param {string} modelId - DSH selector id.
 * @returns {{ id: string, contextValue: string | undefined }} parsed route.
 */
export function modelRouteOf(modelId) {
  const text = String(modelId)
  const at = text.lastIndexOf(CONTEXT_ROUTE_SEPARATOR)
  if (at <= 0) return { id: text, contextValue: undefined }
  const encoded = text.slice(at + CONTEXT_ROUTE_SEPARATOR.length)
  if (encoded.length === 0) return { id: text, contextValue: undefined }
  let contextValue = encoded
  try {
    contextValue = decodeURIComponent(encoded)
  } catch {
    // Keep the literal suffix; modelSelection() will reject it if invalid.
  }
  return { id: text.slice(0, at), contextValue }
}

/**
 * @param {object | undefined} model - one catalog row.
 * @returns {{ parameterId: string, efforts: { id: string, name: string }[], defaultEffort: string } | undefined}
 *   selectable efforts, when this model exposes one of the known parameters.
 */
export function reasoningOf(model) {
  const parameter = Array.isArray(model?.parameters)
    ? model.parameters.find((item) => REASONING_PARAMETER_IDS.has(item?.id))
    : undefined
  if (parameter === undefined || !Array.isArray(parameter.values) || parameter.values.length === 0) return undefined
  const efforts = parameter.values
    .filter((value) => typeof value?.value === 'string' && value.value.length > 0)
    .map((value) => ({
      id: value.value,
      name: typeof value.displayName === 'string' && value.displayName.length > 0 ? value.displayName : value.value,
    }))
  if (efforts.length === 0) return undefined
  const preferred = parameterValueOfVariant(defaultVariantOf(model), parameter.id)
  return {
    parameterId: parameter.id,
    efforts,
    defaultEffort: efforts.some((effort) => effort.id === preferred) ? preferred : efforts[0].id,
  }
}

/**
 * @param {object | undefined} model - catalog row.
 * @returns {object[]} variants with usable parameter arrays.
 */
function variantsOf(model) {
  if (!Array.isArray(model?.variants)) return []
  return model.variants.filter((variant) => Array.isArray(variant?.params))
}

/**
 * Pick the catalog variant that matches the requested context and effort.
 * Without an explicit effort, preserve the default variant's effort when the
 * selected context has a variant for it.
 * @param {object} model - catalog row.
 * @param {string | undefined} contextParameterId - context parameter id.
 * @param {string | undefined} contextValue - requested context value.
 * @param {string | undefined} reasoningParameterId - reasoning parameter id.
 * @param {string | undefined} effort - requested effort.
 * @returns {object | undefined} exact matching variant.
 */
function matchingVariant(model, contextParameterId, contextValue, reasoningParameterId, effort) {
  let candidates = variantsOf(model)
  if (contextParameterId !== undefined && contextValue !== undefined) {
    candidates = candidates.filter((variant) => variantHasParameter(variant, contextParameterId, contextValue))
  }
  if (reasoningParameterId !== undefined && effort !== undefined) {
    candidates = candidates.filter((variant) => (
      variantHasParameter(variant, reasoningParameterId, effort)
    ))
  } else {
    const preferredEffort = parameterValueOfVariant(defaultVariantOf(model), reasoningParameterId)
    if (reasoningParameterId !== undefined && preferredEffort !== undefined) {
      const withEffort = candidates.filter((variant) => (
        variantHasParameter(variant, reasoningParameterId, preferredEffort)
      ))
      if (withEffort.length > 0) candidates = withEffort
    }
  }
  if (candidates.length === 0) return undefined
  return candidates.find((variant) => variant.isDefault === true) ?? candidates[0]
}

/**
 * @param {object | undefined} model - catalog row.
 * @param {string | undefined} contextParameterId - context parameter id.
 * @param {string | undefined} contextValue - selected context value.
 * @returns {boolean} whether every matching context variant requires Max Mode.
 */
function contextRequiresMaxMode(model, contextParameterId, contextValue) {
  if (contextParameterId === undefined || contextValue === undefined) return false
  const matching = variantsOf(model).filter((variant) => (
    variantHasParameter(variant, contextParameterId, contextValue)
  ))
  return matching.length > 0 && matching.every((variant) => variant.isMaxMode === true)
}

/**
 * @param {string} id - Cursor model id.
 * @param {object} variant - catalog variant.
 * @returns {object} SDK model selection.
 */
function selectionFromVariant(id, variant) {
  const params = cloneParams(variant.params)
  return {
    id,
    ...(params.length > 0 ? { params } : {}),
    ...(variant.isMaxMode === true ? { maxMode: true } : {}),
  }
}

/**
 * Build a selection when the catalog has no exact variant for the requested
 * context/effort combination. Individual values are validated by the caller;
 * Max Mode is only inferred when every context variant requires it.
 * @param {string} id - Cursor model id.
 * @param {object} model - catalog row.
 * @param {ModelContext | undefined} context - catalog context metadata.
 * @param {string | undefined} contextValue - selected context value.
 * @param {{ parameterId: string } | undefined} reasoning - catalog reasoning metadata.
 * @param {string | undefined} effort - selected reasoning effort.
 * @returns {object} SDK model selection.
 */
function mergedSelection(id, model, context, contextValue, reasoning, effort) {
  const base = matchingVariant(model, context?.parameterId, contextValue, undefined, undefined)
  const params = cloneParams(base?.params)
  if (context !== undefined && contextValue !== undefined) setParam(params, context.parameterId, contextValue)
  if (reasoning !== undefined && effort !== undefined) setParam(params, reasoning.parameterId, effort)
  return {
    id,
    ...(params.length > 0 ? { params } : {}),
    ...(contextRequiresMaxMode(model, context?.parameterId, contextValue) ? { maxMode: true } : {}),
  }
}

/**
 * Model selection passed to the SDK.
 *
 * A context-capable model's plain id selects its catalog default context.
 * `toModelInfos()` advertises every other context under a synthetic id; this
 * function maps that id back to the real Cursor model and a complete variant.
 * @param {string} modelId - requested DSH model id.
 * @param {string | undefined} effort - selected reasoning effort.
 * @param {object[] | undefined} models - live catalog rows, when a load succeeded.
 * @returns {{ id: string, params?: { id: string, value: string }[], maxMode?: boolean }} SDK model selection.
 */
export function modelSelection(modelId, effort, models) {
  const route = modelRouteOf(modelId)
  const found = models?.find((model) => model.id === route.id)
  if (found === undefined) {
    if (effort !== undefined) {
      throw failure(`model "${route.id}" does not accept reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const params = route.contextValue === undefined
      ? []
      : [{ id: CONTEXT_PARAMETER_ID, value: route.contextValue }]
    return {
      id: route.id,
      ...(params.length > 0 ? { params } : {}),
    }
  }

  const reasoning = reasoningOf(found)
  if (effort !== undefined && (reasoning === undefined || !reasoning.efforts.some((item) => item.id === effort))) {
    throw failure(`model "${route.id}" does not accept reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }

  const context = contextOf(found)
  if (route.contextValue !== undefined && !context?.options.some((option) => option.value === route.contextValue)) {
    throw failure(`model "${route.id}" does not accept context "${route.contextValue}"`, 'UNSUPPORTED_CONTEXT')
  }
  const contextValue = route.contextValue ?? context?.defaultValue

  const variant = matchingVariant(
    found,
    context?.parameterId,
    contextValue,
    reasoning?.parameterId,
    effort,
  )
  if (variant !== undefined) return selectionFromVariant(route.id, variant)
  return mergedSelection(route.id, found, context, contextValue, reasoning, effort)
}

/**
 * @param {{ list: (apiKey: string | undefined) => Promise<object[]>, now?: () => number, ttlMs?: number }} options
 *   catalog loader.
 * @returns {{ load: (apiKey: string | undefined) => Promise<object[]> }} cached loader.
 */
export function createCatalog(options) {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  /** @type {{ at: number, models: object[] } | null} */
  let cached = null
  /** @type {Promise<object[]> | null} */
  let pending = null

  return {
    /**
     * @param {string | undefined} apiKey - key for this lookup.
     * @returns {Promise<object[]>} live catalog rows.
     */
    load(apiKey) {
      if (cached !== null && now() - cached.at < ttlMs) return Promise.resolve(cached.models)
      if (pending === null) {
        pending = options.list(apiKey).then((models) => {
          cached = { at: now(), models }
          return models
        }).finally(() => {
          pending = null
        })
      }
      return pending
    },
  }
}
