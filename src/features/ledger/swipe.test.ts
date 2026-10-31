import { describe, expect, it } from 'vitest'
import {
  CLICK_GUARD_MS,
  DRAG_THRESHOLD,
  REVEAL_X,
  actionOpacity,
  constrainX,
  pastThreshold,
  pointerVelocity,
  revealDecision,
  rowVelocity,
  tintOpacity,
  xAt,
} from './swipe'
import { springSamples } from '../../ui/spring'

// Golden outputs of framer-motion 12.40, captured from the installed package before it was
// removed (2026-10-25). The row was `drag="x"` with dragConstraints { left: -120, right: 0 } and
// dragElastic { left: 0.12, right: 0 }.

/** [pointer x, the x framer's applyConstraints gave the row] */
const CONSTRAINED = [
  [-400, -153.6],
  [-300, -141.6],
  [-200, -129.6],
  [-150, -123.6],
  [-121, -120.12],
  [-120.5, -120.06],
  [-120, -120],
  [-119.99, -119.99],
  [-96, -96],
  [-76, -76],
  [-60, -60],
  [-1, -1],
  [0, 0],
  [0.5, 0],
  [10, 0],
  [120, 0],
] as const

/** framer's PanSession getVelocity(history, 0.1 s): history = [timestamp ms, x] points. */
const PAN_VELOCITY = [
  {
    name: 'steady',
    history: [
      [0, 300],
      [16, 290],
      [32, 280],
      [48, 270],
      [64, 260],
      [80, 250],
      [96, 240],
      [112, 230],
      [128, 220],
      [144, 210],
      [160, 200],
    ],
    velocity: -625,
  },
  {
    name: 'holdThenFlick',
    history: [
      [0, 300],
      [400, 296],
      [416, 270],
      [432, 230],
    ],
    velocity: -2062.5,
  },
  {
    name: 'holdThenFlickShort',
    history: [
      [0, 300],
      [250, 290],
    ],
    velocity: -40,
  },
  {
    name: 'slowThenStop',
    history: [
      [0, 300],
      [100, 294],
      [200, 288],
      [300, 282],
      [400, 276],
      [500, 270],
      [600, 264],
    ],
    velocity: -60,
  },
  { name: 'single', history: [[0, 300]], velocity: 0 },
  {
    name: 'sameTime',
    history: [
      [5, 300],
      [5, 280],
    ],
    velocity: 0,
  },
  {
    name: 'withinWindow',
    history: [
      [0, 300],
      [30, 297],
      [60, 260],
    ],
    velocity: -666.666667,
  },
  {
    name: 'borderline',
    history: [
      [0, 300],
      [100, 290],
      [200, 200],
    ],
    velocity: -500,
  },
  {
    name: 'rightward',
    history: [
      [0, 100],
      [8, 112],
      [16, 124],
      [24, 136],
      [32, 148],
    ],
    velocity: 1500,
  },
] as const

/**
 * motion-dom's MotionValue.getVelocity() at release: the value was 0 from t = 0, then set to
 * each [t, x] in turn (the drag), and read at `releaseAt`.
 */
const VALUE_VELOCITY = [
  {
    name: 'two frames',
    sets: [
      [1000, -10],
      [1016, -20],
    ],
    releaseAt: 1020,
    velocity: -625,
  },
  {
    name: 'stale',
    sets: [
      [1000, -10],
      [1016, -20],
    ],
    releaseAt: 1047,
    velocity: 0,
  },
  {
    name: 'just fresh',
    sets: [
      [1000, -10],
      [1016, -20],
    ],
    releaseAt: 1046,
    velocity: -625,
  },
  {
    name: 'capped delta',
    sets: [
      [1000, -10],
      [1050, -40],
    ],
    releaseAt: 1060,
    velocity: -1000,
  },
  {
    name: 'same frame twice',
    sets: [
      [1000, -10],
      [1016, -20],
      [1016, -24],
    ],
    releaseAt: 1018,
    velocity: -875,
  },
  {
    name: 'rightward',
    sets: [
      [1000, -90],
      [1008, -80],
      [1016, -66],
    ],
    releaseAt: 1016,
    velocity: 1750,
  },
  { name: 'one set only', sets: [[1000, -10]], releaseAt: 1005, velocity: -333.333333 },
] as const

/**
 * framer's useTransform maps of the row: [x, swipe Delete opacity, background alpha]. The
 * background was rgba(239, 68, 68, a), fading to white at alpha 0 over the last 40 px.
 */
const MAPS = [
  [-200, 1, 0.14],
  [-130, 1, 0.14],
  [-120, 1, 0.14],
  [-110, 0.96, 0.1275],
  [-96, 0.904, 0.11],
  [-80, 0.84, 0.09],
  [-70, 0.8, 0.0775],
  [-40, 0.68, 0.04],
  [-30, 0.64, 0.03],
  [-20, 0.6, 0.02],
  [-10, 0.3, 0.01],
  [-5, 0.15, 0.005],
  [0, 0, 0],
  [5, 0, 0],
] as const

