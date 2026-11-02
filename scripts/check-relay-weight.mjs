#!/usr/bin/env node
// Fails when sync code lands in what the browser loads before first paint. `npm run build` has
// no relay settings, so `syncEnabled` folds to false and the whole sync engine is tree-shaken
// out: `npm run size` never sees it. This builds again as deployed (dummy VITE_SUPABASE_*
// values) into a temp folder and compares the eager scripts of the two builds: the entry chunk
// and every chunk index.html modulepreloads. The engine and the Supabase SDK must stay lazy.
// It also weighs the boot path: those plus the data engine chunks index.html preloads for the
// first data render (marked data-boot by vite.config.js), which a boot always downloads.
// Run after `npm run build`.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// bytes — the eager sync layer (state, copy, the engine loader) measured 2.2 KB on
// 2026-10-21 (v0.8.4 shipped 3.3 KB of eager sync code), 3.2 KB at 0.9.4 and 3.3 KB at 0.10.0
// (2026-11-01; the v5 core the engine shares with the local engine stays lazy). Raise
// deliberately, with a note.
export const RELAY_EAGER_BUDGET = 4 * 1024

// bytes — what a deployed device downloads at boot for sync beyond a no-relay one: the eager sync
// layer plus the part of the data core that only the sync engine uses, which the relay build puts
// in the chunk the local engine shares with it. 7.8 KB at 0.10.0 (2026-11-01). Raise
// deliberately, with a note.
export const RELAY_BOOT_BUDGET = 12 * 1024

export const NO_BOOT_PRELOAD =
  'index.html does not modulepreload the data engine (a <link rel="modulepreload" data-boot>).\n' +
  'Without it the engine chunk is fetched only after the entry chunk has run, a round trip later\n' +
  'on every boot. vite.config.js (preloadDataEngine) adds it: check that the plugin still runs\n' +
  'and that src/data/local/engine.ts is still a dynamic import.'

export const NO_ENGINE_CHUNK =
  'The relay build has no syncEngine-*.js chunk, so this check is measuring nothing.\n' +
  'The engine is probably imported statically somewhere: src/stores/syncEngine.ts must load\n' +
  'only through loadSyncEngine() in src/stores/useSyncStore.ts (a dynamic import). Look for\n' +
  "`from './syncEngine'` or `from '../stores/syncEngine'` outside type-only imports."

