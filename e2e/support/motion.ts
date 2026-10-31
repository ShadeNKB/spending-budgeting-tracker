import { expect, type CDPSession, type Page } from '@playwright/test'
import { seed, waitForApp, type SeedOptions } from './a11y'

// Characterization harness for motion (T5b spec §9.2): the sheets, the command palette, the
// toasts and the ledger swipe, sampled on every animation frame as a person sees them (boxes,
// opacity, computed transforms, the DOM) and never through an animation library's own state,
// so one spec holds framer-motion and its CSS / Web Animations rewrite to the same behaviour.
// Invented data only.
//
// A frame here is a tick of the page's own requestAnimationFrame: a painted frame. The date
// starts at the shared seed's moment and runs on (seed's `date: 'running'`), and Playwright's
// clock is not installed: it would run requestAnimationFrame off its timers, every 16 ms
// whether or not a frame was painted, and an animation the browser runs (CSS, Web Animations)
// would then read as stuck for several ticks and then jump. The checks give a frame of slack,
// and on a busy machine allow for the time the page lost (busyTime) and for animations the
// browser holds before they start (startDelay).

declare global {
  interface Window {
    /** Recordings in progress, by key (see `startRecording`). */
    __e2eMotion?: Record<string, Promise<Frame[]>>
    /** Recordings asked to stop now (see finishRecording), by key. */
    __e2eMotionStop?: Record<string, boolean>
    /** The last toast key handed out (see ToastLook.key). */
    __e2eToastSeq?: number
  }
}

export type Motion = 'no-preference' | 'reduce'

/**
 * Seeds the page as `seed` does (the Singapore date, running on from the seed's moment, and
 * invented rows), with motion as asked (normal unless `motion` says otherwise: `seed` itself
 * turns Reduce Motion on), loads `path` and waits until the app has gone idle and mounted its
 * hidden overlays, so a first open measures the overlay and not the download of its chunk.
 */
export async function loadInMotion(
  page: Page,
  path: string,
  opts: Omit<SeedOptions, 'date'> & { motion?: Motion } = {},
): Promise<void> {
  await seed(page, { ...opts, date: 'running' })
  await page.emulateMedia({ reducedMotion: opts.motion ?? 'no-preference' })
  await page.goto(path)
  await waitForApp(page)
  // The toast region mounts with the other hidden overlays once the app is idle.
  await expect(page.locator('[role="region"][aria-label="Notifications"]')).toBeAttached({
    timeout: 15_000,
  })
  await page.waitForLoadState('networkidle')
}

// ─── what a frame shows ──────────────────────────────────────────────────────

/** Where an element is drawn, transforms included (getBoundingClientRect), CSS px. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What one element shows on one frame. */
export interface Look {
  box: Box
  opacity: number
  /** The computed `transform` and the individual `translate`, `scale` and `rotate`. */
  transform: string
  translate: string
  scale: string
  rotate: string
  /** It or an ancestor is inert: out of reach of presses and focus. */
  inert: boolean
}

/** A modal layer (a sheet or the palette), found by its dialog's accessible name. */
export interface LayerLook {
  /** Dialogs with that name: more than one is a duplicate. */
  dialogs: number
  panel: Look | null
  /** The dimmed backdrop: the element before the dialog in its layer box. */
  backdrop: Look | null
  /** Focus is inside the dialog. */
  focused: boolean
  /** The dialog carries the mark `markLayer` set: it is the same element as then. */
  marked: boolean
}

export interface ToastLook extends Look {
  /** Stable per element: `t1`, `t2`, … in the order the toasts first showed. */
  key: string
  text: string
  /**
   * Its place in the stack, transforms left out (its layout box in the region): where it is
   * drawn when nothing moves it.
   */
  place: Box
  /** The countdown bar's own horizontal scale (1 full, 0 run out); null with no bar shown. */
  bar: number | null
  /** A press at the toast's centre lands on the toast. */
  hit: boolean
}

