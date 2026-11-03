#!/usr/bin/env node
// Builds the apps the data-engine e2e suite runs side by side (playwright.data-engine.config.ts):
//
//   candidate        this worktree, as it ships (no sync flags: plain upsert, table transport)
//   candidate-flags  this worktree with VITE_SYNC_CAS=on and VITE_SYNC_RELAY=auto (PR-5 runbook)
//   v010             `git archive v0.10.0` (else PR-2's final commit 02a2e40; ST5_E2E_V010_REF
//                    overrides): what a device that has not reloaded since PR-2 runs (app 0.10.0)
//   v092             `git archive v0.9.2`: what the owner's phone may still run (app 0.9.2, PR-0)
//
// All point at the fake relay of e2e/data-engine/support/relayServer.ts
// (VITE_SUPABASE_URL=http://localhost:4219, VITE_SUPABASE_ANON_KEY=e2e-anon). An archived tree
// is built offline against an existing install of its dependency set, linked in as a junction:
// 0.10.0 uses this worktree's node_modules (PR-3 adds no dependency), 0.9.2 an install of its
// own (default ../pr0/node_modules, the PR-0 worktree; ST5_E2E_V092_MODULES overrides). Each
// build is redone only when its source moves: an archived tree when its commit (or the relay)
// changes, a worktree build when a hash of its sources and flags changes. Each build's production
// CSP is taken from its own vercel.json (the inline script hash differs per release) with the
// relay added to connect-src, for the suite's server.
//
// Output (ST5_E2E_CACHE, default node_modules/.cache/st5-e2e): candidate/, candidate-flags/,
// v010/, v092/, *.csp, *.stamp and manifest.json. An archived tree is extracted next to them
// only while it builds, then removed with its junction: 0.10.0's junction points back at this
// worktree's node_modules, which holds the cache, and a tree left behind would be a loop for any
// walker that follows junctions. Usage: node scripts/build-mixed.mjs [--skip-candidate] [--force]

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(process.env.ST5_E2E_CACHE ?? join(ROOT, 'node_modules/.cache/st5-e2e'))
const RELAY = process.env.ST5_E2E_RELAY ?? 'http://localhost:4219'
const FORCE = process.argv.includes('--force')
/** No flag leaks in from the shell: each build states its own. */
const NO_FLAGS = { VITE_SYNC_CAS: '', VITE_SYNC_RELAY: '' }
const FLAGS = { VITE_SYNC_CAS: 'on', VITE_SYNC_RELAY: 'auto' }
const BASE_ENV = {
  ...process.env,
  VITE_SUPABASE_URL: RELAY,
  VITE_SUPABASE_ANON_KEY: 'e2e-anon',
  VITE_DEMO_MODE: '',
}

/** The archived releases: the ref to build, and where its dependency set lives. */
const ARCHIVED = {
  v010: {
    refs: process.env.ST5_E2E_V010_REF ? [process.env.ST5_E2E_V010_REF] : ['v0.10.0', '02a2e40'],
    modules: resolve(process.env.ST5_E2E_V010_MODULES ?? join(ROOT, 'node_modules')),
  },
  v092: {
    refs: ['v0.9.2'],
    modules: resolve(process.env.ST5_E2E_V092_MODULES ?? join(ROOT, '../pr0/node_modules')),
  },
}

const run = (cmd, args, cwd, env = BASE_ENV) =>
  execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
const read = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

/** The production CSP of a vercel.json, with the relay (http and ws) allowed in connect-src. */
export function cspWithRelay(vercelJson, relay) {
  const rule = JSON.parse(vercelJson).headers.find((h) => h.source === '/(.*)')
  const csp = rule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value
  if (typeof csp !== 'string') throw new Error('vercel.json has no catch-all CSP')
  const ws = relay.replace(/^http/, 'ws')
  if (!/connect-src [^;]*/.test(csp)) throw new Error('the CSP has no connect-src')
  return csp.replace(/connect-src ([^;]*)/, (_, list) => `connect-src ${list} ${relay} ${ws}`)
}

