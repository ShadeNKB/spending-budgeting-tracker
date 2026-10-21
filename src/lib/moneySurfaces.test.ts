import { describe, expect, it } from 'vitest'

/**
 * Money-surface guard. Every amount on screen must come from `useFormatMoney()` (or a `fmt`
 * passed down from it) so it carries the selected currency. This scans the app source for
 * the ways a hard-coded `$` or a USD default has slipped in before. It stands in for a lint
 * rule because the ESLint config is frozen.
 *
 * Exempt: tests, `src/lib/format.ts` (where the symbols are defined) and
 * `src/utils/parseExpense.ts` (which reads `$` / `S$` typed by the user).
 */

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const EXEMPT = new Set(['/src/lib/format.ts', '/src/utils/parseExpense.ts', '/src/vite-env.d.ts'])
const isExempt = (path: string) =>
  EXEMPT.has(path) || /\.test\.tsx?$/.test(path) || path.startsWith('/src/__tests__/')

const LINE_RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'template "$" before an amount', pattern: /\$\$\{/ },
  { name: 'JSX "$" before an amount', pattern: />\$\{/ },
  { name: 'JSX text "$"', pattern: />\s*\$\s*</ },
  { name: 'prefix="$"', pattern: /prefix=["']\$["']/ },
  { name: "string literal '$'", pattern: /'\$'|"\$"/ },
  { name: "toLocaleString('en-US', …) amount", pattern: /toLocaleString\(\s*['"]en-US['"]/ },
  { name: 'currency Intl.NumberFormat outside format.ts', pattern: /style:\s*['"]currency['"]/ },
  { name: 'hard-coded USD', pattern: /['"]USD['"]/ },
]

// `formatMoney` defaults to USD; only the hook binds it to the selected currency.
const DIRECT_IMPORT = /import\s*\{[^}]*\bformatMoney\b[^}]*\}\s*from/
const FORMAT_MONEY_IMPORTERS = new Set(['/src/hooks/useFormatMoney.ts'])

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line)

function findViolations(path: string, text: string): string[] {
  const found: string[] = []
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return
    for (const rule of LINE_RULES) {
      if (rule.pattern.test(line)) found.push(`${path}:${i + 1} ${rule.name}: ${line.trim()}`)
    }
  })
  if (!FORMAT_MONEY_IMPORTERS.has(path) && DIRECT_IMPORT.test(text)) {
    found.push(`${path} imports formatMoney directly: use useFormatMoney() or a passed-in fmt`)
  }
  return found
}

describe('money surfaces', () => {
  it('scans the app source', () => {
    const scanned = Object.keys(sources).filter((p) => !isExempt(p))
    expect(scanned.length).toBeGreaterThan(50)
    expect(scanned).toContain('/src/features/pulse/PulseScreen.tsx')
  })

  it('formats every amount through the selected currency', () => {
    const violations = Object.entries(sources)
      .filter(([path]) => !isExempt(path))
      .flatMap(([path, text]) => findViolations(path, text))
    expect(violations).toEqual([])
  })

  it.each([
    ['detail: `$${spent.toFixed(0)} of budget`', 'template'],
    ['<Pill tone="accent">${parsed.amount.toFixed(2)}</Pill>', 'JSX "$" before'],
    ['<span className="text-[11px]">$</span>', 'JSX text'],
    ['prefix="$"', 'prefix'],
    ["const sym = '$'", 'string literal'],
    ["n.toLocaleString('en-US', { minimumFractionDigits: 2 })", 'toLocaleString'],
    ["new Intl.NumberFormat('en-SG', { style: 'currency', currency })", 'Intl.NumberFormat'],
    ["formatMoney(n, {}, 'USD')", 'USD'],
  ])('catches %s', (line, rule) => {
    expect(findViolations('/src/sample.tsx', line).join('\n')).toContain(rule)
  })

  it('catches a direct formatMoney import, including a multi-line one', () => {
    const text = "import {\n  formatInt,\n  formatMoney,\n} from '../../lib/format'"
    expect(findViolations('/src/sample.tsx', text)).toHaveLength(1)
    expect(findViolations('/src/hooks/useFormatMoney.ts', text)).toEqual([])
  })

  it('accepts amounts formatted through fmt and ignores comments', () => {
    const ok = [
      'toast.success(`Added "${name}" · ${fmt(amount)}`)',
      '<Input label="Amount" prefix={symbol} />',
      '// an old local $150 does not win over $200',
      "const repaired = raw.replace(/,(\\s*[}\\]])/g, '$1')",
      "import { formatInt } from '../../lib/format'",
    ].join('\n')
    expect(findViolations('/src/sample.tsx', ok)).toEqual([])
  })
})