export interface RowLook {
  /** How far the row's content is off its place, CSS px (negative: swiped left). */
  x: number
  /** The opacity of the swipe Delete action under the row. */
  action: number
}

export interface Frame {
  /** The frame's time (the requestAnimationFrame timestamp), ms. */
  t: number
  /** The time of the frame before it, or of the recording's start for the first one, ms. */
  after: number
  /** Overlay boxes portaled into <body>: everything fixed there but the app's root. */
  boxes: number
  layer?: LayerLook
  toasts?: ToastLook[]
  row?: RowLook | null
}

export interface Watch {
  /** A sheet or the palette, by its dialog's accessible name. */
  layer?: string
  /** The toasts in the Notifications region, bottom of the stack first in the DOM. */
  toasts?: boolean
  /** A ledger row, by its expense id. */
  row?: string
  /**
   * Stop once this has held for three frames in a row: the layer open and at rest (`open`),
   * the layer gone (`gone`), exactly `toastCount` toasts, all at rest (`rest`), or nothing
   * watched changing (`still`). At rest: in place, untransformed, fully opaque.
   */
  until?: 'open' | 'gone' | 'rest' | 'still'
  /** For `until: 'rest'`: how many toasts there are once they rest (default 1). */
  toastCount?: number
  /** Record at least this long, ms (default 0). */
  minMs?: number
  /** Record at most this long, ms. */
  maxMs: number
}

let recordings = 0

/**
 * Starts sampling what `watch` names on every animation frame, in the page; returns the key
 * that `finishRecording` takes. The first sample is taken on the next frame.
 */
