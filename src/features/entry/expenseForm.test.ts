import { describe, expect, it } from 'vitest'
import {
  CHOSEN_CHIP_LIGHTNESS,
  chosenChipFill,
  firstInvalidField,
  validateExpenseForm,
} from './expenseForm'
import { colorFromString } from '../../lib/analytics'
import { MAX_AMOUNT } from '../../utils/amountGuard'

// A stand-in for the currency formatter, so the "too large" message is checked exactly.
const fmt = (n: number) => `S$${n.toFixed(2)}`
const TOO_LARGE = `Amount too large — the limit is ${fmt(MAX_AMOUNT)}`

describe('validateExpenseForm', () => {
  it('accepts a named item with a positive amount', () => {
    expect(validateExpenseForm({ itemName: 'Kopi O', amount: '1.80' }, fmt)).toEqual({})
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
  ])('requires an item name (%s)', (_, itemName) => {
    expect(validateExpenseForm({ itemName, amount: '4.50' }, fmt)).toEqual({
      itemName: 'Required',
    })
  })

  it.each([
    ['empty', ''],
    ['spaces', '  '],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['negative', '-3'],
    ['not a number', 'abc'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('rejects an amount that is %s', (_, amount) => {
    expect(validateExpenseForm({ itemName: 'Grab', amount }, fmt)).toEqual({
      amount: 'Enter a valid amount',
    })
  })

  it('accepts exactly the limit and rejects anything above it', () => {
    expect(validateExpenseForm({ itemName: 'Car', amount: String(MAX_AMOUNT) }, fmt)).toEqual({})
    expect(
      validateExpenseForm({ itemName: 'Car', amount: String(MAX_AMOUNT + 0.01) }, fmt),
    ).toEqual({ amount: TOO_LARGE })
  })

  it('reads exponent notation as the number it is ("1e9" is too large)', () => {
    expect(validateExpenseForm({ itemName: 'Typo', amount: '1e9' }, fmt)).toEqual({
      amount: TOO_LARGE,
    })
    expect(validateExpenseForm({ itemName: 'Small', amount: '1e1' }, fmt)).toEqual({})
  })

  it('reports both fields when both are wrong', () => {
    expect(validateExpenseForm({ itemName: '', amount: '0' }, fmt)).toEqual({
      itemName: 'Required',
      amount: 'Enter a valid amount',
    })
  })
})

describe('firstInvalidField', () => {
  it('is the item name first, then the amount, else null (form order)', () => {
    expect(firstInvalidField({ itemName: 'Required', amount: 'Enter a valid amount' })).toBe(
      'itemName',
    )
    expect(firstInvalidField({ amount: 'Enter a valid amount' })).toBe('amount')
    expect(firstInvalidField({})).toBeNull()
  })
})

// ─── chosen chip contrast (WCAG 1.4.3) ────────────────────────────────────────

/** sRGB channels (0-255) of `hsl(h, s%, l%)`, as CSS Color 4 computes them. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

const parseHsl = (css: string): [number, number, number] => {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(css)
  if (!m) throw new Error(`not an hsl() colour: ${css}`)
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
}

const hexToRgb = (hex: string): [number, number, number] => {
  const [r = 0, g = 0, b = 0] = (hex.replace('#', '').match(/../g) ?? []).map((c) =>
    parseInt(c, 16),
  )
  return [r, g, b]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

// The chip label is `text-surface-0`: --surface-0 in the dark theme, pinned dark in the light one
// (index.css), so the label is near-black in both.
const LABELS = { dark: '#0c0b0a', light: '#0a0e14' } as const

describe('chosen category chip', () => {
  it('reads at 4.5:1 or more at every hue, in both themes', () => {
    for (let hue = 0; hue < 360; hue++) {
      const fill = `hsl(${String(hue)}, 65%, ${String(CHOSEN_CHIP_LIGHTNESS)}%)`
      for (const label of Object.values(LABELS)) {
        expect(
          contrast(parseHsl(fill), hexToRgb(label)),
          `hue ${String(hue)}, label ${label}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the category’s own hue, only lighter than its dot (Shopping was 3.9:1)', () => {
    expect(colorFromString('Shopping')).toBe('hsl(240, 65%, 62%)')
    expect(chosenChipFill('Shopping')).toBe('hsl(240, 65%, 68%)')
    for (const category of ['Food & Dining', 'Gaming', 'Transportation', 'Gifts', 'Kopi']) {
      const dot = colorFromString(category)
      expect(chosenChipFill(category)).toBe(dot.replace('62%)', '68%)'))
    }
  })
})
