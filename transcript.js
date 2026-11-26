/**
 * Conversation fingerprint and the text Cursor's `send()` accepts.
 * The SDK takes one user message per run, so a fresh agent receives the
 * whole transcript as that message. A matching follow-up sends only the
 * new suffix. Tool results of a held run are delivered through the parked
 * tool callback, not as another prompt.
 */

/**
 * @param {unknown} messages - request messages.
 * @returns {object[]} canonical messages used as the session fingerprint.
 */
export function canonicalMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    const entry = {
      role: typeof message?.role === 'string' ? message.role : 'unknown',
      blocks: contentBlocks(message).map(canonicalBlock),
    }
    if (message?.role === 'tool') {
      entry.toolCallId = String(message.toolCallId ?? '')
      if (message.isError === true) entry.isError = true
    }
    return entry
  })
}

/**
 * Decide how the next DSH request relates to the Cursor agent that already
 * saw `seen`.
 * @param {object[]} seen - canonical messages the agent has already consumed.
 * @param {object[]} messages - the next request's messages.
 * @param {ReadonlySet<string>} pendingIds - tool calls waiting for results.
 * @returns {{ kind: 'fresh' } | { kind: 'follow-up', messages: object[] } | { kind: 'tools' }} the next step.
 */
export function classify(seen, messages, pendingIds) {
  if (!Array.isArray(seen) || seen.length === 0) return { kind: 'fresh' }
  const next = canonicalMessages(messages)
  if (next.length < seen.length) return { kind: 'fresh' }
  for (let index = 0; index < seen.length; index += 1) {
    if (JSON.stringify(seen[index]) !== JSON.stringify(next[index])) return { kind: 'fresh' }
  }
  const suffix = next.slice(seen.length)
  if (suffix.length === 0) return { kind: 'fresh' }
  if (pendingIds.size > 0 && isToolSuffix(suffix, pendingIds)) return { kind: 'tools' }
  if (pendingIds.size === 0 && suffix.every((message) =>
    message.role === 'user' || message.role === 'developer' || message.role === 'system')) {
    return { kind: 'follow-up', messages: messages.slice(seen.length) }
  }
  return { kind: 'fresh' }
}

/**
 * Render messages into the single user message `agent.send()` accepts.
 * Image attachments are returned beside the text so the caller can load bytes.
 * @param {object[]} messages - messages to include, in order.
 * @returns {{ text: string, images: object[] }} prompt text and image blocks that still need bytes.
 */
export function renderTranscript(messages) {
  const lines = []
  /** @type {object[]} */
  const images = []
  for (const message of messages ?? []) {
    const rendered = renderMessage(message, images)
    if (rendered.length > 0) lines.push(rendered)
  }
  return { text: lines.join('\n\n'), images }
}

/**
 * Place a one-shot system prompt ahead of the rendered transcript. Loop-built
 * requests leave `system` unset and carry the prompt as message 0 instead, so
 * this only fires for auxiliary callers such as session titles.
 * @param {unknown} system - `GenerateOptions.system`, when the caller set one.
 * @param {string} text - rendered transcript.
 * @returns {string} the body `agent.send()` receives.
 */
export function withSystemPrompt(system, text) {
  const prompt = typeof system === 'string' ? system.trim() : ''
  if (prompt.length === 0) return text
  return text.trim().length === 0 ? `System:\n${prompt}` : `System:\n${prompt}\n\n${text}`
}

/**
 * Tool result handed back to a parked Cursor custom tool.
 * @param {object} message - DSH tool-role message.
 * @param {(attachment: object, signal: AbortSignal | undefined) => Promise<{ data: string, mimeType: string }>} loadImage - image byte loader.
 * @param {AbortSignal | undefined} signal - request cancellation.
 * @returns {Promise<string | { content: object[], isError?: boolean }>} SDK tool result.
 */
