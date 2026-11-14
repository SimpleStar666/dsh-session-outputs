/** Host-half unit tests: config normalization, folder naming, and the establishment rule. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  establish, folderName, internals, isFirstUseWorkspace, isTopLevel, normalizeConfig,
  outputDirectoryFor, OUTPUTS_DIRECTORY, samePath, shouldIsolate,
} from '../index.js'

/** Scratch space beside the tests: the system temp directory is not writable here. */
const SCRATCH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', '.scratch')

/**
 * Create a throwaway directory under the plugin's own test scratch space.
 *
 * @returns {Promise<string>} the new directory's absolute path.
 */
async function scratch() {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(SCRATCH, { recursive: true })
  return mkdtemp(join(SCRATCH, 'run-'))
}

/** A logger that records instead of printing. */
function memoryLogger() {
  const lines = []
  return {
    lines,
    info: (message) => { lines.push(message) },
    warn: (message) => { lines.push(message) },
  }
}

/** A fake Cordis context with a working directory service and a recording logger. */
function fakeContext({ cwdOf = (session) => session.header.cwd } = {}) {
  const sets = []
  const logger = memoryLogger()
  return {
    sets,
    logger,
    ctx: {
      logger,
      workingDirectory: {
        get: (session) => cwdOf(session),
        set: async (agent, path) => {
          sets.push({ sessionId: agent.session.id, path })
          return path
        },
      },
    },
  }
}

/** An agent-shaped object with the header fields the plugin reads. */
function fakeAgent({ id = 'session-1a2b3c4d', cwd, origin, delegationDepth } = {}) {
  return { session: { id, header: { cwd, ...(origin === undefined ? {} : { origin }), ...(delegationDepth === undefined ? {} : { delegationDepth }) } } }
}

test('normalizeConfig applies defaults and rejects malformed values', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, directory: '.dsh-outputs', isolate: true, mode: 'managed' })
  assert.deepEqual(normalizeConfig({}), { enabled: true, directory: '.dsh-outputs', isolate: true, mode: 'managed' })
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ isolate: false }).isolate, false)
  assert.equal(normalizeConfig({ directory: 'out' }).directory, 'out')
  assert.equal(normalizeConfig({ mode: 'all' }).mode, 'all')

  assert.throws(() => normalizeConfig({ enabled: 'yes' }), TypeError)
  assert.throws(() => normalizeConfig({ isolate: 1 }), TypeError)
  assert.throws(() => normalizeConfig({ mode: 'every' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '' }), TypeError)
  // A separator would escape the single folder this plugin owns.
  assert.throws(() => normalizeConfig({ directory: 'a/b' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: 'a\\b' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '..' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '.' }), TypeError)
  assert.throws(() => normalizeConfig([]), TypeError)
})

test('samePath compares the way the platform filesystem does', () => {
  assert.equal(samePath('C:\\a\\b', 'C:/a/b'), true)
  assert.equal(samePath('C:\\a\\b\\', 'C:\\a\\b'), true)
  assert.equal(samePath('C:\\A\\B', 'c:\\a\\b'), process.platform === 'win32')
  assert.equal(samePath('/a/b', '/a/b/'), true)
  assert.equal(samePath('/a/b', '/a/c'), false)
  assert.equal(samePath(undefined, '/a/b'), false)
  assert.equal(samePath('', '/a/b'), false)
})

