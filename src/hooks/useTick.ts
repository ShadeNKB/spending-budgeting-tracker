import { useEffect, useState } from 'react'

/** Re-renders every `ms` while mounted, so relative times ("2m ago") stay current. */
export function useTick(ms: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
}