export async function toolResultPayload(message, loadImage, signal) {
  const texts = []
  /** @type {object[]} */
  const content = []
  for (const block of contentBlocks(message)) {
    if (block.type === 'text') {
      texts.push(String(block.text ?? ''))
    } else if (block.type === 'image' && block.offloaded === true) {
      texts.push(offloadedImage(block))
    } else if (block.type === 'image') {
      const image = await loadImage(block.attachment, signal)
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    } else if (block.type === 'reasoning') {
      texts.push(String(block.text ?? ''))
    }
  }
  const text = texts.filter((part) => part.length > 0).join('\n')
  if (content.length === 0) {
    if (message.isError === true) {
      return { content: [{ type: 'text', text: text || 'tool failed' }], isError: true }
    }
    return text
  }
  if (text.length > 0) content.unshift({ type: 'text', text })
  return {
    content,
    ...(message.isError === true ? { isError: true } : {}),
  }
}

/**
 * @param {object[]} suffix - canonical messages after the fingerprint.
 * @param {ReadonlySet<string>} pendingIds - tool calls waiting for results.
 * @returns {boolean} whether the suffix is exactly those tool results.
 */
function isToolSuffix(suffix, pendingIds) {
  const ids = []
  for (const message of suffix) {
    if (message.role === 'tool') {
      if (!pendingIds.has(message.toolCallId)) return false
      ids.push(message.toolCallId)
    } else if (message.role !== 'assistant') return false
  }
  if (ids.length !== pendingIds.size) return false
  const unique = new Set(ids)
  if (unique.size !== pendingIds.size) return false
  for (const id of pendingIds) {
    if (!unique.has(id)) return false
  }
  return true
}

/**
 * @param {object} message - one request message.
 * @param {object[]} images - image blocks collected for the SDK message.
 * @returns {string} one labeled transcript entry.
 */
function renderMessage(message, images) {
  const parts = []
  for (const block of contentBlocks(message)) {
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push(text)
    } else if (block.type === 'tool-call') {
      parts.push(`[tool call ${block.name} ${block.id}]\n${block.arguments ?? ''}`)
    } else if (block.type === 'image' && block.offloaded === true) {
      parts.push(offloadedImage(block))
    } else if (block.type === 'image') {
      images.push(block)
      parts.push(`[image ${images.length}]`)
    } else if (block.type === 'file') {
      const name = block.attachment?.name
      parts.push(`[file${typeof name === 'string' && name.length > 0 ? `: ${name}` : ''}]`)
    } else if (block.type === 'tool-addition') {
      parts.push(`[tool added: ${block.toolName}]`)
    } else if (block.type === 'tool-removal') {
      parts.push(`[tool removed: ${block.toolName}]`)
    } else if (typeof block.type === 'string') {
      parts.push(`[${block.type}]`)
    }
  }
  if (parts.length === 0) return ''
  const body = parts.join('\n')
  if (message.role === 'tool') {
    const status = message.isError === true ? ' error' : ''
    return `Tool result (${message.toolCallId})${status}:\n${body}`
  }
  const label = message.role === 'system' ? 'System'
    : message.role === 'developer' ? 'Developer'
      : message.role === 'assistant' ? 'Assistant'
        : 'User'
  return `${label}:\n${body}`
}

/**
 * @param {object} block - offloaded image block.
 * @returns {string} text the model can read in place of the bytes.
 */
function offloadedImage(block) {
  const name = block.attachment?.name
  return `[image offloaded${typeof name === 'string' && name.length > 0 ? `: ${name}` : ''}]`
}

/**
 * @param {object} message - request message.
 * @returns {object[]} content blocks.
 */
function contentBlocks(message) {
  if (typeof message?.content === 'string') return [{ type: 'text', text: message.content }]
  if (Array.isArray(message?.content)) return message.content
  return []
}

/**
 * @param {object} block - one content block.
 * @returns {object} fields that affect the fingerprint.
 */
function canonicalBlock(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning':
      return { type: block.type, text: String(block.text ?? '') }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: String(block.arguments ?? ''),
      }
    case 'image':
      return {
        type: 'image',
        id: String(block.attachment?.attachmentId ?? ''),
        offloaded: block.offloaded === true,
      }
    case 'file':
      return { type: 'file', id: String(block.attachment?.attachmentId ?? '') }
    case 'tool-addition':
      return { type: 'tool-addition', toolName: String(block.toolName ?? '') }
    case 'tool-removal':
      return { type: 'tool-removal', toolName: String(block.toolName ?? '') }
    default:
      return { type: String(block?.type ?? 'unknown') }
  }
}
