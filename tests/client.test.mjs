import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, describe, it } from 'node:test'

/**
 * The browser half registers through the page's module loader and renders with
 * the page's React. These tests keep both dependencies at their seam: a
 * recording loader captures the factory, and a minimal React shim lets the
 * section component be called to inspect the element tree it produces.
 */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const React = {
  Fragment: Symbol('fragment'),
  createElement,
  useId: () => 'id-1',
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

let captured
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
after(() => { delete globalThis.window })
await import('../client.js')

const factory = captured.factory
const module = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function collect(tree, predicate) {
  const found = []
  walk(tree, (node) => { if (predicate(node)) found.push(node) })
  return found
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined) return ''
  return (node.children ?? []).map((child) => textOf(child)).join('')
}

function applyWith(options = {}) {
  const calls = { locale: [], register: [] }
  const ctx = {
    get: () => options.remote,
    effect: (fn) => { fn() },
    locale: { register: (ns, dict) => { calls.locale.push({ ns, dict }); return () => {} } },
    slots: {
      inject: (name, fn) => { fn(); return () => {} },
      register: (entryOptions, component) => {
        calls.register.push({ options: entryOptions, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return calls
}

describe('client bundle', () => {
  it('registers a lazy factory under the package name', () => {
    assert.equal(captured.id, 'dsh-simple-cursor')
    assert.equal(typeof factory, 'function')
  })

  it('requires the slot, locale, remote, and credentials Remote namespace', () => {
    assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.credentials'])
  })

  it('registers one Cursor page in the Settings nav', () => {
    const calls = applyWith()
    assert.equal(calls.locale.length, 1)
    assert.equal(calls.locale[0].ns, 'simpleCursor')
    assert.equal(Object.keys(calls.locale[0].dict).sort().join(','), 'en,zh')
    assert.equal(calls.register.length, 1)
    const [entry] = calls.register
    assert.equal(entry.options.name, 'settings.section')
    assert.equal(entry.options.id, 'simple-cursor')
    assert.equal(entry.options.order, 12)
    assert.equal(entry.options.locale, 'simpleCursor')
    assert.equal(entry.options.label, 'Cursor')
    assert.equal(typeof entry.component, 'function')
  })

  it('renders a password field with save and clear controls', () => {
    const { register } = applyWith()
    const Section = register[0].component
    const t = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`)
    const tree = Section({ t })

    const inputs = collect(tree, (node) => node.type === 'input')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].props.type, 'password')
    assert.equal(inputs[0].props.autoComplete, 'off')
    assert.equal(inputs[0].props.spellCheck, false)
    assert.equal(inputs[0].props.placeholder, 'placeholder')

    const buttons = collect(tree, (node) => node.type === 'button')
    assert.equal(buttons.length, 3)
    assert.equal(textOf(buttons[0]), 'save')
    assert.equal(buttons[1].props.type, 'button')
    assert.equal(textOf(buttons[1]), 'clear')
    // Nothing is configured yet, so the destructive and usage actions start disabled.
    assert.equal(buttons[1].props.disabled, true)
    assert.equal(textOf(buttons[2]), 'usageRefresh')
    assert.equal(buttons[2].props.disabled, true)

    const styles = collect(tree, (node) => node.type === 'style')
    assert.match(textOf(styles[0]), /--dsw-alias-button-primary-fill/)
    assert.match(textOf(styles[0]), /--dsw-alias-label-primary-foreground/)
    assert.doesNotMatch(textOf(styles[0]), /color: #fff; background: var\(--dsw-alias-brand-primary\)/)

    const usage = collect(tree, (node) => node.props.className === 'llmc-usage')
    assert.equal(usage.length, 1)
    assert.match(textOf(usage[0]), /usageTitle/)
    assert.match(textOf(usage[0]), /usageLoading/)

    const status = collect(tree, (node) => node.props.role === 'status')
    assert.equal(textOf(status[0]), 'loading')
    assert.equal(collect(tree, (node) => node.props.role === 'alert').length, 0)
  })

  it('renders localized copy through the slot translate function', () => {
    const { locale } = applyWith({})
    const zh = locale[0].dict.zh
    const t = (key, params) => {
      const template = zh[key] ?? key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
    }
    const Section = applyWith().register[0].component
    const tree = Section({ t })
    const text = textOf(tree)
    assert.match(text, /Cursor 账号/)
    assert.doesNotMatch(text, /不写进插件配置/)
    assert.match(text, /Cursor Dashboard → Integrations/)
    assert.doesNotMatch(text, /唯一使用的 Cursor 密钥来源/)
    assert.match(text, /订阅用量/)
    assert.match(text, /正在读取订阅用量/)
  })

  it('contains no unsafe DOM, eval, or browser storage sinks', () => {
    const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(innerHTML|dangerouslySetInnerHTML|document\.write|eval|Function|localStorage|sessionStorage|postMessage|window\.open)\b/)
  })

  it('clears the draft on save, cancels usage fetches on unmount, and ignores stale responses', async () => {
    const states = []
    const refs = []
    const cleanups = []
    let stateIndex = 0
    let refIndex = 0
    const StatefulReact = {
      Fragment: Symbol('fragment'),
      createElement,
      useId: () => 'id-1',
      useRef(initial) {
        const idx = refIndex++
        if (!(idx in refs)) refs[idx] = { current: initial }
        return refs[idx]
      },
      useState(initial) {
        const idx = stateIndex++
        if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial
        return [states[idx], (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next
        }]
      },
      useEffect(fn) {
        if (cleanups.length > 0) return
        const cleanup = fn()
        cleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
      },
      useCallback: (fn) => fn,
    }
    const statefulModule = factory((name) => {
      if (name === 'react') return StatefulReact
      throw new Error(`unexpected require: ${name}`)
    })

    const fetchCalls = []
    const pendingFetch = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
      fetchCalls.push({ url: String(url), init })
      return new Promise((resolve, reject) => {
        pendingFetch.push({ resolve, reject, signal: init?.signal })
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }

    const savedValues = []
    const remote = {
      credentials: {
        async describe() {
          return { ok: true, value: { CURSOR_API_KEY: { configured: true, source: 'managed' } } }
        },
        async set(ref, value) {
          savedValues.push({ ref, value })
          return { ok: true }
        },
        async unset() {
          return { ok: true }
        },
      },
    }
    const calls = { register: [] }
    const ctx = {
      remote,
      get: (name) => (name === 'remote' ? remote : undefined),
      effect: (fn) => { fn() },
      locale: { register: () => () => {} },
      slots: {
        inject: (_name, fn) => { fn(); return () => {} },
        register: (entryOptions, component) => {
          calls.register.push({ options: entryOptions, component })
          return () => {}
        },
      },
    }
    statefulModule.apply(ctx)
    const Section = calls.register[0].component
    const render = () => {
      stateIndex = 0
      refIndex = 0
      return Section({ t: (key) => key })
    }

    try {
      let tree = render()
      await new Promise((resolve) => setTimeout(resolve, 0))
      tree = render()
      const status = collect(tree, (node) => node.props.role === 'status')
      assert.equal(textOf(status[0]), 'configured')
      assert.equal(fetchCalls.length, 1)
      assert.equal(fetchCalls[0].url, '/api/dsh-simple-cursor/usage')
      assert.equal(fetchCalls[0].init.credentials, 'same-origin')
      assert.equal(fetchCalls[0].init.cache, 'no-store')
      assert.equal(fetchCalls[0].init.signal instanceof AbortSignal, true)

      // Trigger a forced refresh while the initial request is still pending.
      tree = render()
      const refreshButton = collect(tree, (node) => node.type === 'button')[2]
      refreshButton.props.onClick()
      assert.equal(pendingFetch[0].signal.aborted, true)
      assert.equal(fetchCalls.length, 2)
      assert.equal(fetchCalls[1].url, '/api/dsh-simple-cursor/usage?refresh=1')

      // Resolve the newer response with 55%, and verify stale/aborted response cannot overwrite it.
      pendingFetch[1].resolve(new Response(JSON.stringify({
        ok: true,
        usage: { plan: { name: 'Pro' }, usage: { totalPercent: 55 }, billingCycle: {} },
      }), { status: 200 }))
      pendingFetch[0].resolve(new Response(JSON.stringify({
        ok: true,
        usage: { plan: { name: 'Pro' }, usage: { totalPercent: 11 }, billingCycle: {} },
      }), { status: 200 }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      tree = render()
      assert.match(textOf(tree), /55%/)
      assert.doesNotMatch(textOf(tree), /11%/)

      // Save clears the draft input and starts a fresh usage refresh; unmount aborts it.
      const input = collect(tree, (node) => node.type === 'input')[0]
      input.props.onChange({ target: { value: '  cursor_test_new  ' } })
      tree = render()
      const form = collect(tree, (node) => node.type === 'form')[0]
      const savePromise = form.props.onSubmit({ preventDefault() {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(savedValues, [{ ref: 'CURSOR_API_KEY', value: 'cursor_test_new' }])
      tree = render()
      assert.equal(collect(tree, (node) => node.type === 'input')[0].props.value, '')

      assert.equal(fetchCalls.length, 3)
      assert.equal(pendingFetch[2].signal.aborted, false)
      cleanups.forEach((fn) => fn())
      assert.equal(pendingFetch[2].signal.aborted, true)
      await savePromise
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
