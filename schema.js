/**
 * Cordis Config schema for the Cursor provider.
 *
 * The API key is deliberately not a field here: the only supported source is
 * the DSH credentials store written by More → Settings → Cursor.
 */

import z from '@deepseek-ai/schemastery'

import { DEFAULT_CONTEXT_WINDOW } from './config.js'

export const Config = z.object({
  /** Directory a local Cursor agent uses; empty means the system temp directory. */
  cwd: z.string().default(''),
  /** Fallback context capacity for catalog rows without a context parameter, in tokens. */
  contextWindow: z.number().min(1).default(DEFAULT_CONTEXT_WINDOW),
})
