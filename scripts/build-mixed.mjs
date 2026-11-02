#!/usr/bin/env node
// Builds the apps the data-engine e2e suite runs side by side (playwright.data-engine.config.ts):
//
//   candidate  this worktree, as it is
//   v092       `git archive v0.9.2`: what the owner's phone may still run (app 0.9.2, PR-0)
//
// Both point at the fake relay of e2e/data-engine/support/relayServer.ts
// (VITE_SUPABASE_URL=http://localhost:4219, VITE_SUPABASE_ANON_KEY=e2e-anon). The 0.9.2 tree is
// built offline against an existing install of its dependency set (default ../pr0/node_modules,
// the PR-0 worktree; ST5_E2E_V092_MODULES overrides), linked in as a junction. It is rebuilt only
// when the tag moves. Each build's production CSP is taken from its own vercel.json (the inline
// script hash differs per release) with the relay added to connect-src, for the suite's server.
//
// Output (ST5_E2E_CACHE, default node_modules/.cache/st5-e2e): candidate/, v092/, *.csp and
// manifest.json. Usage: node scripts/build-mixed.mjs [--skip-candidate]

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(process.env.ST5_E2E_CACHE ?? join(ROOT, 'node_modules/.cache/st5-e2e'))
const RELAY = process.env.ST5_E2E_RELAY ?? 'http://localhost:4219'
const OLD_TAG = 'v0.9.2'
const OLD_MODULES = resolve(process.env.ST5_E2E_V092_MODULES ?? join(ROOT, '../pr0/node_modules'))
const BUILD_ENV = {
  ...process.env,
  VITE_SUPABASE_URL: RELAY,
  VITE_SUPABASE_ANON_KEY: 'e2e-anon',
  VITE_DEMO_MODE: '',
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, env: BUILD_ENV, stdio: ['ignore', 'inherit', 'inherit'] })
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

function viteBuild(cwd, vite, outDir) {
  run(
    process.execPath,
    [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
    cwd,
  )
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(`no index.html in ${outDir}`)
}

function buildCandidate() {
  const out = join(CACHE, 'candidate')
  console.log(`[build-mixed] candidate → ${out}`)
  viteBuild(ROOT, join(ROOT, 'node_modules/vite/bin/vite.js'), out)
  writeFileSync(
    join(CACHE, 'candidate.csp'),
    cspWithRelay(readFileSync(join(ROOT, 'vercel.json'), 'utf8'), RELAY),
  )
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function buildOld() {
  const commit = read('git', ['rev-parse', `${OLD_TAG}^{commit}`])
  const out = join(CACHE, 'v092')
  const stampFile = join(CACHE, 'v092.stamp')
  const stamp = `${commit} ${RELAY}`
  if (existsSync(join(out, 'index.html')) && existsSync(stampFile)) {
    if (readFileSync(stampFile, 'utf8') === stamp) {
      console.log(`[build-mixed] ${OLD_TAG} is current (${commit.slice(0, 7)})`)
      return
    }
  }
  if (!existsSync(join(OLD_MODULES, 'vite/bin/vite.js'))) {
    throw new Error(
      `No 0.9.2 dependency set at ${OLD_MODULES}. Install one (npm ci in a v0.9.2 checkout) and set ST5_E2E_V092_MODULES to its node_modules.`,
    )
  }
  const src = join(CACHE, 'src-v092')
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src, { recursive: true })
  const tarball = join(CACHE, 'v092.tar')
  run('git', ['archive', '--format=tar', '-o', tarball, OLD_TAG], ROOT)
  // A relative path from inside the folder: GNU tar reads "C:\…" as a remote host.
  run('tar', ['-xf', '../v092.tar'], src)
  rmSync(tarball, { force: true })
  symlinkSync(
    OLD_MODULES,
    join(src, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  console.log(`[build-mixed] ${OLD_TAG} (${commit.slice(0, 7)}) → ${out}`)
  viteBuild(src, join(OLD_MODULES, 'vite/bin/vite.js'), out)
  writeFileSync(
    join(CACHE, 'v092.csp'),
    cspWithRelay(readFileSync(join(src, 'vercel.json'), 'utf8'), RELAY),
  )
  writeFileSync(stampFile, stamp)
}

function main() {
  mkdirSync(CACHE, { recursive: true })
  const skipCandidate = process.argv.includes('--skip-candidate')
  const version = skipCandidate ? null : buildCandidate()
  buildOld()
  const manifest = {
    relay: RELAY,
    builtAt: new Date().toISOString(),
    candidate: { dir: join(CACHE, 'candidate'), csp: join(CACHE, 'candidate.csp'), version },
    v092: { dir: join(CACHE, 'v092'), csp: join(CACHE, 'v092.csp'), tag: OLD_TAG },
  }
  writeFileSync(join(CACHE, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[build-mixed] done: ${join(CACHE, 'manifest.json')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