export async function startRecording(page: Page, watch: Watch): Promise<string> {
  recordings += 1
  const key = `r${String(recordings)}`
  await page.evaluate(
    ({ w, key }) => {
      const IDENTITY =
        /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\))$/
      const nums = (v: string) => (v.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
      const isStill = (l: Look) =>
        IDENTITY.test(l.transform) &&
        (l.translate === 'none' || nums(l.translate).every((n) => n === 0)) &&
        (l.scale === 'none' || nums(l.scale).every((n) => n === 1)) &&
        (l.rotate === 'none' || nums(l.rotate).at(-1) === 0)

      const look = (el: Element): Look => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return {
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
          opacity: Number(s.opacity),
          transform: s.transform,
          translate: s.translate,
          scale: s.scale,
          rotate: s.rotate,
          inert: el.closest('[inert]') !== null,
        }
      }
      const nameOf = (d: Element) => {
        const label = d.getAttribute('aria-label')
        if (label !== null) return label
        const by = d.getAttribute('aria-labelledby')
        return by ? (document.getElementById(by)?.textContent ?? '') : ''
      }
      const layerLook = (name: string): LayerLook => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
          (d) => nameOf(d) === name,
        )
        const d = dialogs[0]
        if (!d) {
          return { dialogs: 0, panel: null, backdrop: null, focused: false, marked: false }
        }
        const backdrop = d.previousElementSibling
        return {
          dialogs: dialogs.length,
          panel: look(d),
          backdrop: backdrop ? look(backdrop) : null,
          focused: d.contains(document.activeElement),
          marked: d.hasAttribute('data-e2e-mark'),
        }
      }
      const toastLooks = (): ToastLook[] => {
        const region = document.querySelector('[role="region"][aria-label="Notifications"]')
        if (!region) return []
        return [...region.children].flatMap((el) => {
          if (!(el instanceof HTMLElement)) return []
          if (el.dataset.e2eToast === undefined) {
            window.__e2eToastSeq = (window.__e2eToastSeq ?? 0) + 1
            el.dataset.e2eToast = `t${String(window.__e2eToastSeq)}`
          }
          const base = look(el)
          // The countdown: a 2 px bar along the bottom (offsetHeight ignores transforms).
          const bar = [...el.querySelectorAll<HTMLElement>('*')].find(
            (n) =>
              n.offsetHeight === 2 &&
              n.offsetWidth > 0 &&
              getComputedStyle(n).position === 'absolute',
          )
          const scale = (n: HTMLElement) => n.getBoundingClientRect().width / n.offsetWidth
          const { x, y, width, height } = base.box
          const hit = document.elementFromPoint(x + width / 2, y + height / 2)
          // Offsets are layout, before any transform, from the offset parent's padding edge.
          const parent = el.offsetParent
          const origin = parent?.getBoundingClientRect()
          return [
            {
              ...base,
              key: el.dataset.e2eToast ?? '',
              text: (el.textContent ?? '').trim(),
              place: {
                x: (origin?.x ?? 0) + (parent?.clientLeft ?? 0) + el.offsetLeft,
                y: (origin?.y ?? 0) + (parent?.clientTop ?? 0) + el.offsetTop,
                width: el.offsetWidth,
                height: el.offsetHeight,
              },
              bar: bar ? scale(bar) / scale(el) : null,
              hit: hit !== null && el.contains(hit),
            },
          ]
        })
      }
      const rowLook = (id: string): RowLook | null => {
        const row = document.querySelector(`[data-ledger-row="${CSS.escape(id)}"]`)
        const button = row?.querySelector('button[aria-label^="Edit "]')
        const action = row?.querySelector('[data-swipe-delete]')
        if (!row || !button || !action) return null
        return {
          x: button.getBoundingClientRect().left - row.getBoundingClientRect().left,
          action: Number(getComputedStyle(action).opacity),
        }
      }
      const boxes = () =>
        [...document.body.children].filter(
          (el) => el.id !== 'root' && getComputedStyle(el).position === 'fixed',
        ).length

      const frames: Frame[] = []
      let held = 0
      let last = ''
      const started = performance.now()
      let previous = started
      const done = new Promise<Frame[]>((resolve) => {
        const tick = (t: number) => {
          const frame: Frame = { t, after: previous, boxes: boxes() }
          previous = t
          if (w.layer !== undefined) frame.layer = layerLook(w.layer)
          if (w.toasts) frame.toasts = toastLooks()
          if (w.row !== undefined) frame.row = rowLook(w.row)
          frames.push(frame)
          let holds = false
          if (w.until === 'open') {
            const panel = frame.layer?.panel ?? null
            const backdrop = frame.layer?.backdrop ?? null
            holds =
              panel !== null &&
              isStill(panel) &&
              panel.opacity === 1 &&
              (backdrop === null || backdrop.opacity === 1)
          } else if (w.until === 'gone') {
            holds = frame.layer?.dialogs === 0
          } else if (w.until === 'rest') {
            const toasts = frame.toasts ?? []
            holds =
              toasts.length === (w.toastCount ?? 1) &&
              toasts.every((toast) => isStill(toast) && toast.opacity === 1)
          } else if (w.until === 'still') {
            // The countdown bar runs on by design: it is not motion to wait for.
            const now = JSON.stringify({
              ...frame,
              t: 0,
              after: 0,
              toasts: frame.toasts?.map((toast) => ({ ...toast, bar: null })),
            })
            holds = now === last
            last = now
          }
          held = holds ? held + 1 : 0
          const elapsed = performance.now() - started
          const enough = elapsed >= (w.minMs ?? 0) && held >= 3
          if (elapsed >= w.maxMs || enough || window.__e2eMotionStop?.[key] === true)
            resolve(frames)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      window.__e2eMotion = { ...window.__e2eMotion, [key]: done }
    },
    { w: watch, key },
  )
  return key
}

/**
 * Waits for the recording to end (see Watch), or ends it on its next frame (`now`), and returns
 * its frames.
 */