test('shouldIsolate honours mode and the subagent rule', async () => {
  const root = await scratch()
  try {
    const project = join(root, 'project')
    const other = join(root, 'other')
    await mkdir(project, { recursive: true })
    await mkdir(other, { recursive: true })
    // A registry whose first-use workspace is `project`.
    const registry = {
      state: { defaultWorkspaceId: 'ws-1' },
      get: (id) => (id === 'ws-1' ? { id, path: project } : undefined),
    }
    const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }

    assert.equal(isFirstUseWorkspace(ctx, project), true)
    assert.equal(isFirstUseWorkspace(ctx, other), false)
    // A composition without the registry cannot decide, and must not silently
    // stop isolating the conversations this plugin exists for.
    assert.equal(isFirstUseWorkspace({ get: () => undefined }, project), undefined)

    const inProject = fakeAgent({ cwd: project }).session
    const inOther = fakeAgent({ cwd: other }).session
    const subagent = fakeAgent({ cwd: project, origin: 'subagent' }).session
    const noCwd = fakeAgent({ cwd: undefined }).session

    // managed: only the first-use workspace.
    assert.equal(shouldIsolate(ctx, normalizeConfig(undefined), inProject), true)
    assert.equal(shouldIsolate(ctx, normalizeConfig(undefined), inOther), false)
    // all: every top-level conversation.
    assert.equal(shouldIsolate(ctx, normalizeConfig({ mode: 'all' }), inOther), true)
    // Subagents and sessions without a root are never isolated.
    assert.equal(shouldIsolate(ctx, normalizeConfig({ mode: 'all' }), subagent), false)
    assert.equal(shouldIsolate(ctx, normalizeConfig({ mode: 'all' }), noCwd), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('establish leaves an explicitly added project workspace untouched', async () => {
  const root = await scratch()
  try {
    const project = join(root, 'my-repo')
    const firstUse = join(root, 'default-workspace')
    await mkdir(project, { recursive: true })
    await mkdir(firstUse, { recursive: true })
    const registry = {
      state: { defaultWorkspaceId: 'ws-1' },
      get: (id) => (id === 'ws-1' ? { id, path: firstUse } : undefined),
    }
    const logger = memoryLogger()
    const sets = []
    const ctx = {
      logger,
      get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
      workingDirectory: {
        get: (session) => session.header.cwd,
        set: async (agent, path) => { sets.push(path); return path },
      },
    }

    assert.equal(await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: project }), undefined), undefined)
    assert.deepEqual(sets, [], 'a project the user added must keep its own directory')
    await assert.rejects(stat(join(project, OUTPUTS_DIRECTORY)), { code: 'ENOENT' })

    // The first-use workspace still gets isolated.
    const directory = await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: firstUse }), undefined)
    assert.equal(directory, join(firstUse, OUTPUTS_DIRECTORY, 'session-1a2b3c4d'))
    assert.deepEqual(sets, [directory])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isTopLevel excludes subagents and delegated sessions', () => {
  assert.equal(isTopLevel(fakeAgent({ cwd: '/w' }).session), true)
  assert.equal(isTopLevel(fakeAgent({ cwd: '/w', origin: 'subagent' }).session), false)
  assert.equal(isTopLevel(fakeAgent({ cwd: '/w', delegationDepth: 1 }).session), false)
  assert.equal(isTopLevel(fakeAgent({ cwd: '/w', delegationDepth: 0 }).session), true)
  assert.equal(isTopLevel(undefined), false)
  assert.equal(isTopLevel({}), false)
})

test('outputDirectoryFor puts the folder inside the workspace root', () => {
  const directory = outputDirectoryFor('/work/project', '.dsh-outputs', 'session-abc')
  assert.equal(directory, join('/work/project', '.dsh-outputs', 'session-abc'))
  assert.equal(folderName('session-abc'), 'session-abc')
})

test('establish creates the folder and moves the working directory into it', async () => {
  const root = await scratch()
  try {
    const agent = fakeAgent({ cwd: root })
    const { ctx, sets } = fakeContext()
    const directory = await establish(ctx, normalizeConfig(undefined), agent, undefined)

    assert.equal(directory, join(root, OUTPUTS_DIRECTORY, 'session-1a2b3c4d'))
    assert.deepEqual(sets, [{ sessionId: 'session-1a2b3c4d', path: directory }])
    assert.equal((await stat(directory)).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('establish creates the folder but leaves the directory alone when isolate is false', async () => {
  const root = await scratch()
  try {
    const { ctx, sets } = fakeContext()
    const directory = await establish(ctx, normalizeConfig({ isolate: false }), fakeAgent({ cwd: root }), undefined)

    assert.equal((await stat(directory)).isDirectory(), true)
    assert.deepEqual(sets, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('establish never moves a conversation that already left its root', async () => {
  const root = await scratch()
  try {
    const agent = fakeAgent({ cwd: root })
    // The conversation was manually moved somewhere else earlier.
    const { ctx, sets } = fakeContext({ cwdOf: () => join(root, 'somewhere-else') })
    await establish(ctx, normalizeConfig(undefined), agent, undefined)

    assert.deepEqual(sets, [], 'a manual working-directory change must be respected')
    // The folder is still created: the panel reads it either way.
    assert.equal((await readdir(join(root, OUTPUTS_DIRECTORY))).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('establish skips subagents and sessions without a workspace root', async () => {
  const root = await scratch()
  try {
    const { ctx, sets } = fakeContext()

    assert.equal(await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: root, origin: 'subagent' }), undefined), undefined)
    assert.equal(await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: undefined }), undefined), undefined)
    assert.deepEqual(sets, [])
    // Nothing was created for either.
    await assert.rejects(stat(join(root, OUTPUTS_DIRECTORY)), { code: 'ENOENT' })

    // A file where the outputs folder should be is a logged failure, not a throw.
    await writeFile(join(root, OUTPUTS_DIRECTORY), 'not a directory')
    assert.equal(await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: root }), undefined), undefined)
    assert.ok(ctx.logger.lines.some((line) => line.includes('could not create')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('establish survives a workingDirectory.set rejection', async () => {
  const root = await scratch()
  try {
    const logger = memoryLogger()
    const ctx = {
      logger,
      workingDirectory: {
        get: (session) => session.header.cwd,
        set: async () => { throw new Error('boom') },
      },
    }
    const directory = await establish(ctx, normalizeConfig(undefined), fakeAgent({ cwd: root }), undefined)

    assert.equal(directory, join(root, OUTPUTS_DIRECTORY, 'session-1a2b3c4d'))
    assert.ok(logger.lines.some((line) => line.includes('could not move')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('internals exposes the seams used above', () => {
  assert.equal(internals.DEFAULTS.directory, '.dsh-outputs')
  assert.equal(internals.folderName, folderName)
})
