/**
 * dsh-session-outputs — browser half.
 *
 * Adds one right-Sidebar tab type, `session-outputs`, that lists the files this
 * conversation produced. The Host half creates `<workspace>/.dsh-outputs/<sessionId>/`
 * and moves the conversation's working directory into it; this panel reads that
 * folder through the existing `workspaceFiles` Remote, addressed as a path
 * relative to the Session's workspace root (the Remote resolves relative paths
 * against the root it holds for the Session and refuses anything outside it).
 *
 * Written as a hand-authored ModuleLoader bundle: no build step, no dependency
 * beyond the `react` the shell already provides. Colours come from theme
 * variables so the panel follows a light/dark switch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-outputs',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'sessionOutputs'
    const KIND = 'session-outputs'
    const ID = 'dsh-session-outputs'
    /** Must match `OUTPUTS_DIRECTORY` in the Host half. */
    const OUTPUTS_DIRECTORY = '.dsh-outputs'
    /** Depth and count caps keep one pathological folder from freezing the panel. */
    const MAX_DEPTH = 6
    const MAX_ENTRIES = 400

    const DICT = {
      zh: {
        'type.label': '本对话产物',
        'guide.title': '本对话产物',
        'guide.description': '只看这次对话产出的文件',
        'empty.title': '这个对话还没有产出文件',
        'empty.body': '之后它写下的文件会出现在这里，集中放在自己的产物文件夹下，不会和其他对话混在一起。',
        'empty.hint': '产物目录：{path}',
        reload: '刷新',
        open: '打开',
        truncated: '内容较多，只显示前 {count} 项。',
        'error.outside': '产物文件夹不在当前工作区内。',
        'error.other': '读取产物文件夹失败：{message}',
        count: '{count} 个文件',
        noWorkspace: '这个对话没有工作目录，无法定位产物文件夹。',
      },
      en: {
        'type.label': 'This conversation',
        'guide.title': 'This conversation',
        'guide.description': 'Only the files this conversation produced',
        'empty.title': 'No files yet',
        'empty.body': 'Files this conversation writes show up here, kept in their own outputs folder instead of mixing with other conversations.',
        'empty.hint': 'Outputs folder: {path}',
        reload: 'Reload',
        open: 'Open',
        truncated: 'Showing the first {count} entries.',
        'error.outside': 'The outputs folder is outside the current workspace.',
        'error.other': 'Could not read the outputs folder: {message}',
        count: '{count} files',
        noWorkspace: 'This conversation has no working directory, so there is no outputs folder to show.',
      },
    }

    const CSS = `
.dsso{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#111);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.dsso-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));flex:none}
.dsso-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
.dsso-count{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsso-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;box-sizing:border-box;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsso-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsso-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.dsso-list{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0}
.dsso-row{display:flex;align-items:baseline;gap:8px;width:100%;box-sizing:border-box;padding:4px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsso-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsso-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:-2px}
.dsso-row[aria-disabled="true"]{cursor:default;color:var(--dsw-alias-label-tertiary,#888)}
.dsso-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsso-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.dsso-status{padding:14px 12px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888)}
.dsso-status p{margin:0 0 6px}
.dsso-status p:last-child{margin-bottom:0}
.dsso-title{color:var(--dsw-alias-label-primary,#111);font-weight:600;margin-bottom:4px!important}
.dsso-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;word-break:break-all}
.dsso-note{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
`

    /**
     * Format a byte size for a compact list.
     *
     * @param {number | undefined} bytes - the size reported by the listing.
     * @returns {string} the formatted size, or an empty string when unknown.
     */
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    /**
     * Build the `dsh-resource://file/session/…` address of a workspace-relative
     * path. Mirrors `sessionFileAddress`: every segment is component-encoded and
     * `:` stays literal so a drive letter reads as written.
     *
     * @param {string} sessionId - the Session that resolves the path.
     * @param {string} path - workspace-relative `/`-separated path.
     * @returns {string} the resource address.
     */
    function fileAddress(sessionId, path) {
      const encode = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
    }

    /**
     * Read one directory through the bound Remote read.
     *
     * @param {(path: string, signal: AbortSignal) => Promise<any>} listDir - bound Remote read.
     * @param {string} path - workspace-relative path.
     * @param {AbortSignal} signal - cancellation for this read.
     * @returns {Promise<{ entries: any[], truncated: boolean }>} the listing.
     */
    async function readDirectory(listDir, path, signal) {
      const result = await listDir(path, signal)
      if (!result || result.ok !== true) {
        const error = result && result.error
        const failure = new Error(
          error && typeof error === 'object' && error.message !== undefined ? String(error.message) : 'list failed',
        )
        failure.code = error && typeof error === 'object' ? error.code : undefined
        throw failure
      }
      return result.value
    }

    /**
     * Walk the outputs folder breadth-first, bounded by depth and entry count.
     *
     * @param {(path: string, signal: AbortSignal) => Promise<any>} listDir - bound Remote read.
     * @param {string} root - workspace-relative folder to walk.
     * @param {AbortSignal} signal - cancellation.
     * @returns {Promise<{ files: { name: string, path: string, size?: number }[], truncated: boolean }>} the files found.
     */
    async function collectFiles(listDir, root, signal) {
      const files = []
      let truncated = false
      let frontier = [{ path: root, depth: 0 }]
      while (frontier.length > 0) {
        const next = []
        for (const level of frontier) {
          if (files.length >= MAX_ENTRIES) {
            truncated = true
            break
          }
          const listing = await readDirectory(listDir, level.path, signal)
          if (listing.truncated) truncated = true
          for (const entry of listing.entries) {
            if (typeof entry.name === 'string' && entry.name.startsWith('.')) continue
            const childPath = `${level.path}/${entry.name}`
            if (entry.type === 'directory') {
              if (level.depth + 1 <= MAX_DEPTH) next.push({ path: childPath, depth: level.depth + 1 })
              else truncated = true
              continue
            }
            if (entry.type !== 'file') continue
            if (files.length >= MAX_ENTRIES) {
              truncated = true
              break
            }
            files.push({ name: entry.name, path: childPath, size: entry.size })
          }
        }
        if (truncated && files.length >= MAX_ENTRIES) break
        frontier = next
      }
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files, truncated }
    }

    /**
     * The panel body: this conversation's own output files.
     *
     * @param {any} props - composed slot props (owner, standard, inject face, locale).
     * @returns {any} the rendered panel.
     */
    function SessionOutputsBody(props) {
      const { t, listDir, canOpen } = props
      const sessionId = props.sessionId
      const tabInfo = props.useTabInfo()
      const cwd = props.useSessions((sessions) => {
        const byId = sessions && sessions.byId
        const summary = byId ? byId[sessionId] : undefined
        return summary ? summary.cwd : undefined
      })
      const [state, setState] = useState({ status: 'loading' })
      const [tick, setTick] = useState(0)

      const root = `${OUTPUTS_DIRECTORY}/${sessionId}`
      const tabActions = tabInfo.tab.actions
      const panelId = tabInfo.panel.id

      useEffect(() => {
        if (cwd === undefined || cwd === '') {
          setState({ status: 'no-workspace' })
          return undefined
        }
        const controller = new AbortController()
        let alive = true
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        collectFiles(listDir, root, controller.signal)
          .then((result) => {
            if (!alive || controller.signal.aborted) return
            setState({ status: 'ready', files: result.files, truncated: result.truncated })
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return
            // A conversation that has not written anything yet has no folder;
            // that is the ordinary empty state, not a failure.
            if (error && error.code === 'workspace-file/not-found') setState({ status: 'missing' })
            else setState({ status: 'error', code: error && error.code, message: String((error && error.message) || error) })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [cwd, root, listDir, tick])

      const open = useCallback((path) => {
        tabActions.openResource(fileAddress(sessionId, path), { paneId: panelId })
      }, [sessionId, tabActions, panelId])

      const reload = useCallback(() => setTick((value) => value + 1), [])

      const count = state.status === 'ready' ? state.files.length : undefined
      const header = h('div', { className: 'dsso-head' },
        h('span', {
          className: 'dsso-path',
          title: cwd === undefined ? '' : `${cwd.replace(/[\\/]+$/, '')}\\${OUTPUTS_DIRECTORY}\\${sessionId}`,
        }, `${OUTPUTS_DIRECTORY}/${sessionId}`),
        count === undefined ? null : h('span', { className: 'dsso-count' }, t('count', { count })),
        h('button', { type: 'button', className: 'dsso-btn', onClick: reload, title: t('reload') }, t('reload')))

      if (state.status === 'no-workspace') {
        return h('div', { className: 'dsso' }, header,
          h('div', { className: 'dsso-status' }, h('p', null, t('noWorkspace'))))
      }
      if (state.status === 'loading') {
        return h('div', { className: 'dsso' }, header,
          h('div', { className: 'dsso-status' }, h('p', null, t('empty.hint', { path: root }))))
      }
      if (state.status === 'missing' || (state.status === 'ready' && state.files.length === 0)) {
        return h('div', { className: 'dsso' }, header,
          h('div', { className: 'dsso-status' },
            h('p', { className: 'dsso-title' }, t('empty.title')),
            h('p', null, t('empty.body')),
            h('p', { className: 'dsso-code' }, t('empty.hint', { path: root }))))
      }
      if (state.status === 'error') {
        const message = state.code === 'workspace-file/outside-workspace'
          ? t('error.outside')
          : t('error.other', { message: state.message })
        return h('div', { className: 'dsso' }, header,
          h('div', { className: 'dsso-status' }, h('p', { role: 'alert' }, message)))
      }
      return h('div', { className: 'dsso' },
        header,
        h('div', { className: 'dsso-list' },
          state.files.map((file) => {
            const openable = canOpen(file.path)
            return h('button', {
              key: file.path,
              type: 'button',
              className: 'dsso-row',
              title: file.path,
              'aria-label': `${t('open')}: ${file.path}`,
              'aria-disabled': openable ? undefined : 'true',
              disabled: !openable,
              onClick: openable ? () => open(file.path) : undefined,
            },
              h('span', { className: 'dsso-name' }, file.path),
              h('span', { className: 'dsso-size' }, formatSize(file.size)))
          })),
        state.truncated ? h('div', { className: 'dsso-note' }, t('truncated', { count: MAX_ENTRIES })) : null)
    }

    /**
     * Mount the browser half: the tab type, its body, and its copy.
     *
     * @param {any} ctx - client Cordis context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'session-outputs: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'session-outputs: styles')

      // Stage one: what the type IS. A page type claims no address, so it
      // carries no patterns; the guide entry gives the panel an entry point.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [{
          id: 'outputs',
          order: 20,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
        }],
      }), 'session-outputs: tab type')

      // Stage two: the body, keyed by the definition's id.
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: (sessionId) => ({
          // Bound to this Session: the Host resolves the relative path against
          // the Session's own workspace root and refuses anything outside it.
          listDir: (path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal),
          // Offer to open only files that some registered viewer claims.
          canOpen: (path) => {
            try {
              return ctx.sidebarRightTabs.candidates(fileAddress(sessionId, path)).length > 0
            } catch {
              return true
            }
          },
        }),
      }, SessionOutputsBody)), 'session-outputs: tab body')
    }

    exports.name = 'session-outputs-client'
    exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']
    exports.apply = apply
    exports.__test = { fileAddress, formatSize, collectFiles, KIND, ID, OUTPUTS_DIRECTORY }
    return module.exports
  },
})