export async function finishRecording(
  page: Page,
  key: string,
  opts: { now?: boolean } = {},
): Promise<Frame[]> {
  return page.evaluate(
    async ({ k, now }) => {
      if (now) window.__e2eMotionStop = { ...window.__e2eMotionStop, [k]: true }
      const frames = (await window.__e2eMotion?.[k]) ?? []
      delete window.__e2eMotion?.[k]
      delete window.__e2eMotionStop?.[k]
      return frames
    },
    { k: key, now: opts.now === true },
  )
}

/** Records what `watch` names on every frame while `action` runs, until the watch ends. */
export async function record(
  page: Page,
  watch: Watch,
  action: () => Promise<void>,
): Promise<Frame[]> {
  const key = await startRecording(page, watch)
  await action()
  return finishRecording(page, key)
}

/** Marks the open dialog named `name`, so a later frame can tell it is the same element. */
export async function markLayer(page: Page, name: string): Promise<void> {
  const marked = await page.evaluate((n) => {
    const nameOf = (d: Element) => {
      const label = d.getAttribute('aria-label')
      if (label !== null) return label
      const by = d.getAttribute('aria-labelledby')
      return by ? (document.getElementById(by)?.textContent ?? '') : ''
    }
    const d = [...document.querySelectorAll('[role="dialog"]')].find((el) => nameOf(el) === n)
    d?.setAttribute('data-e2e-mark', '')
    return d !== undefined
  }, name)
  expect(marked, `dialog "${name}" to mark`).toBe(true)
}

// ─── reading the frames ──────────────────────────────────────────────────────

const IDENTITY_TRANSFORM =
  /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\))$/

const numbers = (value: string) => (value.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)

/**
 * The transform and individual transform properties that are not the identity, as text ('' when
 * the element is drawn exactly in its place). `none` and zero translations, a scale of 1 and a
 * zero rotation count as the identity.
 */
export function moved(look: Pick<Look, 'transform' | 'translate' | 'scale' | 'rotate'>): string {
  const parts: string[] = []
  if (!IDENTITY_TRANSFORM.test(look.transform)) parts.push(look.transform)
  if (look.translate !== 'none' && numbers(look.translate).some((n) => n !== 0))
    parts.push(`translate: ${look.translate}`)
  if (look.scale !== 'none' && numbers(look.scale).some((n) => n !== 1))
    parts.push(`scale: ${look.scale}`)
  if (look.rotate !== 'none' && numbers(look.rotate).at(-1) !== 0)
    parts.push(`rotate: ${look.rotate}`)
  return parts.join(' ')
}

/** The frames on which the layer's dialog was in the page. */
export const withPanel = (frames: readonly Frame[]) =>
  frames.flatMap((f) =>
    f.layer?.panel ? [{ t: f.t, boxes: f.boxes, layer: f.layer, panel: f.layer.panel }] : [],
  )

/**
 * The frames of a closing layer from the first that shows the close (the dialog inert, moved
 * off its place or fading) while it is still in the page: frames recorded before the close took
 * effect are left out.
 */
export function leavingFrames(frames: readonly Frame[]) {
  const shown = withPanel(frames)
  const from = shown.findIndex((f) => f.panel.inert || moved(f.panel) !== '' || f.panel.opacity < 1)
  return from < 0 ? [] : shown.slice(from)
}

/** One frame of an idle 60 Hz page, ms. */
export const FRAME_MS = 1000 / 60

/**
 * The time (ms) from the frame before the first one that `shows` (or from the recording's start,
 * when that is the first frame) to that frame: what is shown mounted at most this long before it
 * (0 when no frame shows it). An idle page paints every frame; a loaded one, WebKit above all,
 * can go 100 ms or more between frames, while a CSS transition runs on the clock from the
 * moment its element mounted. By default, the layer's dialog.
 */
export function firstShownGap(
  frames: readonly Frame[],
  shows: (frame: Frame) => boolean = (frame) => Boolean(frame.layer?.panel),
): number {
  const shown = frames.find(shows)
  return shown ? shown.t - shown.after : 0
}

