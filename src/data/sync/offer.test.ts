// @vitest-environment node
// When "Make sync private" is offered (PRIVATE-SYNC 4.1, AC-M12): every condition that costs no
// request, one at a time. Invented device ids.
import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '../core/types'
import { PRIVATE_FROM, moveOffered, type OfferFacts } from './offer'
import { STALE_AFTER_MS } from './registry'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 15, 4, 0, 0)

const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  name: '',
  app: PRIVATE_FROM,
  mode: 'rpc',
  rpcSince: NOW - 30 * DAY,
  e2e: false,
  seen: NOW - DAY,
  ...over,
})

const facts = (over: Partial<OfferFacts> = {}): OfferFacts => ({
  kind: 'plain',
  established: true,
  paused: false,
  fenced: false,
  locks: true,
  cas: true,
  devices: new Map([
    ['dev001', device()],
    ['dev002', device({ app: '0.22.0' })],
  ]),
  legacySeen: {},
  now: NOW,
  ...over,
})

const withOther = (other: Partial<DeviceInfo>): OfferFacts =>
  facts({
    devices: new Map([
      ['dev001', device()],
      ['dev002', device(other)],
    ]),
  })

describe('moveOffered (AC-M12)', () => {
  it('is offered when every condition holds', () => {
    expect(moveOffered(facts())).toBe(true)
  })

  it('is not offered on a private bucket, an unestablished, a paused or a fenced one', () => {
    expect(moveOffered(facts({ kind: 'e2e' }))).toBe(false)
    expect(moveOffered(facts({ established: false }))).toBe(false)
    expect(moveOffered(facts({ paused: true }))).toBe(false)
    expect(moveOffered(facts({ fenced: true }))).toBe(false)
  })

  it('is not offered without Web Locks, or on a transport that cannot compare-and-set', () => {
    expect(moveOffered(facts({ locks: false }))).toBe(false)
    expect(moveOffered(facts({ cas: false }))).toBe(false)
  })

  it('is not offered while a recent device runs a release below release 1', () => {
    expect(moveOffered(withOther({ app: '0.20.0' }))).toBe(false)
    expect(moveOffered(withOther({ app: '0.9.2' }))).toBe(false)
    expect(moveOffered(withOther({ app: '0.21.1' }))).toBe(true)
  })

  it('is not offered while a recent device writes the table, or was never seen', () => {
    expect(moveOffered(withOther({ mode: 'table' }))).toBe(false)
    expect(moveOffered(withOther({ seen: 0 }))).toBe(false)
    expect(moveOffered(withOther({ seen: 0, app: '0.30.0' }))).toBe(false)
  })

  it('leaves out a device that last pushed more than 60 days ago', () => {
    const stale = NOW - STALE_AFTER_MS - 1
    expect(moveOffered(withOther({ app: '0.9.2', mode: 'table', seen: stale }))).toBe(true)
    expect(moveOffered(withOther({ app: '0.9.2', seen: NOW - STALE_AFTER_MS }))).toBe(false)
  })

  it('counts this device too: one of its own tabs on an older release is a device left behind', () => {
    expect(moveOffered(facts({ devices: new Map([['dev001', device({ app: '0.20.0' })]]) }))).toBe(
      false,
    )
  })

  it('is not offered while an older writer was seen within 60 days', () => {
    for (const kind of ['v084', 'v085', 'v5pre'] as const) {
      expect(moveOffered(facts({ legacySeen: { [kind]: NOW - 59 * DAY } })), kind).toBe(false)
      expect(moveOffered(facts({ legacySeen: { [kind]: NOW - 61 * DAY } })), kind).toBe(true)
    }
  })
})
