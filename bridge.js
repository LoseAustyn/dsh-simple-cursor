/**
 * One local Cursor agent per DSH session.
 * A run that calls a DSH tool stays open: the stream returns `tool-calls`,
 * DSH executes the tools, and the next request resolves the parked callbacks
 * on that same run. History that is no longer a continuation disposes the
 * agent and sends the current transcript to a new one.
 */

import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'

import { createBlockWriter, finishStop, finishToolCalls } from './chunks.js'
import { defaultCwd } from './config.js'
import { failure, failureFromUnknown, sanitizeErrorMessage } from './errors.js'
import { createQueue } from './queue.js'
import { canonicalMessages, classify, renderTranscript, toolResultPayload, withSystemPrompt } from './transcript.js'

/** Quiet period that collects one parallel custom-tool batch, in milliseconds. */
export const TOOL_BATCH_MS = 30

/** Maximum parked custom-tool calls allowed in a single run. */
export const MAX_PENDING_TOOLS = 128

/** Default timeout for a parked tool call waiting on DSH, in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000

/** Default idle/holding lifetime before an abandoned session is dropped. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60_000

/**
 * @param {string | undefined} apiKey - credential value.
 * @returns {string | undefined} SHA-256 fingerprint for rotation detection.
 */
function fingerprintKey(apiKey) {
  if (typeof apiKey !== 'string') return undefined
  return createHash('sha256').update(apiKey).digest('hex')
}

/**
 * Ensure `cwd` exists with restrictive permissions (`0700`), is owned by the
 * current user, and is not a symbolic link.
 * @param {string} cwd - local agent working directory.
 * @returns {Promise<void>}
 */
async function ensureCwd(cwd) {
  await fsp.mkdir(cwd, { recursive: true, mode: 0o700 })
  const stat = await fsp.lstat(cwd)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw failure('dsh-simple-cursor: cwd must be a directory and not a symbolic link', 'INVALID_REQUEST')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw failure('dsh-simple-cursor: cwd must be owned by the current user', 'INVALID_REQUEST')
  }
  if (cwd === defaultCwd() && (stat.mode & 0o077) !== 0) {
    await fsp.chmod(cwd, 0o700)
  }
}

/**
 * @param {{
 *   client: { createAgent: (options: object) => Promise<object> },
 *   cwd: string,
 *   defer?: (fn: () => void) => () => void,
 *   toolTimeoutMs?: number,
 *   sessionTtlMs?: number,
 *   maxPendingTools?: number,
 * }} options - SDK client, agent directory, and tool-batch scheduler.
 * @returns {{ stream: (request: object, extras: object) => AsyncGenerator<object>, dispose: () => Promise<void> }} bridge.
 */