/**
 * How long a closing layer was seen to stay in the page (ms): from the first frame that shows
 * its close to the first frame without its dialog (Infinity when it never left, 0 when no frame
 * showed it closing). Time, not frames: frames can be far apart on a loaded machine.
 */
export function stayedFor(frames: readonly Frame[]): number {
  const first = leavingFrames(frames)[0]
  if (!first) return 0
  const gone = frames.find((f) => f.t > first.t && f.layer?.dialogs === 0)
  return gone ? gone.t - first.t : Infinity
}

/** Vertical shift of a box's centre from `to` (transform-origin centre: scale-free), px. */
export const shiftY = (box: Box, to: Box) => box.y + box.height / 2 - (to.y + to.height / 2)

/** Horizontal scale of a box against `to`. */
export const scaleX = (box: Box, to: Box) => box.width / to.width

/** The steps between consecutive values that go the wrong way by more than `slack`. */
export function wrongWay(
  values: readonly number[],
  direction: 'up' | 'down',
  slack: number,
): string[] {
  const out: string[] = []
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1] ?? 0
    const b = values[i] ?? 0
    if (direction === 'up' ? b < a - slack : b > a + slack)
      out.push(`#${String(i)}: ${a.toFixed(2)} → ${b.toFixed(2)}`)
  }
  return out
}

/**
 * The largest change per ms over any stretch of at least `windowMs` between samples. A stretch,
 * not a single step: a frame can be sampled a little before or after the animation updated it
 * (an animation driven by script runs in its own frame callback), which doubles one step and
 * halves the next, while a jump moves the whole stretch. A stretch that starts right after the
 * page stalled (a frame longer than 40 ms) is given the time the stall lost: the value read
 * then may still be where it was before the stall, and catch up on the next frame.
 */
export function fastestRate(samples: readonly { t: number; v: number }[], windowMs = 50): number {
  let fastest = 0
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]
    const b = samples.slice(i + 1).find((s) => a !== undefined && s.t - a.t >= windowMs)
    if (!a || !b) break
    const before = samples[i - 1]
    const stalled = before ? Math.max(0, a.t - before.t - 40) : 0
    fastest = Math.max(fastest, Math.abs(b.v - a.v) / (b.t - a.t + stalled))
  }
  return fastest
}

/** The span of time (ms) over which samples sat strictly between their two end values. */
export function transitionSpan(samples: readonly { t: number; v: number }[]): number {
  const between = samples.filter((s) => s.v > 0.001 && s.v < 0.999)
  const first = between[0]
  const last = between.at(-1)
  return first && last ? last.t - first.t : 0
}

/**
 * How long a value sat at its first reading before it began to change (ms): what a browser that
 * holds a just-started animation at its first frame (WebKit after a load, Chromium on a loaded
 * machine) adds to an exit. 0 when it changed by the next frame, or never changed.
 */
export function startDelay(samples: readonly { t: number; v: number }[], eps = 0.01): number {
  const first = samples[0]
  const second = samples[1]
  const moved = samples.find((s) => first !== undefined && Math.abs(s.v - first.v) > eps)
  if (!first || !second || !moved) return 0
  return Math.max(0, moved.t - second.t)
}

/**
 * The time a busy machine took from the page between `from` and `to` (ms): what every frame
 * interval there lasted beyond 40 ms. An animation driven by script can slow down with its
 * frames, so a timing bound allows for this on a loaded machine; on an idle one it is 0.
 */
export function busyTime(frames: readonly { t: number }[], from: number, to: number): number {
  let lost = 0
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    if (!a || !b || b.t <= from || a.t >= to) continue
    lost += Math.max(0, b.t - a.t - 40)
  }
  return lost
}

// ─── framer's springs (motion-dom 12.40 physics, mass 1, from rest) ─────────

