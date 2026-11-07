#!/usr/bin/env node
// Fails the build if dist/assets grows beyond budget. Lean alternative to size-limit.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist/assets'
const BUDGETS = {
  // bytes — calibrated 2026-05-25 against current dist with ~15% headroom.
  // Raise deliberately when adding a large dep (and note the dep in the commit).
  // Raised 3 Nov 2026 by the owner's decision 'Raise to 740 KB, startup fixed': the total may
  // grow, the startup may not (eager and boot budgets in check-relay-weight.mjs).
  js: 740 * 1024,
  css: 80 * 1024,
  total: 820 * 1024,
}

function walk(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...walk(p))
    else out.push({ path: p, size: s.size })
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error(`No ${DIST}/ — run \`npm run build\` first.`)
  process.exit(1)
}

const totals = { js: 0, css: 0, total: 0 }
for (const { path, size } of files) {
  totals.total += size
  if (path.endsWith('.js')) totals.js += size
  else if (path.endsWith('.css')) totals.css += size
}

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`
const fail = []
for (const k of Object.keys(BUDGETS)) {
  const status = totals[k] > BUDGETS[k] ? 'FAIL' : 'ok'
  console.log(`${k.padEnd(6)} ${fmt(totals[k]).padStart(10)} / ${fmt(BUDGETS[k])}  ${status}`)
  if (totals[k] > BUDGETS[k]) fail.push(k)
}

if (fail.length) {
  console.error(
    `\nBundle budget exceeded: ${fail.join(', ')}. Raise budgets in scripts/check-bundle-size.mjs if intentional.`,
  )
  process.exit(1)
}
