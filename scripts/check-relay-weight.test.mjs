import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOT_BUDGET,
  EAGER_BUDGET,
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

// The owner's decision of 3 Nov 2026, "Raise to 740 KB, startup fixed": the startup of each build
// is held at 0.11.0's bytes + 1,024 B, beside the two sync budgets, which do not change.
describe('the startup budgets', () => {
  let root = ''
  let made = 0
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'startup budgets '))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 0.11.0 as measured on main 7ddf3c6: eager and boot bytes of both builds. */
  const SHIPPED = { baseEager: 465_884, relayEager: 469_778, baseBoot: 560_556, relayBoot: 569_341 }

  /**
   * A no-relay and a relay build of the given eager and boot sizes (the boot adds the data engine
   * chunk), shaped like `html`: the entry chunk takes what the two vendor chunks leave.
   */
  function builds(sizes) {
    const { baseEager, relayEager, baseBoot, relayBoot } = { ...SHIPPED, ...sizes }
    const make = (eager, boot, files) => {
      const dir = join(root, `build${String(made++)}`)
      mkdirSync(join(dir, 'assets'), { recursive: true })
      writeFileSync(join(dir, 'index.html'), html)
      const sizesOf = {
        'index-AAAA.js': eager - 8000,
        'vendor-react-BBBB.js': 5000,
        'vendor-utils-CCCC.js': 3000,
        'engine-GGGG.js': boot - eager,
        ...files,
      }
      for (const [file, size] of Object.entries(sizesOf)) {
        writeFileSync(join(dir, 'assets', file), 'x'.repeat(size))
      }
      return measure(dir)
    }
    return [make(baseEager, baseBoot, {}), make(relayEager, relayBoot, { 'syncEngine-F.js': 1 })]
  }

  /** The printed line that starts with `label`. */
  const line = (lines, label) => lines.find((l) => l.startsWith(label)) ?? ''

  // Each budget alone at its limit, then 1 B over it, with every other number within its own.
  const cases = [
    {
      name: 'EAGER_BUDGET.base',
      label: 'eager JS (no relay)',
      limit: EAGER_BUDGET.base,
      at: (n) => ({ baseEager: n }),
      look: /index-AAAA\.js/,
    },
    {
      name: 'EAGER_BUDGET.relay',
      label: 'eager JS (relay set)',
      limit: EAGER_BUDGET.relay,
      // the no-relay build grows with it, so the eager sync code stays within its 4,096 B
      at: (n) => ({ baseEager: n - 4003, relayEager: n }),
      look: /index-AAAA\.js/,
    },
    {
      name: 'RELAY_EAGER_BUDGET',
      label: 'eager sync code',
      limit: RELAY_EAGER_BUDGET,
      at: (n) => ({ relayEager: SHIPPED.baseEager + n }),
      look: /src\/stores\/syncEngine\.ts/,
    },
    {
      name: 'BOOT_BUDGET.base',
      label: 'boot JS (no relay)',
      limit: BOOT_BUDGET.base,
      at: (n) => ({ baseBoot: n }),
      look: /engine-GGGG\.js/,
    },
    {
      name: 'BOOT_BUDGET.relay',
      label: 'boot JS (relay set)',
      limit: BOOT_BUDGET.relay,
      at: (n) => ({ relayBoot: n }),
      look: /engine-GGGG\.js/,
    },
    {
      name: 'RELAY_BOOT_BUDGET',
      label: 'boot sync code',
      limit: RELAY_BOOT_BUDGET,
      at: (n) => ({ baseBoot: 558_000, relayBoot: 558_000 + n }),
      look: /src\/data\/local\/engine\.ts/,
    },
  ]

  it('holds the startup at 0.11.0 + 1,024 B and leaves both sync budgets as they were', () => {
    expect(EAGER_BUDGET).toEqual({ base: 465_884 + 1024, relay: 469_778 + 1024 })
    expect(BOOT_BUDGET).toEqual({ base: 560_556 + 1024, relay: 569_341 + 1024 })
    expect(RELAY_EAGER_BUDGET).toBe(4096)
    expect(RELAY_BOOT_BUDGET).toBe(12_288)
  })

  it('passes 0.11.0 as shipped and prints every budget as used / budget', () => {
    const verdict = compare(...builds({}))
    expect(verdict.error).toBeNull()
    // used / budget, the verdict, then what is left (the budget column is right-aligned)
    const shows = (label, used, budget, left) =>
      expect(line(verdict.lines, label)).toMatch(
        new RegExp(` ${used} B / +${budget} B {2}ok {4}${left} B left\\b`),
      )
    shows('eager JS (no relay)', '465,884', '466,908', '1,024')
    shows('eager JS (relay set)', '469,778', '470,802', '1,024')
    shows('eager sync code', '3,894', '4,096', '202')
    shows('boot JS (no relay)', '560,556', '561,580', '1,024')
    shows('boot JS (relay set)', '569,341', '570,365', '1,024')
    shows('boot sync code', '8,785', '12,288', '3,503')
  })

  it('lists each chunk of the startup with its bytes, so a report can compare them', () => {
    const { lines } = compare(...builds({}))
    expect(line(lines, 'eager JS (no relay)')).toContain(
      'index-AAAA.js 457,884 B, vendor-react-BBBB.js 5,000 B, vendor-utils-CCCC.js 3,000 B',
    )
    expect(line(lines, 'boot JS (relay set)')).toContain('+ engine-GGGG.js 99,563 B')
  })

  for (const c of cases) {
    it(`passes ${c.name} at its limit and fails it 1 B over, naming it and where to look`, () => {
      const atLimit = compare(...builds(c.at(c.limit)))
      expect(atLimit.error).toBeNull()
      expect(line(atLimit.lines, c.label)).toMatch(/ok\b/)

      const over = compare(...builds(c.at(c.limit + 1)))
      expect(line(over.lines, c.label)).toMatch(/ \/ +[\d,]+ B {2}FAIL {2}1 B over\b/)
      expect(over.lines.filter((l) => l.includes('FAIL'))).toHaveLength(1)
      expect(over.error).toContain(c.name)
      expect(over.error).toContain('scripts/check-relay-weight.mjs')
      expect(over.error).toMatch(c.look)
      // only the budget that is over is named
      for (const other of cases) if (other !== c) expect(over.error).not.toContain(`${other.name}:`)
    })
  }

  it('reports every budget a change breaks, not only the first', () => {
    // one chunk that every build loads first grows by 2 KB: both startups are over
    const verdict = compare(
      ...builds({
        baseEager: SHIPPED.baseEager + 2048,
        relayEager: SHIPPED.relayEager + 2048,
        baseBoot: SHIPPED.baseBoot + 2048,
        relayBoot: SHIPPED.relayBoot + 2048,
      }),
    )
    expect(verdict.lines.filter((l) => l.includes('FAIL'))).toHaveLength(4)
    for (const name of [
      'EAGER_BUDGET.base',
      'EAGER_BUDGET.relay',
      'BOOT_BUDGET.base',
      'BOOT_BUDGET.relay',
    ]) {
      expect(verdict.error).toContain(name)
    }
    expect(verdict.error).toContain("owner's decision")
  })
})
