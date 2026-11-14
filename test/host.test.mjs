/** Host-half unit tests: config normalization, folder naming, and the establishment rule. */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  establish, folderName, internals, isTopLevel, normalizeConfig, outputDirectoryFor, OUTPUTS_DIRECTORY,
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
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, directory: '.dsh-outputs', isolate: true })
  assert.deepEqual(normalizeConfig({}), { enabled: true, directory: '.dsh-outputs', isolate: true })
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ isolate: false }).isolate, false)
  assert.equal(normalizeConfig({ directory: 'out' }).directory, 'out')

  assert.throws(() => normalizeConfig({ enabled: 'yes' }), TypeError)
  assert.throws(() => normalizeConfig({ isolate: 1 }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '' }), TypeError)
  // A separator would escape the single folder this plugin owns.
  assert.throws(() => normalizeConfig({ directory: 'a/b' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: 'a\\b' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '..' }), TypeError)
  assert.throws(() => normalizeConfig({ directory: '.' }), TypeError)
  assert.throws(() => normalizeConfig([]), TypeError)
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
