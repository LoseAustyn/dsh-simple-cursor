/**
 * One in-order event queue shared by a Cursor run and the DSH stream that is
 * reading it. Tool-call holds return the stream while the run stays alive, so
 * the next DSH request continues reading the same queue.
 */

import { failure } from './errors.js'

export function createQueue() {
  /** @type {unknown[]} */
  const items = []
  /** @type {Array<() => void>} */
  let waiting = []
  /** @type {Error | null} */
  let stopped = null

  const wake = () => {
    const waiters = waiting
    waiting = []
    for (const waiter of waiters) waiter()
  }

  return {
    /**
     * @param {unknown} item - event the consumer reads next.
     * @returns {void}
     */
    push(item) {
      if (stopped) return
      items.push(item)
      wake()
    },
    /**
     * Unblock the consumer with a terminal error. Later pushes are ignored.
     * @param {Error} error - failure delivered by the next read.
     * @returns {void}
     */
    fail(error) {
      if (stopped) return
      stopped = error
      wake()
    },
    /**
     * @param {AbortSignal | undefined} signal - request cancellation.
     * @returns {Promise<unknown>} the next event.
     */
    async next(signal) {
      for (;;) {
        if (items.length > 0) return items.shift()
        if (stopped) throw stopped
        if (signal?.aborted) throw failure('Cursor request aborted', 'ABORTED')
        await new Promise((resolve, reject) => {
          const waiter = () => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = () => {
            waiting = waiting.filter((item) => item !== waiter)
            reject(failure('Cursor request aborted', 'ABORTED'))
          }
          waiting.push(waiter)
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
    },
  }
}
