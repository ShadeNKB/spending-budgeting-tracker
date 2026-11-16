import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The start-up steps, each a stand-in that records its turn: the real ones boot the data engine
// and the sync wiring, which the AppShell tests already run end to end.
const steps = vi.hoisted(() => ({
  calls: [] as string[],
  fail: null as 'installPersistence' | 'installSync' | null,
}))

function step(name: 'installPersistence' | 'installSync'): void {
  steps.calls.push(name)
  if (steps.fail === name) throw new Error(`${name} failed`)
}

vi.mock('../stores/useExpenseStore', () => ({
  useExpenseStore: {
    getState: () => ({
      hydrate: () => {
        steps.calls.push('hydrate')
        return Promise.resolve()
      },
    }),
  },
  installPersistence: () => {
    step('installPersistence')
  },
}))
vi.mock('../stores/useSyncStore', () => ({
  installSync: () => {
    step('installSync')
  },
}))

// The once-per-page flag lives in the module: each test loads a fresh copy, as a page load does.
async function load() {
  vi.resetModules()
  const { bootstrap } = await import('./bootstrap')
  return bootstrap
}

beforeEach(() => {
  steps.calls = []
  steps.fail = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bootstrap', () => {
  it('starts the load, then persistence, then sync', async () => {
    const bootstrap = await load()
    bootstrap()
    expect(steps.calls).toEqual(['hydrate', 'installPersistence', 'installSync'])
  })

  it('runs once per page load, however often the shell mounts', async () => {
    const bootstrap = await load()
    bootstrap()
    bootstrap()
    bootstrap()
    expect(steps.calls).toEqual(['hydrate', 'installPersistence', 'installSync'])
  })

  it('does nothing without a window, and still runs once one is there', async () => {
    const bootstrap = await load()
    vi.stubGlobal('window', undefined)
    bootstrap()
    expect(steps.calls).toEqual([])
    vi.unstubAllGlobals()
    bootstrap()
    expect(steps.calls).toEqual(['hydrate', 'installPersistence', 'installSync'])
  })

  it('lets a step that throws out, skips the steps after it, and never retries', async () => {
    const bootstrap = await load()
    steps.fail = 'installPersistence'
    expect(() => {
      bootstrap()
    }).toThrow('installPersistence failed')
    expect(steps.calls).toEqual(['hydrate', 'installPersistence'])

    steps.fail = null
    bootstrap()
    expect(steps.calls).toEqual(['hydrate', 'installPersistence'])
  })

  it('keeps the steps before a failing sync step', async () => {
    const bootstrap = await load()
    steps.fail = 'installSync'
    expect(() => {
      bootstrap()
    }).toThrow('installSync failed')
    expect(steps.calls).toEqual(['hydrate', 'installPersistence', 'installSync'])
    bootstrap()
    expect(steps.calls).toHaveLength(3)
  })
})

// The moment is the shell's first effect, after React has mounted (moving it before mount is
// ruled out in the T9 scoping): main.tsx and the stores must not start it themselves.
const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
)

describe('who starts the app', () => {
  it("is AppShell's mount effect, and nothing else", () => {
    const importers = Object.entries(SOURCES)
      .filter(([, text]) => /from\s+['"](?:\.\/|[./]*app\/)bootstrap['"]/.test(text))
      .map(([path]) => path)
    expect(importers).toEqual(['/src/app/AppShell.tsx'])
    expect(SOURCES['/src/app/AppShell.tsx']).toMatch(/\n {2}useEffect\(bootstrap, \[\]\)\n/)
  })
})