describe('constrainX: the row moves within [-120, 0], elastic past -120 only', () => {
  it.each(CONSTRAINED)('pointer at %d puts the row where framer did (%d)', (pointer, row) => {
    expect(constrainX(pointer)).toBeCloseTo(row, 9)
  })

  it('is continuous at the left limit, giving 0.12 px per px beyond it', () => {
    expect(constrainX(-120 - 1e-9)).toBeCloseTo(-120, 6)
    expect(constrainX(-170) - constrainX(-160)).toBeCloseTo(-1.2, 9)
    expect(constrainX(-60) - constrainX(-50)).toBe(-10)
  })

  it('never passes 0 to the right', () => {
    expect(constrainX(0.001)).toBe(0)
    expect(constrainX(400)).toBe(0)
  })
})

describe('CLICK_GUARD_MS: the click a browser sends with a drag’s release', () => {
  // The row's own length since before framer-motion left (LedgerRow kept dragStarted for 50 ms).
  // Shorter, a phone that sends the click after the release (iOS Safari) would take a short drag
  // that starts on the trash for a tap on it, and delete the row.
  it('is ignored for 50 ms after the release', () => {
    expect(CLICK_GUARD_MS).toBe(50)
  })
})

describe('pastThreshold: a drag starts after 3 px in any direction', () => {
  it('measures the 2-D distance from the press', () => {
    expect(DRAG_THRESHOLD).toBe(3)
    expect(pastThreshold(-3, 0)).toBe(true)
    expect(pastThreshold(0, 3)).toBe(true)
    expect(pastThreshold(2, 2)).toBe(false) // 2.83 px
    expect(pastThreshold(-2.2, 2.2)).toBe(true) // 3.11 px
    expect(pastThreshold(-2.99, 0)).toBe(false)
  })
})

describe('revealDecision: reveal past 76 px or faster than 650 px/s to the left', () => {
  it('reveals on distance alone, the boundary excluded', () => {
    expect(revealDecision(-76, 0)).toBe(false)
    expect(revealDecision(-76.01, 0)).toBe(true)
    expect(revealDecision(-200, 300)).toBe(true)
  })

  it('reveals on velocity alone, the boundary excluded', () => {
    expect(revealDecision(0, -650)).toBe(false)
    expect(revealDecision(0, -650.01)).toBe(true)
    expect(revealDecision(-20, -2000)).toBe(true)
  })

  it('snaps back otherwise, whichever way the pointer went', () => {
    expect(revealDecision(-40, -300)).toBe(false)
    expect(revealDecision(30, 900)).toBe(false)
    expect(REVEAL_X).toBe(-96)
  })
})

describe('pointerVelocity: framer’s pan velocity over the last 100 ms', () => {
  it.each(PAN_VELOCITY)('$name', ({ history, velocity }) => {
    expect(pointerVelocity(history.map(([t, x]) => ({ t, x })))).toBeCloseTo(velocity, 5)
  })

  it('is 0 with no history', () => {
    expect(pointerVelocity([])).toBe(0)
  })
})

describe('rowVelocity: the row’s own velocity at release (motion-dom MotionValue)', () => {
  it.each(VALUE_VELOCITY)('$name', ({ sets, releaseAt, velocity }) => {
    const samples = [{ t: 0, x: 0 }, ...sets.map(([t, x]) => ({ t, x }))]
    expect(rowVelocity(samples, releaseAt)).toBeCloseTo(velocity, 5)
  })

  it('is 0 with no samples, or when the last sample is more than 30 ms old', () => {
    expect(rowVelocity([], 0)).toBe(0)
    expect(
      rowVelocity(
        [
          { t: 0, x: 0 },
          { t: 10, x: -20 },
        ],
        41,
      ),
    ).toBe(0)
  })

  it('counts a row at rest since before the drag as 30 ms old', () => {
    expect(
      rowVelocity(
        [
          { t: Number.NEGATIVE_INFINITY, x: -96 },
          { t: 500, x: -99 },
        ],
        505,
      ),
    ).toBeCloseTo(-100, 9)
  })
})

describe('tint and swipe Delete opacity follow x as framer mapped them', () => {
  it.each(MAPS)('at x = %d: Delete %d, tint %d', (x, action, tint) => {
    expect(actionOpacity(x)).toBeCloseTo(action, 9)
    expect(tintOpacity(x)).toBeCloseTo(tint, 9)
  })
})

describe('xAt: where a playing snap has the row', () => {
  const samples = { values: [-60, -50, -30, 0], step: 10 }

  it('reads the sample at a sample time and interpolates between samples', () => {
    expect(xAt(samples, 0)).toBe(-60)
    expect(xAt(samples, 10)).toBe(-50)
    expect(xAt(samples, 15)).toBe(-40)
    expect(xAt(samples, 27.5)).toBe(-7.5)
  })

  it('holds the ends before the start and after the end', () => {
    expect(xAt(samples, -5)).toBe(-60)
    expect(xAt(samples, 30)).toBe(0)
    expect(xAt(samples, 1000)).toBe(0)
  })

  it('follows a real snap’s samples', () => {
    const snap = springSamples(
      { from: -110, to: 0, velocity: 900, stiffness: 420, damping: 40 },
      120,
    )
    expect(xAt(snap, 0)).toBe(-110)
    expect(xAt(snap, snap.duration)).toBe(0)
    const mid = xAt(snap, snap.step * 3.5)
    expect(mid).toBeGreaterThan(snap.values[3] ?? NaN)
    expect(mid).toBeLessThan(snap.values[4] ?? NaN)
  })
})
