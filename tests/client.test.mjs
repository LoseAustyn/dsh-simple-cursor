import assert from 'node:assert/strict'
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
    assert.match(text, /CURSOR_API_KEY/)
    assert.match(text, /凭证服务/)
    assert.match(text, /Cursor Dashboard → Integrations/)
    assert.match(text, /订阅用量/)
    assert.match(text, /正在读取订阅用量/)
    assert.match(text, /这里保存的密钥是插件唯一使用的 Cursor 密钥来源/)
  })
})
