/**
 * End-to-end smoke check against the real plugin files on disk: mount the Host
 * half the way the Loader does, fire one `agent/created`, and assert the folder
 * plus the working-directory move actually happened.
 *
 * Run with `node tools/smoke.mjs`. Writes only under the plugin's own test
 * scratch space and removes it afterwards.
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = join(root, 'test', '.scratch', 'smoke')

/** One fake Cordis context that behaves like the real one for this plugin. */
function mount() {
  const listeners = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(fn, _label) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    workingDirectory: {
      get: (session) => session.__cwd ?? session.header.cwd,
      async set(agent, path) {
        agent.session.__cwd = path
        return path
      },
    },
  }
  return { ctx, listeners, effects, logs }
}

/**
 * Fire one lifecycle event the way the harness dispatches it.
 *
 * @param {Map<string, Function>} listeners - the plugin's registered listeners.
 * @param {string} event - event name.
 * @param {object} payload - dispatch payload.
 */
async function fire(listeners, event, payload) {
  const handler = listeners.get(event)
  assert.ok(handler, `the plugin must subscribe to ${event}`)
  await handler(payload)
}

const { ctx, listeners, logs } = mount()

assert.equal(name, 'session-outputs')
assert.ok(inject.includes('workingDirectory'), 'the Host half requires the working directory service')

apply(ctx, undefined)
assert.ok(listeners.has('agent/created'), 'apply must subscribe to agent/created')

await mkdir(scratch, { recursive: true })
try {
  const workspace = join(scratch, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'existing.txt'), 'the project’s own file')

  // One ordinary conversation, one subagent, and one resumed conversation.
  const conversation = { session: { id: 'session-aaaa1111', header: { cwd: workspace } } }
  await fire(listeners, 'agent/created', { agent: conversation, source: 'startup' })

  const expected = join(workspace, '.dsh-outputs', 'session-aaaa1111')
  assert.equal((await stat(expected)).isDirectory(), true, 'the conversation must get its own folder')
  assert.equal(conversation.session.__cwd, expected, 'its working directory must move into that folder')

  // The project's own files are untouched.
  assert.equal((await readdir(workspace)).includes('existing.txt'), true)

  // A subagent inherits the parent directory instead of scattering files.
  const subagent = { session: { id: 'session-bbbb2222', header: { cwd: workspace, origin: 'subagent' } } }
  await fire(listeners, 'agent/created', { agent: subagent, source: 'subagent' })
  assert.equal(subagent.session.__cwd, undefined, 'a subagent must not be isolated')

  // A resume must not fight a directory the conversation already chose.
  const resumed = { session: { id: 'session-cccc3333', header: { cwd: workspace } } }
  resumed.session.__cwd = '/somewhere/the-user-chose'
  await fire(listeners, 'agent/created', { agent: resumed, source: 'resume' })
  assert.equal(resumed.session.__cwd, '/somewhere/the-user-chose', 'a manual directory must be respected')

  // What the panel will list: the conversation's folder, via a relative path.
  assert.deepEqual((await readdir(expected)).length, 0, 'a fresh folder starts empty')

  // Files the model writes land in the folder, which is what the panel reads.
  await writeFile(join(expected, 'report.md'), '# report')
  assert.deepEqual(await readdir(expected), ['report.md'])

  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('session-aaaa1111')))
  console.log('ok   a conversation gets <workspace>/.dsh-outputs/<sessionId>/ and its working directory moves in')
  console.log('ok   a subagent is left alone; a resumed conversation keeps the directory it chose')
  console.log('ok   the project’s own files are untouched and the panel folder starts empty')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
