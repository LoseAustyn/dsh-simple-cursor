/**
 * Local Cursor agent options.
 * Custom tools are registered as the `mcp` tool group. An empty built-in
 * allowlist turns that group off, so the allowlist keeps `mcp` and nothing
 * else: DSH executes tools, and Cursor's file, shell, and web tools stay off.
 * `settingSources` stays empty so project and user MCP servers are not added.
 * When `fs` (`emptyFs()`) and `store` (an in-memory store) are supplied, the
 * client also prevents host shell/file tool registration and SQLite disk
 * persistence as defense in depth.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'

/**
 * @param {{
 *   apiKey: string | undefined,
 *   model: { id: string, params?: { id: string, value: string }[], maxMode?: boolean },
 *   cwd: string,
 *   fs?: object,
 *   store?: object,
 * }} options - agent settings.
 * @returns {object} `Agent.create` options.
 */
export function localAgentOptions(options) {
  return {
    name: 'DSH',
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    model: options.model,
    tools: ['mcp'],
    local: {
      cwd: options.cwd,
      settingSources: [],
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      ...(options.store === undefined ? {} : { store: options.store }),
    },
  }
}

/**
 * In-memory `LocalAgentStore` implementation so SDK checkpoints, agent rows,
 * and run events stay in process memory instead of writing SQLite databases
 * under `~/.cursor/projects/<slug>/sdk-agent-store/`.
 * @param {object} [sdk] - `@cursor/sdk` exports (`composeLocalAgentStore`, `paginate*`).
 * @returns {object} `LocalAgentStore`-compatible store.
 */
