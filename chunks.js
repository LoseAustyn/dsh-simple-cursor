/**
 * DSH stream chunks assembled from Cursor text, thinking, and tool callbacks.
 * `inputTokens` is forwarded as the SDK reports it. Cache fields are included
 * only when `totalTokens` still matches after adding them; a total that already
 * equals input plus output is treated as having cache folded into input.
 */

/**
 * @returns {{
 *   text: (delta: string) => object[],
 *   thinking: (delta: string) => object[],
 *   tool: (call: { id: string, name: string, args: unknown }) => object[],
 *   close: () => object[],
 *   blocks: () => object[],
 * }} writer whose methods return the chunks produced by that call.
 */
export function createBlockWriter() {
  let index = 0
  /** @type {{ kind: 'text' | 'reasoning', index: number, text: string } | null} */
  let current = null
  /** @type {object[]} */
  const blocks = []
  /** @type {object[]} */
  let pending = []

  const take = () => {
    const chunks = pending
    pending = []
    return chunks
  }

  const close = () => {
    if (current === null) return
    const block = current.kind === 'text'
      ? { type: 'text', text: current.text }
      : { type: 'reasoning', text: current.text }
    pending.push({ type: 'block-end', index: current.index, block })
    blocks.push(block)
    current = null
  }

  const open = (kind) => {
    if (current?.kind === kind) return
    close()
    const blockType = kind === 'text' ? 'text' : 'reasoning'
    pending.push({ type: 'block-start', index, blockType })
    current = { kind, index, text: '' }
    index += 1
  }

  return {
    text(delta) {
      if (delta.length === 0) return take()
      open('text')
      current.text += delta
      pending.push({ type: 'text-delta', index: current.index, text: delta })
      return take()
    },
    thinking(delta) {
      if (delta.length === 0) return take()
      open('reasoning')
      current.text += delta
      pending.push({ type: 'reasoning-delta', index: current.index, text: delta })
      return take()
    },
    tool(call) {
      close()
      const args = JSON.stringify(call.args ?? {})
      const block = { type: 'tool-call', id: call.id, name: call.name, arguments: args }
      const toolIndex = index
      index += 1
      pending.push({ type: 'block-start', index: toolIndex, blockType: 'tool-call' })
      pending.push({
        type: 'tool-call-delta',
        index: toolIndex,
        id: call.id,
        name: call.name,
        argumentsDelta: args,
      })
      pending.push({ type: 'block-end', index: toolIndex, block })
      blocks.push(block)
      return take()
    },
    close() {
      close()
      return take()
    },
    blocks() {
      return blocks.slice()
    },
  }
}

/**
 * @param {unknown} usage - SDK token usage, when the run reported one.
 * @returns {object | undefined} DSH usage, or undefined when the counts are unusable.
 */
export function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const inputTokens = finiteCount(usage.inputTokens)
  const outputTokens = finiteCount(usage.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = finiteCount(usage.cacheReadTokens) ?? 0
  const cacheWriteTokens = finiteCount(usage.cacheWriteTokens) ?? 0
  const reasoningTokens = finiteCount(usage.reasoningTokens)
  const reported = finiteCount(usage.totalTokens)
  const separated = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const folded = inputTokens + outputTokens
  const cacheInsideInput = reported === folded && (cacheReadTokens > 0 || cacheWriteTokens > 0)
  const totalMatches = reported === separated || reported === folded
  return {
    inputTokens,
    outputTokens,
    ...(cacheInsideInput || cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheInsideInput || cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined || reasoningTokens === 0 ? {} : { reasoningTokens }),
    ...(reported === undefined || !totalMatches ? {} : { totalTokens: reported }),
  }
}

/**
 * @param {unknown} usage - SDK token usage.
 * @returns {object[]} usage chunk, when counts exist, then the stop finish chunk.
 */
export function finishStop(usage) {
  const mapped = mapUsage(usage)
  return [
    ...(mapped === undefined ? [] : [{ type: 'usage', usage: mapped }]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** @returns {object[]} finish chunk that asks DSH to run the emitted tool calls. */
export function finishToolCalls() {
  return [{ type: 'finish', reason: { kind: 'tool-calls' } }]
}

/**
 * @param {unknown} value - candidate count.
 * @returns {number | undefined} a non-negative finite integer count.
 */
function finiteCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}