/**
 * The step response of a spring with stiffness `k` and damping `c` (mass 1, starting at rest):
 * the share of the way it has travelled `ms` after it starts (0 before, about 1 at rest).
 */
export function springAt(k: number, c: number, ms: number): number {
  if (ms <= 0) return 0
  const t = ms / 1000
  const w0 = Math.sqrt(k)
  const zeta = c / (2 * Math.sqrt(k))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (((zeta * w0) / wd) * Math.sin(wd * t) + Math.cos(wd * t))
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  const wh = w0 * Math.sqrt(zeta * zeta - 1)
  return (
    1 - (Math.exp(-zeta * w0 * t) * (zeta * w0 * Math.sinh(wh * t) + wh * Math.cosh(wh * t))) / wh
  )
}

/** How far past its end a spring step goes at most, a share of the way (0: no overshoot). */
export function springOvershoot(k: number, c: number): number {
  let most = 0
  for (let ms = 0; ms < 1000; ms += 0.5) most = Math.max(most, springAt(k, c, ms) - 1)
  return most
}

/** The fastest a spring step travels, in shares of the way per ms. */
export function springPeakRate(k: number, c: number): number {
  let peak = 0
  for (let ms = 0; ms < 1000; ms += 0.5)
    peak = Math.max(peak, (springAt(k, c, ms + 0.5) - springAt(k, c, ms)) / 0.5)
  return peak
}

/**
 * How far progress samples (`p`: 0 at the start, 1 at the end) stray from a curve once it is
 * started at the best moment. The start is searched from 60 ms before the first sample to 40 ms
 * after the first one that has moved, so the result does not hang on which frame the motion
 * began in, nor on frames recorded before it began. Each sample may sit up to `slackMs` early or
 * late on the curve: a frame's timestamp is when it began, while an animation driven by script
 * computes its value when its own callback runs, later in a busy frame (the first frames of a
 * sheet mount a whole form). A sample may also lag by up to its `lag` (ms): the time a busy
 * machine took from the page before it (see busyTime), when a script-driven animation can fall
 * behind the clock. On an idle machine that is 0, and a wrong curve or duration strays far more
 * than one frame.
 */
export function curveError(
  samples: readonly { t: number; p: number; lag?: number }[],
  curve: (ms: number) => number,
  slackMs = 17,
): { error: number; start: number } {
  const first = samples[0]
  if (!first) return { error: Infinity, start: 0 }
  const moving = samples.find((s) => s.p > 0.01) ?? first
  const off = (p: number, at: number, lag: number) => {
    let nearest = Infinity
    for (let dt = -slackMs - lag; dt <= slackMs; dt += 1)
      nearest = Math.min(nearest, Math.abs(p - curve(at + dt)))
    return nearest
  }
  let best = { error: Infinity, start: first.t }
  for (let start = first.t - 60; start <= moving.t + 40; start += 1) {
    let error = 0
    for (const s of samples) {
      error = Math.max(error, off(s.p, s.t - start, s.lag ?? 0))
      if (error >= best.error) break
    }
    if (error < best.error) best = { error, start }
  }
  return best
}

/**
 * Progress samples for `curveError`, each with the lag a busy machine allows it: the time lost
 * to long frames between the first sample and it.
 */
export function withLag<T extends { t: number; p: number }>(samples: readonly T[]): T[] {
  const first = samples[0]
  return samples.map((s) => ({ ...s, lag: first ? busyTime(samples, first.t, s.t) : 0 }))
}

// ─── the ledger swipe ────────────────────────────────────────────────────────

/** framer-motion's drag constraints and release rule for a ledger row (LedgerRow.tsx). */
export const SWIPE = {
  /** Where a revealed row rests. */
  revealed: -96,
  /** The drag's left limit, and the share of a pull past it that still moves the row. */
  limit: -120,
  elastic: 0.12,
} as const

