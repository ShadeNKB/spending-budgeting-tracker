import { useEffect, useState } from 'react'
import { whenIdle } from '../lib/whenIdle'

/** False until the page has loaded and gone idle once; then true for good. */
export function useIdle(): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(
    () =>
      whenIdle(() => {
        setIdle(true)
      }),
    [],
  )
  return idle
}
