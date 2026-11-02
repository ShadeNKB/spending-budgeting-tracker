import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_BOOT_PRELOAD,
  NO_ENGINE_CHUNK,
  RELAY_BOOT_BUDGET,
  RELAY_EAGER_BUDGET,
  bootScripts,
  compare,
  eagerScripts,
  measure,
} from './check-relay-weight.mjs'

// What Vite writes: the module entry, its modulepreloaded vendor chunks, the data engine chunk
// vite.config.js preloads for the boot (data-boot), and the PWA script.
const html = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-BBBB.js">
<link rel="modulepreload" crossorigin href="/assets/vendor-utils-CCCC.js">
<link rel="stylesheet" crossorigin href="/assets/index-DDDD.css">
<link rel="modulepreload" href="/assets/vendor-react-BBBB.js">
<script id="vite-plugin-pwa:register-sw" src="/registerSW.js"></script>
<link rel="modulepreload" crossorigin href="/assets/engine-GGGG.js" data-boot="engine">
</head></html>`

describe('eagerScripts', () => {
  it('lists the module entry and every modulepreloaded chunk once, and nothing else', () => {
    expect(eagerScripts(html)).toEqual([
      'assets/index-AAAA.js',
      'assets/vendor-react-BBBB.js',
      'assets/vendor-utils-CCCC.js',
    ])
  })

  it('reads attributes in any order', () => {
    const swapped =
      '<script src="/assets/index-X.js" crossorigin type="module"></script>' +
      '<link href="/assets/v-Y.js" rel="modulepreload">'
    expect(eagerScripts(swapped)).toEqual(['assets/index-X.js', 'assets/v-Y.js'])
  })

  it('leaves the boot-path preloads out of what first paint needs, and lists them for the boot', () => {
    expect(eagerScripts(html)).not.toContain('assets/engine-GGGG.js')
    expect(bootScripts(html)).toEqual([
      'assets/index-AAAA.js',
      'assets/vendor-react-BBBB.js',
      'assets/vendor-utils-CCCC.js',
      'assets/engine-GGGG.js',
    ])
  })

  it('throws when there is no module entry', () => {
    expect(() => eagerScripts('<script src="/registerSW.js"></script>')).toThrow(/No module entry/)
  })
})

describe('measure and compare', () => {
  let root = ''
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'relay weight '))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A fake build folder: index.html and assets of the given byte sizes. */
  function build(name, files, page = html) {
    const dir = join(root, name)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), page)
    for (const [file, size] of Object.entries(files)) {
      writeFileSync(join(dir, 'assets', file), 'x'.repeat(size))
    }
    return measure(dir)
  }

  const shared = {
    'vendor-react-BBBB.js': 5000,
    'vendor-utils-CCCC.js': 3000,
    'engine-GGGG.js': 20_000,
  }

  it('counts the entry and the modulepreloads, not lazy chunks', () => {
    const base = build('base', { 'index-AAAA.js': 10_000, ...shared, 'lazy-EEEE.js': 9999 })
    expect(base.eagerSize).toBe(18_000)
    expect(base.bootSize).toBe(38_000)
    expect(base.hasBootPreload).toBe(true)
    expect(base.hasEngine).toBe(false)
  })

  it('fails sync code that only the sync engine needs in a chunk the boot preloads', () => {
    const base = build('base4', { 'index-AAAA.js': 10_000, ...shared })
    const heavy = build('heavy', {
      'index-AAAA.js': 10_000,
      ...shared,
      'engine-GGGG.js': 20_000 + RELAY_BOOT_BUDGET + 1,
      'syncEngine-F.js': 14_000,
    })
    const verdict = compare(base, heavy)
    expect(verdict.error).toMatch(/every boot downloads/)
    expect(verdict.lines.join('\n')).toMatch(/boot sync code .* FAIL/)
  })

  it('fails a build whose index.html no longer preloads the data engine', () => {
    const page = html.replace(/<link[^>]*data-boot[^>]*>/, '')
    const base = build('base5', { 'index-AAAA.js': 10_000, ...shared }, page)
    const relay = build(
      'relay5',
      { 'index-AAAA.js': 10_000, ...shared, 'syncEngine-F.js': 1 },
      page,
    )
    expect(compare(base, relay).error).toBe(NO_BOOT_PRELOAD)
    expect(NO_BOOT_PRELOAD).toContain('vite.config.js')
  })

  it('passes sync state within budget and fails sync code in a preloaded chunk', () => {
    const base = build('base2', { 'index-AAAA.js': 10_000, ...shared })
    const lean = build('lean', { 'index-AAAA.js': 12_000, ...shared, 'syncEngine-F.js': 14_000 })
    expect(compare(base, lean).error).toBeNull()

    // The entry stays small, but a preloaded vendor chunk now carries the SDK.
    const leaky = build('leaky', {
      'index-AAAA.js': 10_000,
      'vendor-react-BBBB.js': 5000,
      'vendor-utils-CCCC.js': 3000 + RELAY_EAGER_BUDGET + 1,
      'engine-GGGG.js': 20_000,
      'syncEngine-F.js': 14_000,
    })
    const verdict = compare(base, leaky)
    expect(verdict.error).toMatch(/modulepreloaded/)
    expect(verdict.lines.join('\n')).toContain('FAIL')
  })

  it('says where to look when the relay build has no engine chunk', () => {
    const base = build('base3', { 'index-AAAA.js': 10_000, ...shared })
    const folded = build('folded', { 'index-AAAA.js': 40_000, ...shared })
    expect(compare(base, folded).error).toBe(NO_ENGINE_CHUNK)
    expect(NO_ENGINE_CHUNK).toMatch(/imported statically/)
    expect(NO_ENGINE_CHUNK).toContain('src/stores/syncEngine.ts')
  })
})
