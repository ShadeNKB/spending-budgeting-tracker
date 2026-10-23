// A deterministic virtual-time scheduler: a priority queue on (time, seq) with a microtask drain
// after every event. No real timer is ever used, so runs are exact and seed-reproducible.
import type { ClockPort } from '../legacy/v084'

interface Timer {
  readonly at: number
  readonly seq: number
  readonly fn: () => void
}

/** Microtask turns given to async device code after each event (enough for one await chain). */
const DRAIN_TURNS = 24

export class VirtualClock {
  now: number
  private seq = 0
  private heap: Timer[] = []
  private readonly cancelled = new Set<number>()
  /** Events processed so far (cost metric and a guard against runaway loops). */
  processed = 0

  constructor(start: number) {
    this.now = start
  }

  setTimeout(fn: () => void, ms: number): number {
    const t: Timer = { at: this.now + Math.max(0, ms), seq: ++this.seq, fn }
    this.push(t)
    return t.seq
  }

  clearTimeout(handle: number): void {
    this.cancelled.add(handle)
  }

  /** The legacy clients' port (their Date.now and setTimeout). */
  port(skew = 0): ClockPort {
    return {
      now: () => this.now + skew,
      setTimeout: (fn, ms) => this.setTimeout(fn, ms),
      clearTimeout: (h) => {
        this.clearTimeout(h)
      },
    }
  }

  get pending(): number {
    return this.heap.length
  }

  /** Lets queued microtasks (await continuations) run. */
  async drain(): Promise<void> {
    for (let i = 0; i < DRAIN_TURNS; i++) await Promise.resolve()
  }

  /** Runs every event due at or before `until`, in (time, seq) order, then sets now = until. */
  async runUntil(until: number): Promise<void> {
    await this.drain()
    for (;;) {
      const top = this.heap[0]
      if (top === undefined || top.at > until) break
      this.pop()
      if (this.cancelled.delete(top.seq)) continue
      this.now = Math.max(this.now, top.at)
      this.processed++
      top.fn()
      await this.drain()
    }
    this.now = Math.max(this.now, until)
  }

  run(ms: number): Promise<void> {
    return this.runUntil(this.now + ms)
  }

  private less(a: Timer, b: Timer): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq)
  }

  private push(t: Timer): void {
    const h = this.heap
    h.push(t)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      const parent = h[p]
      const cur = h[i]
      if (parent === undefined || cur === undefined || !this.less(cur, parent)) break
      h[p] = cur
      h[i] = parent
      i = p
    }
  }

  private pop(): void {
    const h = this.heap
    const last = h.pop()
    if (last === undefined || h.length === 0) return
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      const hm = (): Timer | undefined => h[m]
      const hl = h[l]
      const hr = h[r]
      const cur = hm()
      if (hl !== undefined && cur !== undefined && this.less(hl, cur)) m = l
      const best = hm()
      if (hr !== undefined && best !== undefined && this.less(hr, best)) m = r
      if (m === i) break
      const a = h[i]
      const b = h[m]
      if (a === undefined || b === undefined) break
      h[i] = b
      h[m] = a
      i = m
    }
  }
}
