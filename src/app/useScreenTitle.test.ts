import { describe, expect, it } from 'vitest'
import { screenTitle } from './useScreenTitle'

describe('screenTitle (F-107)', () => {
  it('names each screen before the app', () => {
    expect(screenTitle('/')).toBe('Pulse · SpendTrack')
    expect(screenTitle('/pulse')).toBe('Pulse · SpendTrack')
    expect(screenTitle('/ledger')).toBe('Ledger · SpendTrack')
    expect(screenTitle('/ledger/')).toBe('Ledger · SpendTrack')
    expect(screenTitle('/insights')).toBe('Insights · SpendTrack')
  })

  it('is the app alone for any other path, an inherited key included', () => {
    expect(screenTitle('/nowhere')).toBe('SpendTrack')
    expect(screenTitle('/constructor')).toBe('SpendTrack')
  })
})
