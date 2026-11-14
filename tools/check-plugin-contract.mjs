/**
 * Distribution contract check: the things a bundle must satisfy before a
 * profile can load it, and that a mistake here is silent rather than loud.
 * Run with `node tools/check-plugin-contract.mjs`.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const checks = []

/**
 * Record one check.
 *
 * @param {string} label - what was checked.
 * @param {() => void | Promise<void>} body - the assertion(s).
 */
async function check(label, body) {
  try {
    await body()
    checks.push(`ok   ${label}`)
  } catch (error) {
    problems.push(`FAIL ${label}: ${error.message}`)
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await check('manifest declares a bundle patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must name the patch file')
})

await check('manifest declares the browser half', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"')
  assert.equal(pkg.dsh?.client?.immediately, true, 'dsh.client.immediately must be true so the tab type exists at boot')
})

await check('every declared client inject is a string', () => {
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject must list the client services the bundle needs')
  for (const entry of inject) assert.equal(typeof entry, 'string')
})

await check('exports name the runtime files', () => {
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.exports['./locale/*.json'], 'locale exports are what the plugin list reads')
  assert.ok(pkg.exports['./icon'], 'the icon export is what the plugin list draws')
})

await check('the bundle is named after its package, as the module loader requires', async () => {
  const client = await readFile(join(root, 'client.js'), 'utf8')
  assert.match(client, new RegExp(`id:\\s*'${pkg.name}'`), `client.js must load under the module id ${pkg.name}`)
})

await check('the patch inserts exactly this package', async () => {
  const patch = await readFile(join(root, pkg.dsh.bundle.patch), 'utf8')
  assert.match(patch, /- insert:/)
  assert.ok(patch.includes(`name: ${pkg.name}`), `the patch must insert ${pkg.name}`)
})

await check('both locales carry the display metadata', async () => {
  for (const locale of ['zh', 'en']) {
    const file = join(root, 'locale', `${locale}.json`)
    assert.ok(existsSync(file), `locale/${locale}.json must exist`)
    const meta = JSON.parse(await readFile(file, 'utf8')).meta
    assert.equal(typeof meta.title, 'string')
    assert.ok(meta.title.length > 0, `${locale} title must not be empty`)
    assert.equal(typeof meta.description, 'string')
    assert.ok(meta.description.length > 40, `${locale} description must explain what the plugin does`)
    assert.ok(existsSync(join(root, meta.detail)), `${locale} detail document must exist`)
  }
})

await check('the icon is a self-contained SVG of the documented size', async () => {
  const icon = await readFile(join(root, pkg.exports['./icon']), 'utf8')
  assert.match(icon, /<svg[^>]*width="36"[^>]*height="36"/, 'icons are drawn at 36x36')
  for (const banned of ['<script', 'onload=', '<style', 'foreignObject', '<image', '<animate']) {
    assert.ok(!icon.includes(banned), `icons must not contain ${banned}`)
  }
})

await check('the host half exports the cordis contract', async () => {
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(typeof host.name, 'string')
  assert.equal(host.name, 'session-outputs')
  assert.ok(Array.isArray(host.inject), 'inject must be an array')
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.normalizeConfig, 'function')
})

await check('the settings documented in the README are the ones the host accepts', async () => {
  const host = await import(new URL('../index.js', import.meta.url))
  const settings = host.normalizeConfig(undefined)
  assert.deepEqual(Object.keys(settings).sort(), ['directory', 'enabled', 'isolate'])
})

await check('the client half is syntactically valid', async () => {
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', join(root, 'client.js')], (error) => (error ? reject(error) : resolve()))
  })
})

for (const line of checks) console.log(line)
if (problems.length > 0) {
  for (const line of problems) console.error(line)
  process.exitCode = 1
} else {
  console.log(`\n${checks.length} checks passed`)
}
