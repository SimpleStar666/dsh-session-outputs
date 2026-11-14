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
 * Workspace-grouping key (`attachSession` rejects a header cwd that differs
 * from the workspace path, and `candidateMatches` keeps filtering such sessions
 * out of the group), and the root the right-Sidebar file tree lists. Rewriting
 * it would detach the conversation from its Workspace in the sidebar and shrink
 * the sandbox to the output folder. The working directory is the mutable
 * per-conversation root that every file and shell tool actually reads
 * (`ctx.workingDirectory.ensure`), so moving it isolates writes without
 * touching any of those three.
 *
 * Scope (`mode`): by default only the Host's own first-use Workspace is
 * isolated. A project the user added on purpose keeps native behaviour — an
 * agent working on that repository must not be pushed into a subfolder, where
 * relative paths to the project's own files would break.
 *
 * Idempotence: the directory is created once; the working directory is moved
 * only while the conversation is still at its original root, so a manual
 * `working_directory` change is never fought.
 *
 * @module dsh-session-outputs
 */

import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-outputs'

/**
 * The working-directory service is the whole point: without it there is
 * nothing to move. A composition lacking it keeps the plugin inactive instead
 * of throwing at load. `workspaceRegistry` is read optionally.
 */
export const inject = ['workingDirectory']

/** Folder (inside the Session's workspace root) that holds every conversation's output. */
export const OUTPUTS_DIRECTORY = '.dsh-outputs'

/** Which conversations get a folder: only the first-use Workspace, or every one. */
const MODES = ['managed', 'all']

/** Settings accepted from the profile patch row. */
const DEFAULTS = {
  enabled: true,
  directory: OUTPUTS_DIRECTORY,
  isolate: true,
  mode: 'managed',
}

/**
 * Read an optional service without tripping the fiber's undeclared-property
 * guard. `ctx.get` is the sanctioned lookup for a service this plugin may not
 * declare in `inject`.
 *
 * @param {any} ctx - Cordis context.
 * @param {string} serviceName - the service to look up.
 * @returns {any} the service, or undefined when the composition lacks it.
 */
function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Canonicalize a path for comparison. Both sides of a comparison are absolute;
 * a path that cannot be resolved is returned unchanged.
 *
 * @param {string} path - absolute path.
 * @returns {string} the canonical spelling when resolvable.
 */
function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Compare two absolute paths the way the platform's filesystem does.
 * Separator spelling and, on Windows, case do not distinguish two paths; a
 * path that cannot be resolved is compared by its own spelling.
 *
 * @param {string | undefined} left - one absolute path.
 * @param {string | undefined} right - the other absolute path.
 * @returns {boolean} whether they name the same directory.
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length === 0 || right.length === 0) return false
  const flatten = (value) => {
    const unified = canonicalPath(value).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }
  return flatten(left) === flatten(right)
}

/**
 * Report whether a directory is the Workspace the Host created for first use,
 * which is the "everything goes here" bucket this plugin replaces.
 *
 * @param {any} ctx - Cordis context.
 * @param {string} workspacePath - the Session's `header.cwd`.
 * @returns {boolean | undefined} true/false when it can be decided, undefined
 *   when the composition exposes no registry to decide with.
 */
export function isFirstUseWorkspace(ctx, workspacePath) {
  const registry = optionalService(ctx, 'workspaceRegistry')
  const defaultId = registry?.state?.defaultWorkspaceId
  if (typeof defaultId !== 'string') return undefined
  const entity = registry.get(defaultId)
  if (entity === undefined) return undefined
  return samePath(entity.path, workspacePath)
}

/**
 * Normalize the row config without depending on a schema library, so a
 * mistyped value fails loudly here instead of turning into a broken directory.
 *
 * @param {unknown} config - raw config from the profile patch.
 * @returns {{ enabled: boolean, directory: string, isolate: boolean, mode: 'managed' | 'all' }} settings.
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
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode)) {
      throw new TypeError(`session-outputs: \`mode\` must be one of ${MODES.join(', ')}`)
    }
    settings.mode = raw.mode
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
 * Decide whether this Session should get an output folder at all.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ mode: 'managed' | 'all' }} settings - normalized config.
 * @param {any} session - the Session under inspection.
 * @returns {boolean} whether to isolate it.
 */
export function shouldIsolate(ctx, settings, session) {
  if (!isTopLevel(session)) return false
  const workspaceRoot = session?.header?.cwd
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return false
  if (settings.mode === 'all') return true
  // `managed`: only the Host's first-use bucket. A project the user added on
  // purpose keeps native behaviour, because isolating it would break its
  // relative paths. An undecidable answer isolates, matching the plugin's
  // documented purpose.
  return isFirstUseWorkspace(ctx, workspaceRoot) !== false
}

/**
 * Give one conversation its output folder and move its working directory in.
 *
 * Failures are logged and swallowed: a broken output folder must never stop a
 * conversation from being created or resumed.
 *
 * @param {any} ctx - Cordis context carrying `workingDirectory`.
 * @param {{ directory: string, isolate: boolean, mode: 'managed' | 'all' }} settings - normalized config.
 * @param {any} agent - the newly created agent.
 * @param {AbortSignal | undefined} signal - creation cancellation signal.
 * @returns {Promise<string | undefined>} the output directory, when established.
 */
export async function establish(ctx, settings, agent, signal) {
  const session = agent?.session
  if (session === undefined) return undefined
  if (!shouldIsolate(ctx, settings, session)) return undefined
  const workspaceRoot = session.header.cwd
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
    // manual `working_directory` change is respected.
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
  ctx.logger?.info?.(
    `[session-outputs] each conversation gets its own folder under <workspace>/${settings.directory}/ (mode: ${settings.mode})`,
  )
}

/** Exported seams for the unit tests; not part of the plugin contract. */
export const internals = { DEFAULTS, MODES, folderName, isTopLevel, outputDirectoryFor, optionalService }
