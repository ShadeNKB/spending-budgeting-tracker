import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLatch } from './useLatch'

describe('useLatch', () => {
  it('stays false until the value first turns true', () => {
    const { result, rerender } = renderHook(({ value }) => useLatch(value), {
      initialProps: { value: false },
    })
    expect(result.current).toBe(false)
    rerender({ value: false })
    expect(result.current).toBe(false)
  })

  it('turns true on the same render the value does, and stays true', () => {
    const { result, rerender } = renderHook(({ value }) => useLatch(value), {
      initialProps: { value: false },
    })
    rerender({ value: true })
    expect(result.current).toBe(true)
    rerender({ value: false })
    expect(result.current).toBe(true)
    rerender({ value: false })
    expect(result.current).toBe(true)
  })

  it('starts true when the first value is true', () => {
    const { result, rerender } = renderHook(({ value }) => useLatch(value), {
      initialProps: { value: true },
    })
    expect(result.current).toBe(true)
    rerender({ value: false })
    expect(result.current).toBe(true)
  })
})
