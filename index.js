/**
 * dsh-session-outputs — Host half.
 *
 * Every DSH conversation created from the same Workspace shares one directory:
 * the Session's `header.cwd` is the workspace path, so files written by
 * "GitHub 限流脚本" and "Minecraft 整合包工具" end up side by side and you can
 * no longer tell which conversation produced which file.
 *
 * This Host plugin gives each top-level conversation its own output folder
 * inside that Workspace and moves the conversation's *working directory* into
 * it, so relative writes (`write`, `edit`, `bash`, `present`, …) land there:
 *
 *   <workspace>/
 *   ├── .dsh-outputs/
 *   │   ├── session-1a2b3c4d-…/     ← conversation A's files
 *   │   └── session-9f8e7d6c-…/     ← conversation B's files
 *   └── … the project's own files
 *
 * Why the *working directory* and not `header.cwd`:
 * `header.cwd` is immutable and is simultaneously the sandbox write root, the
 * Workspace-grouping key (`activateSession` rejects a header cwd that differs
 * from the workspace path), and the root the right-Sidebar file tree lists.
 * Rewriting it would detach the conversation from its Workspace in the sidebar
 * and shrink the sandbox to the output folder. The working directory is the
 * mutable per-conversation root that every file and shell tool actually reads
 * (`ctx.workingDirectory.ensure`), so moving it isolates writes without
 * touching any of those three.
 *
 * Idempotence: the directory is created once; the working directory is moved
 * only while the conversation is still at its original root, so a manual
 * `working_directory` change, a resume, or a fork is never fought.
 *
 * @module dsh-session-outputs
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-outputs'

/**
 * The working-directory service is the whole point: without it there is
 * nothing to move. A composition lacking it keeps the plugin inactive instead
 * of throwing at load.
 */
export const inject = ['workingDirectory']

/** Folder (inside the Session's workspace root) that holds every conversation's output. */
export const OUTPUTS_DIRECTORY = '.dsh-outputs'

/** Settings accepted from the profile patch row. */
const DEFAULTS = {
  enabled: true,
  directory: OUTPUTS_DIRECTORY,
  isolate: true,
}

/**
 * Normalize the row config without depending on a schema library, so a
 * mistyped value fails loudly here instead of turning into a broken directory.
 *
 * @param {unknown} config - raw config from the profile patch.
 * @returns {{ enabled: boolean, directory: string, isolate: boolean }} settings.
 * @throws {TypeError} when a value has the wrong shape.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('session-outputs: the row config must be a mapping')
  }
  const settings = { ...DEFAULTS }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new TypeError('session-outputs: `enabled` must be a boolean')
    settings.enabled = raw.enabled
  }
  if (raw.isolate !== undefined) {
    if (typeof raw.isolate !== 'boolean') throw new TypeError('session-outputs: `isolate` must be a boolean')
    settings.isolate = raw.isolate
  }
  if (raw.directory !== undefined) {
    if (typeof raw.directory !== 'string' || raw.directory.length === 0) {
      throw new TypeError('session-outputs: `directory` must be a non-empty string')
    }
    // A separator would escape the single folder this plugin owns.
    if (/[\\/]/.test(raw.directory) || raw.directory === '.' || raw.directory === '..') {
      throw new TypeError(`session-outputs: \`directory\` must be one folder name, got ${JSON.stringify(raw.directory)}`)
    }
    settings.directory = raw.directory
  }
  return settings
}

/**
 * Report whether a Session is a top-level conversation this plugin owns.
 * Subagents and forks inherit their parent's working directory, so isolating
 * them would scatter one conversation's files across several folders.
 *
 * @param {{ header: { origin?: string, delegationDepth?: number } }} session - the Session.
 * @returns {boolean} true for an ordinary top-level conversation.
 */
export function isTopLevel(session) {
  const header = session?.header
  if (header === undefined) return false
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

/**
 * The directory name one conversation owns. The full Session id is used so the
 * browser half can derive the same name from `sessionId` alone, with no extra
 * protocol and no chance of two conversations colliding.
 *
 * @param {string} sessionId - the Session id.
 * @returns {string} the folder name.
 */
export function folderName(sessionId) {
  return String(sessionId)
}

/**
 * Absolute output directory of one conversation.
 *
 * @param {string} workspaceRoot - the Session's immutable `header.cwd`.
 * @param {string} directory - configured parent folder name.
 * @param {string} sessionId - the Session id.
 * @returns {string} the absolute directory path.
 */
export function outputDirectoryFor(workspaceRoot, directory, sessionId) {
  return join(workspaceRoot, directory, folderName(sessionId))
}

/**
 * Give one conversation its output folder and move its working directory in.
 *
 * Failures are logged and swallowed: a broken output folder must never stop a
 * conversation from being created or resumed.
 *
 * @param {any} ctx - Cordis context carrying `workingDirectory`.
 * @param {{ directory: string, isolate: boolean }} settings - normalized config.
 * @param {any} agent - the newly created agent.
 * @param {AbortSignal | undefined} signal - creation cancellation signal.
 * @returns {Promise<string | undefined>} the output directory, when established.
 */
export async function establish(ctx, settings, agent, signal) {
  const session = agent?.session
  if (session === undefined || !isTopLevel(session)) return undefined
  const workspaceRoot = session.header?.cwd
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return undefined
  const directory = outputDirectoryFor(workspaceRoot, settings.directory, session.id)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    ctx.logger?.warn?.(`[session-outputs] could not create ${directory}: ${String(error)}`)
    return undefined
  }
  if (!settings.isolate) return directory
  try {
    // Only move a conversation that is still sitting at its original root: a
    // manual `working_directory` change, a resume, or a fork is respected.
    const current = ctx.workingDirectory.get(session)
    if (current === workspaceRoot) await ctx.workingDirectory.set(agent, directory, signal)
  } catch (error) {
    ctx.logger?.warn?.(`[session-outputs] could not move session ${session.id} into ${directory}: ${String(error)}`)
  }
  return directory
}

/**
 * Mount the plugin: one `agent/created` listener for the lifetime of this
 * plugin instance.
 *
 * @param {any} ctx - Cordis context carrying `workingDirectory`.
 * @param {unknown} [config] - profile patch config.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger?.info?.('[session-outputs] disabled by config')
    return
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    const directory = await establish(ctx, settings, agent, signal)
    if (directory !== undefined) {
      ctx.logger?.info?.(`[session-outputs] session ${agent.session.id} outputs at ${directory}`)
    }
  })
  ctx.logger?.info?.(`[session-outputs] each conversation gets its own folder under <workspace>/${settings.directory}/`)
}

/** Exported seams for the unit tests; not part of the plugin contract. */
export const internals = { DEFAULTS, folderName, isTopLevel, outputDirectoryFor }