export function createInMemoryStore(sdk = {}) {
  const agents = new Map()
  const runs = new Map()
  const checkpoints = new Map()
  const events = new Map()
  const runKey = (agentId, runId) => `${agentId}\0${runId}`
  const blobKey = (agentId, blobId) => `${agentId}\0${blobId}`

  const paginateAgents = sdk.paginateAgentDocuments ?? ((items) => ({ items: [...items] }))
  const paginateBlobs = sdk.paginateCheckpointBlobIds ?? ((ids) => ({ items: [...ids] }))
  const paginateRuns = sdk.paginateRunDocuments ?? ((items) => ({ items: [...items] }))
  const compose = sdk.composeLocalAgentStore ?? ((parts) => parts)

  return compose({
    agents: {
      async get({ agentId }) {
        return agents.get(agentId) ?? null
      },
      async create({ agent }) {
        agents.set(agent.agentId, agent)
        return agent
      },
      async update({ agent }) {
        agents.set(agent.agentId, agent)
        return agent
      },
      async delete({ filter }) {
        for (const [id, item] of agents) {
          const matchId = !filter?.agentIds?.length || filter.agentIds.includes(id)
          const matchCwd = !filter?.cwd || item.cwd === filter.cwd
          if (matchId && matchCwd) agents.delete(id)
        }
      },
      async list({ filter } = {}) {
        return paginateAgents([...agents.values()], filter)
      },
    },
    checkpoints: {
      async get({ agentId, blobId }) {
        return checkpoints.get(blobKey(agentId, blobId)) ?? null
      },
      async create({ agentId, blobId, data }) {
        checkpoints.set(blobKey(agentId, blobId), data)
      },
      async update({ agentId, blobId, data }) {
        checkpoints.set(blobKey(agentId, blobId), data)
      },
      async delete({ filter }) {
        for (const key of checkpoints.keys()) {
          const [agentId, blobId] = key.split('\0')
          const matchAgent = !filter?.agentIds?.length || filter.agentIds.includes(agentId)
          const matchBlob = !filter?.blobIds?.length || filter.blobIds.includes(blobId)
          if (matchAgent && matchBlob) checkpoints.delete(key)
        }
      },
      async list({ filter } = {}) {
        const ids = []
        for (const key of checkpoints.keys()) {
          const [agentId, blobId] = key.split('\0')
          const matchAgent = !filter?.agentIds?.length || filter.agentIds.includes(agentId)
          const matchBlob = !filter?.blobIds?.length || filter.blobIds.includes(blobId)
          if (matchAgent && matchBlob) ids.push(blobId)
        }
        return paginateBlobs(ids, filter)
      },
    },
    runs: {
      async get({ agentId, runId }) {
        return runs.get(runKey(agentId, runId)) ?? null
      },
      async create({ run }) {
        runs.set(runKey(run.agentId, run.runId), run)
        return run
      },
      async update({ run }) {
        runs.set(runKey(run.agentId, run.runId), run)
        return run
      },
      async delete({ filter }) {
        for (const [key, run] of runs) {
          const matchAgent = !filter?.agentIds?.length || filter.agentIds.includes(run.agentId)
          const matchRun = !filter?.runIds?.length || filter.runIds.includes(run.runId)
          if (matchAgent && matchRun) runs.delete(key)
        }
      },
      async list({ filter } = {}) {
        const rows = [...runs.values()].filter((run) => {
          const matchAgent = !filter?.agentIds?.length || filter.agentIds.includes(run.agentId)
          const matchRun = !filter?.runIds?.length || filter.runIds.includes(run.runId)
          return matchAgent && matchRun
        })
        return paginateRuns(rows, filter)
      },
    },
    runEvents: {
      async append({ runId, eventType, payload, payloadRef, idempotencyKey }) {
        const list = events.get(runId) ?? []
        const seq = list.length + 1
        const doc = {
          runId,
          seq,
          offset: String(seq),
          eventType,
          payload: payload ?? null,
          payloadRef: payloadRef ?? null,
          idempotencyKey: idempotencyKey ?? null,
          createdAt: Date.now(),
        }
        list.push(doc)
        events.set(runId, list)
        return doc
      },
      async list({ runId, afterOffset, limit }) {
        const list = events.get(runId) ?? []
        const after = afterOffset ? Number(afterOffset) : 0
        const filtered = list.filter((doc) => doc.seq > after)
        const items = typeof limit === 'number' ? filtered.slice(0, limit) : filtered
        const nextOffset = items.length > 0 && items.length < filtered.length ? items.at(-1).offset : undefined
        return { items, ...(nextOffset === undefined ? {} : { nextOffset }) }
      },
      async delete({ filter }) {
        if (!filter?.runIds?.length) events.clear()
        else for (const id of filter.runIds) events.delete(id)
      },
    },
  })
}

/**
 * Best-effort cleanup of per-agent SDK transcript files created under
 * `~/.cursor/projects/<cwd-slug>/agent-transcripts/<agentId>` (or `CURSOR_DATA_DIR`).
 * Only deletes the exact directory belonging to the disposed agent id.
 * @param {string} cwd - agent cwd.
 * @param {string | undefined} agentId - disposed SDK agent id.
 * @param {{ dataDir?: string, homeDir?: string }} [env] - path overrides for tests.
 * @returns {Promise<void>}
 */
export async function cleanupAgentTranscripts(cwd, agentId, env = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return
  if (typeof agentId !== 'string' || agentId.length === 0) return
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length === 0) return
  const safeId = encodeURIComponent(agentId).replace(/%/g, '_').slice(0, 200)
  if (safeId.length === 0 || safeId === '.' || safeId === '..') return
  const dataRoot = typeof (env.dataDir ?? process.env.CURSOR_DATA_DIR) === 'string'
    && (env.dataDir ?? process.env.CURSOR_DATA_DIR).trim().length > 0
    ? nodePath.join((env.dataDir ?? process.env.CURSOR_DATA_DIR).trim(), 'projects', slug)
    : nodePath.join(env.homeDir ?? os.homedir(), '.cursor', 'projects', slug)
  const transcriptsRoot = nodePath.resolve(dataRoot, 'agent-transcripts')
  const target = nodePath.resolve(transcriptsRoot, safeId)
  if (!target.startsWith(`${transcriptsRoot}${nodePath.sep}`)) return
  try {
    await fsp.rm(target, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup; ignore permission or concurrent removal races.
  }
}

