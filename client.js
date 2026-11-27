/**
 * Browser half of dsh-simple-cursor: the Cursor page under 更多 → 设置.
 *
 * The key is stored through the Host credentials Remote (`credentials.set`),
 * the same store the Host-side adapter reads through `credentials.resolve`, so
 * saving here takes effect on the next model request. No key ever travels back
 * to the browser: the page reads only configured/source/masked facts.
 */

window.__ModuleLoader__.load({
  id: 'dsh-simple-cursor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useId, useState } = React
    const useRef = React.useRef ?? ((initial) => ({ current: initial }))

    /** Locale namespace owned by this plugin. */
    const NS = 'simpleCursor'
    /** Credential reference the Host adapter resolves; the Models page derives the same name. */
    const CREDENTIAL_REF = 'CURSOR_API_KEY'
    /** Authenticated Host route that returns normalized subscription usage. */
    const USAGE_PATH = '/api/dsh-simple-cursor/usage'
    /** Nav position: right after the Models section (models is 10, plugins is 15). */
    const ORDER = 12

    const ZH = {
      nav: 'Cursor',
      title: 'Cursor 账号',
      loading: '正在读取密钥状态…',
      configured: '已配置',
      missing: '未配置',
      unavailable: '这个部署没有可用的凭证服务，无法在这里保存密钥。',
      describeFailed: '读取密钥状态失败：{message}',
      inputLabel: 'Cursor API Key',
      placeholder: 'cursor_…',
      save: '保存',
      saving: '保存中…',
      clear: '清除',
      empty: '先粘贴密钥再保存',
      saved: '已保存。下一次模型请求就会使用它。',
      cleared: '已清除。',
      saveFailed: '保存失败：{message}',
      clearFailed: '清除失败：{message}',
      usageTitle: '订阅用量',
      usageRefresh: '刷新',
      usageLoading: '正在读取订阅用量…',
      usageNotConfigured: '保存密钥后显示订阅用量。',
      usageUnavailable: '当前部署无法读取订阅用量。',
      usageFailed: '读取订阅用量失败：{message}',
      usagePeriodMonthly: '每月',
      usagePeriodWeekly: '每周',
      usageTotal: '总用量',
      usageAuto: 'Auto + Composer',
      usageApi: 'API 模型',
      usageReset: '下次重置：{date}',
      usagePool: '额度池：{total}（基础 {included}，赠送 {bonus}）',
      usageOnDemand: '按量使用：{used} / {limit}',
      usageNoMeter: 'Cursor 没有返回可显示的用量数据。',
      hint: '在 Cursor Dashboard → Integrations 生成密钥。',
    }

    const EN = {
      nav: 'Cursor',
      title: 'Cursor account',
      loading: 'Reading key status…',
      configured: 'Configured',
      missing: 'Not configured',
      unavailable: 'This deployment has no credentials service, so the key cannot be saved here.',
      describeFailed: 'Reading key status failed: {message}',
      inputLabel: 'Cursor API Key',
      placeholder: 'cursor_…',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear',
      empty: 'Paste a key before saving',
      saved: 'Saved. The next model request uses it.',
      cleared: 'Cleared.',
      saveFailed: 'Save failed: {message}',
      clearFailed: 'Clear failed: {message}',
      usageTitle: 'Subscription usage',
      usageRefresh: 'Refresh',
      usageLoading: 'Reading subscription usage…',
      usageNotConfigured: 'Save a key to see subscription usage.',
      usageUnavailable: 'Subscription usage is unavailable in this deployment.',
      usageFailed: 'Reading subscription usage failed: {message}',
      usagePeriodMonthly: 'Monthly',
      usagePeriodWeekly: 'Weekly',
      usageTotal: 'Total usage',
      usageAuto: 'Auto + Composer',
      usageApi: 'API models',
      usageReset: 'Resets: {date}',
      usagePool: 'Usage pool: {total} (included {included}, bonus {bonus})',
      usageOnDemand: 'On-demand: {used} / {limit}',
      usageNoMeter: 'Cursor returned no displayable usage data.',
      hint: 'Mint a key at Cursor Dashboard → Integrations.',
    }

    const CSS = `
.llmc-panel { display: flex; flex-direction: column; gap: 14px; max-width: 620px; }
.llmc-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.llmc-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.llmc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.llmc-dot[data-on='true'] { background: var(--dsw-alias-state-success-primary); }
.llmc-form { display: flex; flex-direction: column; gap: 8px; }
.llmc-label { font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.llmc-row { display: flex; gap: 8px; align-items: center; }
.llmc-input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px; font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; outline: none;
}
.llmc-input:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.llmc-input:disabled { opacity: .6; }
.llmc-button {
  height: 32px; padding: 0 14px; font: inherit; font-size: 12.5px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
}
.llmc-button[data-primary='true'] {
  color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill);
  border-color: transparent;
}
.llmc-button-small { height: 26px; padding: 0 10px; font-size: 11.5px; }
.llmc-button:disabled { opacity: .55; cursor: default; }
.llmc-button:not(:disabled):hover { border-color: var(--dsw-alias-border-l2); filter: brightness(1.05); }
.llmc-hint { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.llmc-notice { margin: 0; font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.llmc-error { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.llmc-usage {
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.llmc-usage-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.llmc-usage-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.llmc-usage-plan { margin: 0; font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.llmc-usage-meta { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.llmc-meter { display: flex; flex-direction: column; gap: 4px; }
.llmc-meter-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11.5px; }
.llmc-meter-label { color: var(--dsw-alias-label-secondary); }
.llmc-meter-value { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.llmc-bar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.llmc-bar-fill { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); }
`

    /**
     * @param {number} percent - raw percentage.
     * @returns {string} one-decimal percentage label.
     */
    function formatPercent(percent) {
      return `${Math.round(percent * 10) / 10}%`
    }

    /**
     * @param {number | null | undefined} cents - amount in cents.
     * @returns {string | undefined} localized USD amount.
     */
    function formatMoney(cents) {
      if (typeof cents !== 'number' || !Number.isFinite(cents)) return undefined
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100)
    }

    /**
     * @param {string | null | undefined} value - ISO timestamp.
     * @returns {string | undefined} localized date and time.
     */
    function formatReset(value) {
      if (typeof value !== 'string' || value.length === 0) return undefined
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
    }

    /**
     * @param {string | null | undefined} period - normalized usage period.
     * @param {(key: string) => string} t - slot translator.
     * @returns {string | undefined} localized period.
     */
    function formatPeriod(period, t) {
      if (period === 'monthly') return t('usagePeriodMonthly')
      if (period === 'weekly') return t('usagePeriodWeekly')
      return undefined
    }

    /**
     * @param {string} label - meter label.
     * @param {number | null | undefined} percent - meter percentage.
     * @param {string} key - React key.
     * @returns {object | null} one meter element.
     */
    function usageMeter(label, percent, key) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
      const width = Math.max(0, Math.min(100, percent))
      return h('div', { className: 'llmc-meter', key },
        h('div', { className: 'llmc-meter-row' },
          h('span', { className: 'llmc-meter-label' }, label),
          h('span', { className: 'llmc-meter-value' }, formatPercent(percent))),
        h('div', { className: 'llmc-bar', 'aria-hidden': true },
          h('span', { className: 'llmc-bar-fill', style: { width: `${width}%` } })))
    }

    /**
     * Build the section component bound to the Host credential operations.
     * @param ops - describe/save/clear callbacks over the Remote.
     * @returns React component for the `settings.section` slot.
     */
    function createSection(ops) {
      return function CursorSettings(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const inputId = useId()
        const mountedRef = useRef(true)
        const usageSeqRef = useRef(0)
        const usageAbortRef = useRef(null)
        const [credential, setCredential] = useState(undefined)
        const [ready, setReady] = useState(false)
        const [busy, setBusy] = useState(false)
        const [draft, setDraft] = useState('')
        const [notice, setNotice] = useState(undefined)
        const [error, setError] = useState(undefined)
        const [usageState, setUsageState] = useState('loading')
        const [usage, setUsage] = useState(undefined)
        const [usageError, setUsageError] = useState(undefined)

        const loadUsage = useCallback(async (force = false) => {
          usageAbortRef.current?.abort()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          usageAbortRef.current = controller
          const seq = usageSeqRef.current + 1
          usageSeqRef.current = seq
          setUsageState('loading')
          setUsageError(undefined)
          const result = await ops.usage(force, controller?.signal)
          if (!mountedRef.current || seq !== usageSeqRef.current || result.aborted === true) return
          if (usageAbortRef.current === controller) usageAbortRef.current = null
          if (!result.ok) {
            setUsage(undefined)
            setUsageError(result.message ?? '')
            setUsageState('error')
            return
          }
          setUsage(result.usage)
          setUsageState('ready')
        }, [])

        const refresh = useCallback(async () => {
          const result = await ops.describe()
          if (!mountedRef.current) return
          setReady(true)
          if (result.ok) {
            setCredential(result.credential)
            setError(undefined)
            if (result.credential?.configured === true) await loadUsage()
            else {
              usageAbortRef.current?.abort()
              usageAbortRef.current = null
              usageSeqRef.current += 1
              setUsage(undefined)
              setUsageState('unconfigured')
              setUsageError(undefined)
            }
          } else {
            usageAbortRef.current?.abort()
            usageAbortRef.current = null
            usageSeqRef.current += 1
            setCredential(undefined)
            setUsage(undefined)
            setUsageState('unavailable')
            setUsageError(undefined)
            setError(t(result.code ?? 'describeFailed', { message: result.message ?? '' }))
          }
        }, [loadUsage, t])

        useEffect(() => {
          mountedRef.current = true
          void refresh()
          return () => {
            mountedRef.current = false
            usageAbortRef.current?.abort()
            usageAbortRef.current = null
          }
        }, [refresh])

        const onSubmit = useCallback(async (event) => {
          event.preventDefault()
          const value = draft.trim()
          if (value.length === 0) { setError(t('empty')); return }
          setBusy(true); setError(undefined); setNotice(undefined)
          const failure = await ops.save(value)
          if (!mountedRef.current) return
          setBusy(false)
          if (failure !== undefined) { setError(t('saveFailed', { message: failure })); return }
          setDraft('')
          setNotice(t('saved'))
          await refresh()
        }, [draft, refresh, t])

        const onClear = useCallback(async () => {
          setBusy(true); setError(undefined); setNotice(undefined)
          const failure = await ops.clear()
          if (!mountedRef.current) return
          setBusy(false)
          if (failure !== undefined) { setError(t('clearFailed', { message: failure })); return }
          setNotice(t('cleared'))
          await refresh()
        }, [refresh, t])

        const configured = credential !== undefined && credential.configured === true
        const statusText = !ready
          ? t('loading')
          : configured
            ? t('configured')
            : t('missing')

        let usageContent
        if (usageState === 'loading') {
          usageContent = h('p', { className: 'llmc-usage-meta', role: 'status' }, t('usageLoading'))
        } else if (usageState === 'error') {
          usageContent = h('p', { className: 'llmc-error', role: 'alert' }, t('usageFailed', { message: usageError ?? '' }))
        } else if (usageState === 'unconfigured') {
          usageContent = h('p', { className: 'llmc-usage-meta' }, t('usageNotConfigured'))
        } else if (usageState === 'unavailable') {
          usageContent = h('p', { className: 'llmc-usage-meta' }, t('usageUnavailable'))
        } else if (usage !== undefined) {
          const details = usage.usage ?? {}
          const plan = usage.plan ?? {}
          const planParts = []
          if (typeof plan.name === 'string' && plan.name.length > 0) planParts.push(plan.name)
          if (typeof plan.price === 'string' && plan.price.length > 0) planParts.push(plan.price)
          const period = formatPeriod(plan.period, t)
          if (period !== undefined) planParts.push(period)
          const reset = formatReset(usage.billingCycle?.end)
          const total = formatMoney(details.poolCents)
          const included = formatMoney(details.includedCents)
          const bonus = formatMoney(details.bonusCents)
          const onDemandUsed = formatMoney(details.onDemand?.usedCents)
          const onDemandLimit = formatMoney(details.onDemand?.limitCents)
          const meters = [
            usageMeter(t('usageTotal'), details.totalPercent, 'total'),
            usageMeter(t('usageAuto'), details.autoPercent, 'auto'),
            usageMeter(t('usageApi'), details.apiPercent, 'api'),
          ].filter((item) => item !== null)
          usageContent = h(React.Fragment, null,
            planParts.length > 0 ? h('p', { className: 'llmc-usage-plan' }, planParts.join(' · ')) : null,
            ...meters,
            total !== undefined && included !== undefined && bonus !== undefined
              ? h('p', { className: 'llmc-usage-meta' }, t('usagePool', { total, included, bonus }))
              : null,
            onDemandUsed !== undefined && onDemandLimit !== undefined
              ? h('p', { className: 'llmc-usage-meta' }, t('usageOnDemand', { used: onDemandUsed, limit: onDemandLimit }))
              : null,
            reset === undefined ? null : h('p', { className: 'llmc-usage-meta' }, t('usageReset', { date: reset })),
            meters.length === 0 && total === undefined && reset === undefined
              ? h('p', { className: 'llmc-usage-meta' }, t('usageNoMeter'))
              : null)
        } else {
          usageContent = h('p', { className: 'llmc-usage-meta' }, t('usageNotConfigured'))
        }

        return h(React.Fragment, null,
          h('style', { key: 'styles' }, CSS),
          h('section', { className: 'llmc-panel', 'aria-label': t('title') },
            h('h3', { className: 'llmc-title' }, t('title')),
            h('p', { className: 'llmc-status', role: 'status' },
              h('span', { className: 'llmc-dot', 'data-on': configured ? 'true' : 'false', 'aria-hidden': true }),
              statusText),
            h('form', { className: 'llmc-form', onSubmit: onSubmit },
              h('label', { className: 'llmc-label', htmlFor: inputId }, t('inputLabel')),
              h('div', { className: 'llmc-row' },
                h('input', {
                  id: inputId,
                  className: 'llmc-input',
                  type: 'password',
                  value: draft,
                  placeholder: t('placeholder'),
                  autoComplete: 'off',
                  spellCheck: false,
                  disabled: busy,
                  onChange: (event) => { setDraft(event.target.value); setNotice(undefined); setError(undefined) },
                }),
                h('button', {
                  type: 'submit',
                  className: 'llmc-button',
                  'data-primary': 'true',
                  disabled: busy || draft.trim().length === 0,
                }, busy ? t('saving') : t('save')),
                h('button', {
                  type: 'button',
                  className: 'llmc-button',
                  disabled: busy || !configured,
                  onClick: onClear,
                }, t('clear')))),
            notice === undefined ? null : h('p', { className: 'llmc-notice', role: 'status' }, notice),
            error === undefined ? null : h('p', { className: 'llmc-error', role: 'alert' }, error),
            h('p', { className: 'llmc-hint' }, t('hint')),
            h('section', { className: 'llmc-usage', 'aria-label': t('usageTitle') },
              h('div', { className: 'llmc-usage-head' },
                h('h4', { className: 'llmc-usage-title' }, t('usageTitle')),
                h('button', {
                  type: 'button',
                  className: 'llmc-button llmc-button-small',
                  disabled: busy || !configured || usageState === 'loading',
                  onClick: () => { void loadUsage(true) },
                }, t('usageRefresh'))),
              usageContent)))
      }
    }

    /**
     * Host credential operations over the browser Remote client.
     * @param ctx - client root context.
     * @returns callbacks for the section component.
     */
    function createOperations(ctx) {
      return {
        async describe() {
          try {
            const response = await ctx.remote.credentials.describe([CREDENTIAL_REF])
            if (!response.ok) return { ok: false, code: 'describeFailed', message: response.error.message }
            return { ok: true, credential: response.value === undefined ? undefined : response.value[CREDENTIAL_REF] }
          } catch (error) {
            return { ok: false, code: 'describeFailed', message: error instanceof Error ? error.message : String(error) }
          }
        },
        async save(value) {
          try {
            const response = await ctx.remote.credentials.set(CREDENTIAL_REF, value)
            return response.ok ? undefined : response.error.message
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        },
        async clear() {
          try {
            const response = await ctx.remote.credentials.unset(CREDENTIAL_REF)
            return response.ok ? undefined : response.error.message
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        },
        async usage(force = false, signal) {
          try {
            const response = await fetch(force ? `${USAGE_PATH}?refresh=1` : USAGE_PATH, {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              ...(signal === undefined ? {} : { signal }),
            })
            let payload
            try { payload = await response.json() } catch { payload = undefined }
            if (!response.ok) {
              return {
                ok: false,
                code: payload?.error?.code,
                message: payload?.error?.message ?? `HTTP ${response.status}`,
              }
            }
            if (payload?.ok !== true || payload.usage === undefined) {
              return { ok: false, code: 'usageUnavailable', message: 'invalid usage response' }
            }
            return { ok: true, usage: payload.usage }
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
              return { ok: false, aborted: true }
            }
            return { ok: false, code: 'usageUnavailable', message: error instanceof Error ? error.message : String(error) }
          }
        },
      }
    }

    return {
      // `remote` alone only exposes the namespace dispatcher. Cordis also
      // requires an explicit `remote.credentials` inject before that namespace
      // property may be read (otherwise the access throws at call time).
      // Include both, matching the other credential-backed settings pages.
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],
      apply(ctx) {
        const ops = createOperations(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-simple-cursor: dictionaries')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'simple-cursor',
          order: ORDER,
          label: ZH.nav,
          locale: NS,
        }, createSection(ops))), 'dsh-simple-cursor: settings section')
      },
    }
  },
})
