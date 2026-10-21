import { useState } from 'react'

/**
 * False until `value` is first true, then true for the component's lifetime.
 * Latches during render (no effect, no ref), so the first true render already returns true.
 */
export function useLatch(value: boolean): boolean {
  const [latched, setLatched] = useState(value)
  if (value && !latched) setLatched(true)
  return latched || value
}