function viteBuild(cwd, vite, outDir, env) {
  run(
    process.execPath,
    [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
    cwd,
    env,
  )
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(`no index.html in ${outDir}`)
}

const fresh = (name, stamp) => {
  const file = join(CACHE, `${name}.stamp`)
  return (
    !FORCE &&
    existsSync(join(CACHE, name, 'index.html')) &&
    existsSync(join(CACHE, `${name}.csp`)) &&
    existsSync(file) &&
    readFileSync(file, 'utf8') === stamp
  )
}

/** What a worktree build depends on: its sources, configs and the lock file, by content. */
function sourceHash(extra) {
  const hash = createHash('sha256').update(JSON.stringify(extra))
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) hash.update(relative(ROOT, path)).update(readFileSync(path))
    }
  }
  for (const dir of ['src', 'public']) walk(join(ROOT, dir))
  for (const file of [
    'index.html',
    'vite.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'package.json',
    'package-lock.json',
    'vercel.json',
  ]) {
    if (existsSync(join(ROOT, file)) && statSync(join(ROOT, file)).isFile())
      hash.update(file).update(readFileSync(join(ROOT, file)))
  }
  return hash.digest('hex')
}

function buildWorktree(name, flags) {
  const out = join(CACHE, name)
  const stamp = `${sourceHash({ flags, relay: RELAY })}`
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  if (fresh(name, stamp)) {
    console.log(`[build-mixed] ${name} is current`)
    return version
  }
  console.log(`[build-mixed] ${name} (${JSON.stringify(flags)}) → ${out}`)
  viteBuild(ROOT, join(ROOT, 'node_modules/vite/bin/vite.js'), out, { ...BASE_ENV, ...flags })
  writeFileSync(
    join(CACHE, `${name}.csp`),
    cspWithRelay(readFileSync(join(ROOT, 'vercel.json'), 'utf8'), RELAY),
  )
  writeFileSync(join(CACHE, `${name}.stamp`), stamp)
  return version
}

/** The first ref of `refs` that names a commit here. */
function commitOf(refs) {
  for (const ref of refs) {
    try {
      return { ref, commit: read('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) }
    } catch {
      // not here: try the next one
    }
  }
  throw new Error(`none of ${refs.join(', ')} names a commit in this repository`)
}

function buildArchived(name) {
  const { refs, modules } = ARCHIVED[name]
  const { ref, commit } = commitOf(refs)
  const out = join(CACHE, name)
  const stamp = `${commit} ${RELAY}`
  if (fresh(name, stamp)) {
    console.log(`[build-mixed] ${name} is current (${ref}, ${commit.slice(0, 7)})`)
    return { ref, commit }
  }
  if (!existsSync(join(modules, 'vite/bin/vite.js'))) {
    throw new Error(
      `No dependency set for ${name} at ${modules}. Install one (npm ci in a checkout of ${ref}) and set ST5_E2E_${name.toUpperCase()}_MODULES to its node_modules.`,
    )
  }
  const src = join(CACHE, `src-${name}`)
  // rmSync removes a junction itself, never what it points at.
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src, { recursive: true })
  try {
    const tarball = join(CACHE, `${name}.tar`)
    run('git', ['archive', '--format=tar', '-o', tarball, commit], ROOT)
    // A relative path from inside the folder: GNU tar reads "C:\…" as a remote host.
    run('tar', ['-xf', `../${name}.tar`], src)
    rmSync(tarball, { force: true })
    symlinkSync(
      modules,
      join(src, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    console.log(`[build-mixed] ${name}: ${ref} (${commit.slice(0, 7)}) → ${out}`)
    viteBuild(src, join(modules, 'vite/bin/vite.js'), out, { ...BASE_ENV, ...NO_FLAGS })
    writeFileSync(
      join(CACHE, `${name}.csp`),
      cspWithRelay(readFileSync(join(src, 'vercel.json'), 'utf8'), RELAY),
    )
    writeFileSync(join(CACHE, `${name}.stamp`), stamp)
  } finally {
    // Only the build and its CSP are used: the tree and its junction go.
    rmSync(src, { recursive: true, force: true })
  }
  return { ref, commit }
}

function main() {
  mkdirSync(CACHE, { recursive: true })
  const skipCandidate = process.argv.includes('--skip-candidate')
  const version = skipCandidate ? null : buildWorktree('candidate', NO_FLAGS)
  if (!skipCandidate) buildWorktree('candidate-flags', FLAGS)
  const v010 = buildArchived('v010')
  const v092 = buildArchived('v092')
  const entry = (name) => ({ dir: join(CACHE, name), csp: join(CACHE, `${name}.csp`) })
  const manifest = {
    relay: RELAY,
    builtAt: new Date().toISOString(),
    candidate: { ...entry('candidate'), version, flags: NO_FLAGS },
    'candidate-flags': { ...entry('candidate-flags'), version, flags: FLAGS },
    v010: { ...entry('v010'), ref: v010.ref, commit: v010.commit },
    v092: { ...entry('v092'), ref: v092.ref, commit: v092.commit },
  }
  writeFileSync(join(CACHE, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[build-mixed] done: ${join(CACHE, 'manifest.json')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
