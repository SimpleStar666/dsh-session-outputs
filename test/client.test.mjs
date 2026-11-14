/**
 * Browser-half tests. The bundle is authored for the host's ModuleLoader, so
 * this harness provides that global and hands the factory a React stub, then
 * exercises the pure helpers it exports for testing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal React stand-in: the helpers under test never render. */
const ReactStub = {
  createElement: () => undefined,
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useState: (initial) => [initial, () => {}],
}

/** Load the bundle and return its exports. */
function loadBundle() {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, exports: factory(() => ReactStub) }
      },
    },
  }
  // Fresh evaluation on every call: the bundle registers itself as a side effect.
  const path = new URL('../client.js', import.meta.url)
  return import(`${path.href}?t=${Math.random()}`).then(() => {
    delete globalThis.window
    assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load')
    return loaded
  })
}

test('the bundle registers under the package id and declares its services', async () => {
  const { id, exports } = await loadBundle()
  assert.equal(id, 'dsh-session-outputs')
  assert.equal(exports.name, 'session-outputs-client')
  for (const service of ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']) {
    assert.ok(exports.inject.includes(service), `inject must declare ${service}`)
  }
  assert.equal(typeof exports.apply, 'function')
})

test('the tab type id, kind and folder match the Host half', async () => {
  const { exports } = await loadBundle()
  const { ID, KIND, OUTPUTS_DIRECTORY } = exports.__test
  assert.equal(ID, 'dsh-session-outputs')
  assert.equal(KIND, 'session-outputs')
  // The Host half writes into this folder; the panel must read the same one.
  assert.equal(OUTPUTS_DIRECTORY, '.dsh-outputs')
})

test('fileAddress encodes every segment and keeps a drive letter literal', async () => {
  const { exports } = await loadBundle()
  const { fileAddress } = exports.__test

  assert.equal(
    fileAddress('session-abc', '.dsh-outputs/session-abc/report.md'),
    'dsh-resource://file/session/session-abc/.dsh-outputs/session-abc/report.md',
  )
  // Backslashes and a leading ./ are normalized; spaces and # are encoded.
  assert.equal(
    fileAddress('s1', '.dsh-outputs\\s1\\my report #2.md'),
    'dsh-resource://file/session/s1/.dsh-outputs/s1/my%20report%20%232.md',
  )
  // A drive letter keeps its colon so the Host reads it as written.
  assert.equal(fileAddress('s1', 'C:/x/y.txt'), 'dsh-resource://file/session/s1/C:/x/y.txt')
})

test('formatSize is compact and tolerant of missing sizes', async () => {
  const { exports } = await loadBundle()
  const { formatSize } = exports.__test

  assert.equal(formatSize(undefined), '')
  assert.equal(formatSize(-1), '')
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(999), '999 B')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1536), '1.5 KB')
  assert.equal(formatSize(1024 * 1024 * 12), '12 MB')
})

test('collectFiles walks nested folders, skips dotfiles, and reports truncation', async () => {
  const { exports } = await loadBundle()
  const { collectFiles } = exports.__test

  /** A fake Remote listing: path -> entries. */
  const listings = {
    '.dsh-outputs/s1': [
      { name: 'report.md', type: 'file', size: 12 },
      { name: 'data', type: 'directory' },
      { name: '.hidden', type: 'file', size: 1 },
      { name: 'chart.png', type: 'file' },
      { name: 'pipe', type: 'other' },
    ],
    '.dsh-outputs/s1/data': [
      { name: 'sales.csv', type: 'file', size: 100 },
    ],
  }
  const listDir = async (path) => ({ ok: true, value: { path, entries: listings[path] ?? [], truncated: false } })

  const result = await collectFiles(listDir, '.dsh-outputs/s1', new AbortController().signal)
  assert.deepEqual(result.files.map((file) => file.path), [
    '.dsh-outputs/s1/chart.png',
    '.dsh-outputs/s1/data/sales.csv',
    '.dsh-outputs/s1/report.md',
  ])
  assert.equal(result.truncated, false)
})

test('collectFiles surfaces a missing folder as a coded failure', async () => {
  const { exports } = await loadBundle()
  const { collectFiles } = exports.__test

  const listDir = async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'no entry' } })
  await assert.rejects(
    collectFiles(listDir, '.dsh-outputs/s1', new AbortController().signal),
    (error) => error.code === 'workspace-file/not-found',
  )
})

test('collectFiles stops at the entry cap and says so', async () => {
  const { exports } = await loadBundle()
  const { collectFiles } = exports.__test

  const many = Array.from({ length: 900 }, (_, index) => ({ name: `f${index}.md`, type: 'file', size: index }))
  const listDir = async (path) => ({ ok: true, value: { path, entries: many, truncated: false } })
  const result = await collectFiles(listDir, '.dsh-outputs/s1', new AbortController().signal)

  assert.equal(result.files.length, 400)
  assert.equal(result.truncated, true)
})