const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/** The modulepreloaded scripts of index.html: the boot path's (data-boot) or the others. */
function preloads(html, boot) {
  const files = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const href = attribute(tag, 'href')
    if (attribute(tag, 'rel') !== 'modulepreload' || !href?.endsWith('.js')) continue
    if ((attribute(tag, 'data-boot') !== undefined) === boot) files.push(href.replace(/^\//, ''))
  }
  return files
}

/**
 * The scripts index.html makes the browser load before first paint: the module entry, then
 * every modulepreload but the boot path's, as paths relative to the build folder. Throws without
 * a module entry.
 */
export function eagerScripts(html) {
  const files = []
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    const src = attribute(tag, 'src')
    if (attribute(tag, 'type') === 'module' && src?.endsWith('.js'))
      files.push(src.replace(/^\//, ''))
  }
  if (files.length === 0) throw new Error('No module entry script in index.html')
  for (const file of preloads(html, false)) if (!files.includes(file)) files.push(file)
  return files
}

/** What every boot downloads before the data shows: the eager scripts and the data engine's. */
export function bootScripts(html) {
  const files = eagerScripts(html)
  for (const file of preloads(html, true)) if (!files.includes(file)) files.push(file)
  return files
}

/** The shape of a build: what it loads eagerly, all the JS it ships, and whether sync is in it. */
export function measure(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  const sized = (file) => ({ file, size: statSync(join(dir, file)).size })
  const eager = eagerScripts(html).map(sized)
  const boot = bootScripts(html).map(sized)
  const scripts = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js'))
  return {
    eager,
    eagerSize: eager.reduce((sum, { size }) => sum + size, 0),
    boot,
    bootSize: boot.reduce((sum, { size }) => sum + size, 0),
    hasBootPreload: boot.length > eager.length,
    totalJs: scripts.reduce((sum, f) => sum + statSync(join(dir, 'assets', f)).size, 0),
    hasEngine: scripts.some((f) => f.startsWith('syncEngine-')),
  }
}

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`

/** The verdict on two builds: the report lines, and the error when the check fails. */
export function compare(base, relay, budget = RELAY_EAGER_BUDGET, bootBudget = RELAY_BOOT_BUDGET) {
  if (!relay.hasEngine) return { lines: [], error: NO_ENGINE_CHUNK }
  if (!base.hasBootPreload || !relay.hasBootPreload) return { lines: [], error: NO_BOOT_PRELOAD }
  const eager = relay.eagerSize - base.eagerSize
  const over = eager > budget
  const boot = relay.bootSize - base.bootSize
  const bootOver = boot > bootBudget
  const added = (m) =>
    m.boot
      .slice(m.eager.length)
      .map((s) => s.file)
      .join(', ')
  const lines = [
    `eager JS (no relay)  ${fmt(base.eagerSize).padStart(10)}  ${base.eager.map((s) => s.file).join(', ')}`,
    `eager JS (relay set) ${fmt(relay.eagerSize).padStart(10)}  ${relay.eager.map((s) => s.file).join(', ')}`,
    `eager sync code      ${fmt(eager).padStart(10)} / ${fmt(budget)}  ${over ? 'FAIL' : 'ok'}`,
    // What every boot downloads before the data shows: the above plus the data engine's chunks.
    `boot JS (no relay)   ${fmt(base.bootSize).padStart(10)}  + ${added(base)}`,
    `boot JS (relay set)  ${fmt(relay.bootSize).padStart(10)}  + ${added(relay)}`,
    `boot sync code       ${fmt(boot).padStart(10)} / ${fmt(bootBudget)}  ${bootOver ? 'FAIL' : 'ok'}`,
    // Information only: what a device with a sync code downloads in all (lazy chunks included).
    `all JS (no relay)    ${fmt(base.totalJs).padStart(10)}`,
    `all JS (deployed)    ${fmt(relay.totalJs).padStart(10)}`,
  ]
  const error = over
    ? 'Sync code grew what loads before first paint (the entry chunk or a modulepreloaded one).\n' +
      'Keep it in the lazy engine (src/stores/syncEngine.ts) or raise RELAY_EAGER_BUDGET in\n' +
      'scripts/check-relay-weight.mjs if intentional.'
    : bootOver
      ? 'Sync code grew what every boot downloads (the data engine chunks index.html preloads).\n' +
        'Keep what only the sync engine needs out of the core the local engine imports, or raise\n' +
        'RELAY_BOOT_BUDGET in scripts/check-relay-weight.mjs if intentional.'
      : null
  return { lines, error }
}

/** Builds into a temp folder with the given relay settings (they override any .env file). */
async function buildWith(url, key) {
  const { build } = await import('vite')
  const out = mkdtempSync(join(tmpdir(), 'spendtrack-relay-'))
  try {
    process.env.VITE_SUPABASE_URL = url
    process.env.VITE_SUPABASE_ANON_KEY = key
    await build({ logLevel: 'warn', build: { outDir: out, emptyOutDir: true } })
    return measure(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

async function main() {
  let base
  try {
    base = measure('dist')
  } catch {
    console.error('No dist/index.html — run `npm run build` first.')
    return 1
  }
  if (base.hasEngine) {
    // dist/ was built with relay settings (a local .env file): measure a clean baseline instead,
    // or the comparison would read about 0 KB of eager sync code whatever the main chunk holds.
    console.log('dist/ was built with relay settings; building a no-relay baseline.')
    base = await buildWith('', '')
  }
  const relay = await buildWith('http://127.0.0.1:59999', 'relay-weight-check')
  const { lines, error } = compare(base, relay)
  for (const line of lines) console.log(line)
  if (error) {
    console.error(`\n${error}`)
    return 1
  }
  return 0
}

function isExecutedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(entry)
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked
  } catch {
    return false
  }
}

if (isExecutedDirectly()) {
  process.exitCode = await main()
}