/** The swipe Delete action's opacity at a row offset `x` (−120 → 1, −20 → 0.6, 0 → 0). */
export function actionOpacityAt(x: number): number {
  if (x <= -120) return 1
  if (x <= -20) return 1 + ((x + 120) / 100) * (0.6 - 1)
  if (x < 0) return 0.6 * (-x / 20)
  return 0
}

/** Where a row dragged by `offset` px from rest sits during the drag. */
export function draggedTo(offset: number): number {
  if (offset > 0) return 0
  if (offset < SWIPE.limit) return SWIPE.limit + (offset - SWIPE.limit) * SWIPE.elastic
  return offset
}

export interface RowTarget {
  id: string
  /** The row's Edit button, where it is now. */
  box: Box
}

/** The `nth` ledger row in the page (0 first), with the box of its Edit button. */
export async function ledgerRow(page: Page, nth: number): Promise<RowTarget> {
  const button = page
    .locator('[data-ledger-row]')
    .nth(nth)
    .getByRole('button', { name: /^Edit / })
  await button.scrollIntoViewIfNeeded()
  const id = await page
    .locator('[data-ledger-row]')
    .nth(nth)
    .evaluate((el) => el.getAttribute('data-ledger-row') ?? '')
  const box = await button.boundingBox()
  if (!box || !id) throw new Error(`ledger row ${String(nth)} has no box`)
  return { id, box }
}

/** The row's offset and its swipe action's opacity now (null when the row is not mounted). */
export function rowNow(page: Page, id: string): Promise<RowLook | null> {
  return page.evaluate((rowId) => {
    const row = document.querySelector(`[data-ledger-row="${CSS.escape(rowId)}"]`)
    const button = row?.querySelector('button[aria-label^="Edit "]')
    const action = row?.querySelector('[data-swipe-delete]')
    if (!row || !button || !action) return null
    return {
      x: button.getBoundingClientRect().left - row.getBoundingClientRect().left,
      action: Number(getComputedStyle(action).opacity),
    }
  }, id)
}

/** Waits for the row to come to rest at `x` (±0.5 px). */
export async function expectRowAt(page: Page, id: string, x: number, timeout = 5000) {
  await expect
    .poll(async () => (await rowNow(page, id))?.x ?? NaN, {
      message: `row ${id} comes to rest at ${String(x)}`,
      timeout,
    })
    .toBeCloseTo(x, 0)
}

/**
 * A mouse press at `x, y`, a drag of `dx` px in `steps` even moves `stepMs` apart, a rest of
 * `restMs` with the button held, and the release (unless `release` is false).
 */
export async function mouseSwipe(
  page: Page,
  at: { x: number; y: number },
  dx: number,
  opts: { steps: number; stepMs: number; restMs: number; release?: boolean },
): Promise<void> {
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let step = 1; step <= opts.steps; step++) {
    await page.mouse.move(at.x + (dx * step) / opts.steps, at.y)
    if (opts.stepMs > 0) await page.waitForTimeout(opts.stepMs)
  }
  if (opts.restMs > 0) await page.waitForTimeout(opts.restMs)
  if (opts.release !== false) await page.mouse.up()
}

/**
 * A real touch drag through the browser's input pipeline (Chromium, DevTools protocol): the
 * browser decides between scrolling and handing the moves to the page, as on a phone.
 */
export async function touchSwipe(
  cdp: CDPSession,
  page: Page,
  from: { x: number; y: number },
  by: { dx: number; dy: number },
  opts: { steps: number; stepMs: number; restMs: number },
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  })
  for (let step = 1; step <= opts.steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + (by.dx * step) / opts.steps,
          y: from.y + (by.dy * step) / opts.steps,
        },
      ],
    })
    await page.waitForTimeout(opts.stepMs)
  }
  if (opts.restMs > 0) await page.waitForTimeout(opts.restMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** `steps` even moves that add up to `dx` px: a path for `pointerSwipe`. */
export const evenPath = (dx: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, i) => (dx * (i + 1)) / steps)