export function createBridge(options) {
  const defer = options.defer ?? ((fn) => {
    const timer = setTimeout(fn, TOOL_BATCH_MS)
    return () => clearTimeout(timer)
  })
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxPendingTools = options.maxPendingTools ?? MAX_PENDING_TOOLS
  /** @type {Map<string, object>} */
  const sessions = new Map()

  /**
   * @param {object} session - live session.
   * @returns {void}
   */
  function clearHolders(session) {
    session.clearAbort?.()
    session.clearAbort = undefined
    session.clearIdle?.()
    session.clearIdle = undefined
  }

  /**
   * @param {object} session - live session in `holding` or `idle`.
   * @param {AbortSignal | undefined} signal - request cancellation while holding.
   * @returns {void}
   */
  function armIdle(session, signal) {
    clearHolders(session)
    if (session.closed) return
    if (session.phase === 'holding' && signal !== undefined) {
      if (signal.aborted) {
        void drop(session)
        return
      }
      const onAbort = () => {
        void drop(session)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      session.clearAbort = () => signal.removeEventListener('abort', onAbort)
    }
    if (Number.isFinite(sessionTtlMs) && sessionTtlMs > 0) {
      const timer = setTimeout(() => {
        void drop(session)
      }, sessionTtlMs)
      timer.unref?.()
      session.clearIdle = () => clearTimeout(timer)
    }
  }

  /**
   * @param {object} session - live session.
   * @returns {Promise<void>} settlement after the agent is released.
   */
  async function drop(session) {
    if (session.closed) return
    session.closed = true
    session.phase = 'closed'
    session.cancelTimer?.()
    clearHolders(session)
    session.queue.fail(failure('Cursor session closed', 'ABORTED'))
    for (const parked of session.pending.values()) parked.reject(failure('Cursor session closed', 'ABORTED'))
    session.pending.clear()
    for (const [key, value] of sessions) {
      if (value === session) sessions.delete(key)
    }
    try {
      await session.run?.cancel?.()
    } catch {
      // The run already finished.
    }
    try {
      await session.agent?.dispose?.()
    } catch {
      // Disposal is best-effort once the run has been cancelled.
    }
  }

  /**
   * @param {object} session - live session.
   * @param {{ id?: string, name: string, args: unknown }} call - custom-tool invocation.
   * @returns {Promise<unknown>} result DSH supplies on the next request.
   */
  function parkTool(session, call) {
    const hasExplicitId = typeof call.id === 'string' && call.id.length > 0
    const id = hasExplicitId ? call.id : randomUUID()
    if (hasExplicitId && session.pending.has(id)) {
      const duplicate = failure(`dsh-simple-cursor: duplicate tool call id "${id}"`, 'INVALID_REQUEST')
      session.queue.fail(duplicate)
      return Promise.reject(duplicate)
    }
    if (session.pending.size >= maxPendingTools) {
      const overflow = failure('dsh-simple-cursor: too many pending tool calls in one run', 'INVALID_REQUEST')
      session.queue.fail(overflow)
      return Promise.reject(overflow)
    }
    let settled = false
    let timer
    /** @type {(value: unknown) => void} */
    let resolve
    /** @type {(error: Error) => void} */
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
    const entry = {
      resolve: (value) => {
        if (settled) return
        settled = true
        clearTimer()
        resolve(value)
      },
      reject: (error) => {
        if (settled) return
        settled = true
        clearTimer()
        reject(error)
      },
    }
    if (Number.isFinite(toolTimeoutMs) && toolTimeoutMs > 0) {
      timer = setTimeout(() => {
        entry.reject(failure('dsh-simple-cursor: tool call timed out waiting for result', 'ABORTED'))
        void drop(session)
      }, toolTimeoutMs)
      timer.unref?.()
    }
    session.pending.set(id, entry)
    session.queue.push({ type: 'tool', call: { id, name: call.name, args: call.args ?? {} } })
    session.cancelTimer?.()
    session.cancelTimer = defer(() => {
      session.cancelTimer = undefined
      session.queue.push({ type: 'tools-ready' })
    })
    return promise
  }

  /**
   * @param {object} session - live session.
   * @param {object[]} messages - transcript slice this run should read.
   * @param {object} request - DSH request.
   * @param {object} extras - key, model selection, and image loader.
   * @returns {Promise<void>} settlement after the run has started.
   */
  async function start(session, messages, request, extras) {
    const rendered = renderTranscript(messages)
    // `system` reaches an adapter as its own field; the SDK takes one user
    // message, so a one-shot caller's prompt joins the body ahead of it.
    const prompt = withSystemPrompt(request.system, rendered.text)
    const text = prompt.trim().length > 0 ? prompt : 'Continue.'
    const images = []
    for (const block of rendered.images) {
      images.push(await extras.loadImage(block.attachment, request.signal))
    }
    const run = await session.agent.send({
      text,
      images,
      model: extras.model,
      tools: request.tools ?? [],
    }, {
      onText: (delta) => session.queue.push({ type: 'text', text: delta }),
      onThinking: (delta) => session.queue.push({ type: 'thinking', text: delta }),
      onTool: (call) => parkTool(session, call),
    })
    session.run = run
    void run.wait().then(
      (result) => session.queue.push({ type: 'done', result }),
      (error) => session.queue.fail(failureFromUnknown(error, extras.apiKey !== undefined)),
    )
  }

  /**
   * @param {string} key - session map key.
   * @param {object} request - DSH request.
   * @param {object} extras - key, model selection, and image loader.
   * @returns {Promise<object>} session whose run has started.
   */
  async function open(key, request, extras) {
    await ensureCwd(options.cwd)
    const agent = await options.client.createAgent({
      apiKey: extras.apiKey,
      model: extras.model,
      cwd: options.cwd,
    })
    const session = {
      agent,
      queue: createQueue(),
      pending: new Map(),
      seen: [],
      phase: 'running',
      modelId: request.model,
      apiKeyFingerprint: fingerprintKey(extras.apiKey),
      requestMessages: request.messages,
      closed: false,
    }
    try {
      await start(session, request.messages ?? [], request, extras)
    } catch (error) {
      await drop(session)
      throw error
    }
    sessions.set(key, session)
    return session
  }

  /**
   * @param {object} session - session holding tool calls.
   * @param {object} request - request that carries the tool results.
   * @param {object} extras - image loader.
   * @returns {Promise<void>} settlement after every parked call has been resolved.
   */
  async function resolveTools(session, request, extras) {
    const suffix = (request.messages ?? []).slice(session.seen.length)
    for (const [id, parked] of session.pending) {
      const message = suffix.find((item) => item?.role === 'tool' && item.toolCallId === id)
      if (message === undefined) throw failure(`dsh-simple-cursor: missing tool result for ${id}`, 'INVALID_REQUEST')
      parked.resolve(await toolResultPayload(message, extras.loadImage, request.signal))
    }
    session.pending.clear()
  }

  /**
   * @param {object} session - session with a live queue.
   * @param {AbortSignal | undefined} signal - request cancellation.
   * @returns {AsyncGenerator<object>} chunks for this DSH request.
   */
  async function* consume(session, signal) {
    const writer = createBlockWriter()
    /** @type {object[]} */
    const buffered = []
    for (;;) {
      const event = await session.queue.next(signal)
      if (event?.type === 'text') {
        yield* writer.text(event.text)
      } else if (event?.type === 'thinking') {
        yield* writer.thinking(event.text)
      } else if (event?.type === 'tool') {
        buffered.push(event.call)
      } else if (event?.type === 'tools-ready') {
        if (buffered.length === 0) continue
        for (const call of buffered) yield* writer.tool(call)
        yield* writer.close()
        yield* finishToolCalls()
        session.phase = 'holding'
        session.seen = canonicalMessages(session.requestMessages)
        armIdle(session, signal)
        return
      } else if (event?.type === 'done') {
        session.cancelTimer?.()
        const result = event.result ?? {}
        if (result.status === 'error') {
          throw failure(sanitizeErrorMessage(result.error?.message, 'Cursor run failed'), 'TRANSPORT')
        }
        if (result.status === 'cancelled') throw failure('Cursor run cancelled', 'ABORTED')
        if (buffered.length > 0) {
          for (const call of buffered) yield* writer.tool(call)
          yield* writer.close()
          yield* finishToolCalls()
          session.stale = true
          session.phase = 'idle'
          for (const parked of session.pending.values()) {
            parked.reject(failure('Cursor run ended before the tool result was delivered', 'STREAM_CLOSED'))
          }
          session.pending.clear()
          return
        }
        yield* writer.close()
        if (!writer.blocks().some((block) => block.type === 'text' && block.text.length > 0)
          && typeof result.result === 'string' && result.result.length > 0) {
          yield* writer.text(result.result)
          yield* writer.close()
        }
        if (writer.blocks().length === 0) throw failure('Cursor returned an empty response', 'EMPTY_RESPONSE')
        yield* finishStop(result.usage)
        session.phase = 'idle'
        session.seen = [
          ...canonicalMessages(session.requestMessages),
          ...canonicalMessages([{ role: 'assistant', content: writer.blocks() }]),
        ]
        armIdle(session, undefined)
        return
      } else {
        throw failure('Cursor stream closed', 'STREAM_CLOSED')
      }
    }
  }

  return {
    /**
     * @param {object} request - DSH generate options.
     * @param {{ apiKey: string | undefined, model: object, loadImage: Function }} extras - call context.
     * @returns {AsyncGenerator<object>} stream chunks.
     */
    async *stream(request, extras) {
      if (request.signal?.aborted) throw failure('Cursor request aborted', 'ABORTED')
      const key = sessionKey(request)
      let session = sessions.get(key)
      if (session?.phase === 'running') {
        throw failure('dsh-simple-cursor: this session already has a Cursor run in progress', 'INVALID_REQUEST')
      }
      const pendingIds = new Set(session?.pending?.keys() ?? [])
      const apiKeyFingerprint = fingerprintKey(extras.apiKey)
      let plan = session === undefined || session.stale === true || session.modelId !== request.model || session.apiKeyFingerprint !== apiKeyFingerprint
        ? { kind: 'fresh' }
        : classify(session.seen, request.messages ?? [], pendingIds)
      if (plan.kind === 'tools' && session.phase !== 'holding') plan = { kind: 'fresh' }
      if (plan.kind === 'follow-up' && session.phase !== 'idle') plan = { kind: 'fresh' }
      try {
        if (plan.kind === 'tools') {
          clearHolders(session)
          session.requestMessages = request.messages
          session.phase = 'running'
          await resolveTools(session, request, extras)
          yield* consume(session, request.signal)
        } else if (plan.kind === 'follow-up') {
          clearHolders(session)
          session.requestMessages = request.messages
          session.phase = 'running'
          await start(session, plan.messages, request, extras)
          yield* consume(session, request.signal)
        } else {
          if (session !== undefined) {
            await drop(session)
            session = undefined
          }
          session = await open(key, request, extras)
          yield* consume(session, request.signal)
        }
        if (session?.stale === true) await drop(session)
      } catch (error) {
        if (session !== undefined && sessions.get(key) === session) await drop(session)
        throw failureFromUnknown(error, extras.apiKey !== undefined)
      } finally {
        if (session !== undefined && session.phase === 'running' && sessions.get(key) === session) {
          await drop(session)
        }
      }
    },
    /** @returns {Promise<void>} settlement after every agent is released. */
    async dispose() {
      const live = [...sessions.values()]
      await Promise.all(live.map((session) => drop(session)))
    },
  }
}

/**
 * @param {object} request - DSH generate options.
 * @returns {string} map key. Auxiliary purposes never share the conversation agent.
 */
export function sessionKey(request) {
  const id = request.sessionId === undefined || request.sessionId === ''
    ? 'default'
    : encodeURIComponent(String(request.sessionId))
  return request.purpose === undefined || request.purpose === ''
    ? `session:${id}`
    : `purpose:${id}:${encodeURIComponent(String(request.purpose))}`
}
