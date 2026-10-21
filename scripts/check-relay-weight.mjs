#!/usr/bin/env node
// Fails when sync code lands in the main chunk. `npm run build` has no relay settings, so
// `syncEnabled` folds to false and the whole sync engine is tree-shaken out: `npm run size`
// never sees it. This builds again as deployed (dummy VITE_SUPABASE_* values) into a temp
// folder and compares the two entry chunks. The engine and the Supabase SDK must stay lazy.
// Run after `npm run build`.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'

// bytes — the eager sync layer (state, copy, the engine loader) measured 2.2 KB on
// 2026-10-21 (v0.8.4 shipped 3.3 KB of eager sync code). Raise deliberately, with a note.
const RELAY_EAGER_BUDGET = 4 * 1024

/** The entry chunk index.html loads, in bytes. */
function entrySize(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  const src = /<script[^>]+type="module"[^>]+src="\/([^"]+\.js)"/.exec(html)?.[1]
  if (!src) throw new Error(`No module entry script in ${dir}/index.html`)
  return { file: src, size: statSync(join(dir, src)).size }
}

/** The shape of a build: its entry chunk, all the JS it ships, and whether sync is in it. */
function measure(dir) {
  const scripts = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js'))
  return {
    entry: entrySize(dir),
    totalJs: scripts.reduce((sum, f) => sum + statSync(join(dir, 'assets', f)).size, 0),
    hasEngine: scripts.some((f) => f.startsWith('syncEngine-')),
  }
}

/** Builds into a temp folder with the given relay settings (they override any .env file). */
async function buildWith(url, key) {
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

let base
try {
  base = measure('dist')
} catch {
  console.error('No dist/index.html — run `npm run build` first.')
  process.exit(1)
}
if (base.hasEngine) {
  // dist/ was built with relay settings (a local .env file): measure a clean baseline instead,
  // or the comparison would read about 0 KB of eager sync code whatever the main chunk holds.
  console.log('dist/ was built with relay settings; building a no-relay baseline.')
  base = await buildWith('', '')
}

const relay = await buildWith('http://127.0.0.1:59999', 'relay-weight-check')
if (!relay.hasEngine) {
  console.error('The relay build has no sync engine chunk: this check is measuring nothing.')
  process.exit(1)
}

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`
const eager = relay.entry.size - base.entry.size
const status = eager > RELAY_EAGER_BUDGET ? 'FAIL' : 'ok'
console.log(`entry (no relay)   ${fmt(base.entry.size).padStart(10)}  ${base.entry.file}`)
console.log(`entry (relay set)  ${fmt(relay.entry.size).padStart(10)}  ${relay.entry.file}`)
console.log(`eager sync code    ${fmt(eager).padStart(10)} / ${fmt(RELAY_EAGER_BUDGET)}  ${status}`)
// Information only: what a device with a sync code downloads in all (lazy chunks included).
console.log(`all JS (no relay)  ${fmt(base.totalJs).padStart(10)}`)
console.log(`all JS (deployed)  ${fmt(relay.totalJs).padStart(10)}`)

if (eager > RELAY_EAGER_BUDGET) {
  console.error(
    '\nSync code grew the main chunk. Keep it in the lazy engine (src/stores/syncEngine.ts) or raise RELAY_EAGER_BUDGET in scripts/check-relay-weight.mjs if intentional.',
  )
  process.exit(1)
}