/**
 * A swipe made of pointer events dispatched in the page on the row's Edit button: a press
 * 40 px in from the button's right end, a move to each offset of `path` (px from the press)
 * `stepMs` apart, a rest of `restMs` and the release where the last move left off. A step or a
 * rest of 0 waits one animation frame instead, so each move is taken in a frame of its own. WebKit
 * here has no touch input to drive (`touch`); and a flick (`mouse`) must keep to its pace, which
 * the test runner's own round trips cannot promise on a busy machine. Timed by the page's clock,
 * these reach the same handlers as a person's. Returns how long the swipe took, press to
 * release (ms).
 */
export async function pointerSwipe(
  page: Page,
  id: string,
  opts: {
    pointerType: 'mouse' | 'touch'
    path: readonly number[]
    stepMs: number
    restMs: number
  },
): Promise<number> {
  return page.evaluate(
    async ({ rowId, pointerType, path, stepMs, restMs }) => {
      const row = document.querySelector(`[data-ledger-row="${CSS.escape(rowId)}"]`)
      const button = row?.querySelector('button[aria-label^="Edit "]')
      if (!button) throw new Error(`row ${rowId} has no Edit button`)
      const r = button.getBoundingClientRect()
      const x0 = r.right - 40
      const y = r.top + r.height / 2
      const touch = pointerType === 'touch'
      const pointer = (type: string, x: number, buttons: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: touch ? 7 : 1,
          pointerType,
          isPrimary: true,
          // A move presses no button of its own (-1); a press and a release are the main one.
          button: type === 'pointermove' ? -1 : 0,
          buttons,
          clientX: x,
          clientY: y,
          width: touch ? 12 : 1,
          height: touch ? 12 : 1,
          pressure: buttons > 0 ? 0.5 : 0,
        })
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          if (ms > 0) setTimeout(resolve, ms)
          else requestAnimationFrame(() => resolve())
        })
      const pressedAt = performance.now()
      button.dispatchEvent(pointer('pointerdown', x0, 1))
      for (const dx of path) {
        await wait(stepMs)
        button.dispatchEvent(pointer('pointermove', x0 + dx, 1))
      }
      await wait(restMs)
      button.dispatchEvent(pointer('pointerup', x0 + (path.at(-1) ?? 0), 0))
      return performance.now() - pressedAt
    },
    { rowId: id, ...opts },
  )
}

/** How a flick's moves were paced (see flickRow). */
export type FlickPace = 'frames' | 'timers'

/**
 * A flick on the row: 72 px in two moves, released right after (a thousand px/s and more): short
 * of the 76 px that reveals by distance, far past the 650 px/s that reveals by speed. Each try
 * starts a second after anything moved, so the press begins a gesture of its own. The first try
 * takes a move in each of the page's frames, as a finger's moves reach a phone's page; a browser
 * that paints too slowly for a flick's pace that way (WebKit here goes 50–250 ms between frames)
 * gets its next tries on timers, moves 16 ms apart as a 60 Hz touch screen sends them, which the
 * swipe judges by their own times. A try that took over 120 ms from press to release (a machine
 * too busy to keep any pace) does not count and the next row is flicked, up to `rows.length`
 * tries. Returns the row flicked at pace and how, or null when none could be.
 */
export async function flickRow(
  page: Page,
  rows: readonly string[],
  pointerType: 'mouse' | 'touch',
): Promise<{ id: string; pace: FlickPace } | null> {
  let pace: FlickPace = 'frames'
  for (const id of rows) {
    await page.waitForTimeout(1000)
    const took = await pointerSwipe(page, id, {
      pointerType,
      path: [-4, -72],
      stepMs: pace === 'frames' ? 0 : 16,
      restMs: pace === 'frames' ? 0 : 16,
    })
    if (took <= 120) return { id, pace }
    pace = 'timers'
  }
  return null
}
