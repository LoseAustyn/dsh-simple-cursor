/**
 * Local Cursor agent options.
 * Custom tools are registered as the `mcp` tool group. An empty built-in
 * allowlist turns that group off, so the allowlist keeps `mcp` and nothing
 * else: DSH executes tools, and Cursor's file, shell, and web tools stay off.
 * `settingSources` stays empty so project and user MCP servers are not added.
 */

/**
 * @param {{ apiKey: string | undefined, model: { id: string, params?: { id: string, value: string }[], maxMode?: boolean }, cwd: string }} options
 *   agent settings.
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
    },
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
      const { Agent } = await import('@cursor/sdk')
      const { failureFromUnknown } = await import('./errors.js')
      let agent
      try {
        agent = await Agent.create(localAgentOptions(options))
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
          await agent[Symbol.asyncDispose]()
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