/**
 * SDK client used by the bridge. The package is imported on first use so unit
 * tests of the other modules do not load it.
 * @returns {{
 *   createAgent: (options: { apiKey: string | undefined, model: object, cwd: string }) => Promise<object>,
 *   listModels: (apiKey: string | undefined) => Promise<object[]>,
 * }} client.
 */
export function createSdkClient() {
  return {
    async createAgent(options) {
      const sdk = await import('@cursor/sdk')
      const { Agent, emptyFs } = sdk
      const { failureFromUnknown } = await import('./errors.js')
      const store = createInMemoryStore(sdk)
      let agent
      try {
        agent = await Agent.create(localAgentOptions({
          ...options,
          fs: emptyFs(),
          store,
        }))
      } catch (error) {
        throw failureFromUnknown(error, options.apiKey !== undefined)
      }
      return {
        /**
         * @param {{ text: string, images?: object[], model: object, tools?: object[] }} message - one run.
         * @param {{ onText: (text: string) => void, onThinking: (text: string) => void, onTool: (call: object) => Promise<unknown> }} listeners
         *   run callbacks.
         * @returns {Promise<{ wait: () => Promise<object>, cancel: () => Promise<void> }>} run handle.
         */
        async send(message, listeners) {
          const customTools = {}
          for (const tool of message.tools ?? []) {
            if (typeof tool?.name !== 'string' || tool.name.length === 0) {
              const { failure } = await import('./errors.js')
              throw failure('dsh-simple-cursor: a tool is missing a name', 'INVALID_REQUEST')
            }
            if (Object.hasOwn(customTools, tool.name)) {
              const { failure } = await import('./errors.js')
              throw failure(`dsh-simple-cursor: duplicate tool name "${tool.name}"`, 'INVALID_REQUEST')
            }
            customTools[tool.name] = {
              description: typeof tool.description === 'string' ? tool.description : '',
              ...(tool.parameters === undefined ? {} : { inputSchema: tool.parameters }),
              execute: (args, context) => listeners.onTool({
                id: typeof context?.toolCallId === 'string' && context.toolCallId.length > 0
                  ? context.toolCallId
                  : undefined,
                name: tool.name,
                args: args ?? {},
              }),
            }
          }
          let run
          try {
            const images = Array.isArray(message.images) && message.images.length > 0 ? message.images : undefined
            run = await agent.send(images === undefined ? message.text : { text: message.text, images }, {
              model: message.model,
              onDelta: ({ update }) => {
                if (update?.type === 'text-delta' && typeof update.text === 'string') listeners.onText(update.text)
                else if (update?.type === 'thinking-delta' && typeof update.text === 'string') listeners.onThinking(update.text)
              },
              local: { customTools },
            })
          } catch (error) {
            throw failureFromUnknown(error, options.apiKey !== undefined)
          }
          return {
            wait: async () => {
              try {
                return await run.wait()
              } catch (error) {
                throw failureFromUnknown(error, options.apiKey !== undefined)
              }
            },
            cancel: async () => {
              if (typeof run.cancel === 'function') await run.cancel()
            },
          }
        },
        async dispose() {
          try {
            await agent[Symbol.asyncDispose]()
          } finally {
            await cleanupAgentTranscripts(options.cwd, agent?.agentId)
          }
        },
      }
    },
    async listModels(apiKey) {
      const { Cursor } = await import('@cursor/sdk')
      const { failureFromUnknown } = await import('./errors.js')
      try {
        return await Cursor.models.list(apiKey === undefined ? {} : { apiKey })
      } catch (error) {
        throw failureFromUnknown(error, apiKey !== undefined)
      }
    },
  }
}
