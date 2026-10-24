// @vitest-environment node
// Static proof that the data core is pure (R7, track spec §2.3): no clock, no randomness, no IO,
// no globals, and imports only from the core itself or date-fns.
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Removes comments and the text inside string and template literals (keeps code shape). */
function codeOnly(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      out += c
      i++
    } else {
      out += c ?? ''
      i++
    }
  }
  return out
}

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['zero-arg new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['crypto.getRandomValues', /\bgetRandomValues\b/],
  ['crypto.randomUUID', /\brandomUUID\b/],
  ['performance', /\bperformance\b/],
  ['timers', /\b(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\b/],
  ['storage', /\b(localStorage|sessionStorage|indexedDB)\b/],
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['navigator', /\bnavigator\b/],
  ['process', /\bprocess\b/],
  ['console', /\bconsole\b/],
  ['fetch', /\bfetch\s*\(/],
]

const IMPORT_RE =
  /\bimport\s+(type\s+)?[^'"`;]*?\bfrom\s*(['"])([^'"]+)\2|\bimport\s*\(\s*(['"])([^'"]+)\4/g

function violations(file: string, src: string): string[] {
  const code = codeOnly(src)
  const out: string[] = []
  for (const [name, re] of FORBIDDEN) if (re.test(code)) out.push(`${file}: ${name}`)
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[3] ?? m[5] ?? ''
    if (!(/^\.\/[A-Za-z0-9]+$/.test(spec) || spec === 'date-fns'))
      out.push(`${file}: imports ${spec}`)
  }
  return out
}

describe('purity of src/data/core (R7)', () => {
  it('scans every core module', () => {
    const files = Object.keys(sources)
      .map((p) => p.replace('./', ''))
      .sort()
    for (const f of [
      'types.ts',
      'constants.ts',
      'stamp.ts',
      'hash.ts',
      'dates.ts',
      'ids.ts',
      'sanitize.ts',
      'record.ts',
      'categories.ts',
      'doc.ts',
      'wire.ts',
      'push.ts',
      'ops.ts',
    ]) {
      expect(files).toContain(f)
    }
  })

  it('no clock, randomness, timers, storage, DOM, process, console, React or IO imports', () => {
    const found = Object.entries(sources).flatMap(([file, src]) => violations(file, src))
    expect(found).toEqual([])
  })

  it('the scanner has teeth (positive controls)', () => {
    const bad = [
      'const t = Date.now()',
      'const d = new Date()',
      'const r = Math.random()',
      'crypto.getRandomValues(buf)',
      'crypto.randomUUID()',
      'setTimeout(f, 1)',
      'queueMicrotask(f)',
      'localStorage.getItem("x")',
      'window.x',
      'navigator.onLine',
      'process.env.X',
      'console.log(1)',
      "import React from 'react'",
      "import { storage } from '../local/envelope'",
      "import type { X } from '../../stores/useExpenseStore'",
      "const m = await import('../sync/engine')",
    ]
    for (const src of bad) expect(violations('x.ts', src), src).not.toEqual([])
    const fine = [
      "import { tick } from './stamp'",
      "import type { Doc } from './types'",
      "import { parseISO } from 'date-fns'",
      'const d = new Date(y, m - 1, d, 12)',
      '// Date.now() is injected through OpCtx',
      "const s = 'console and window are words here'",
    ]
    for (const src of fine) expect(violations('x.ts', src), src).toEqual([])
  })
})
