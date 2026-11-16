import { useEffect, useState } from 'react'

interface MediaQueryOptions {
  /** The value before the query is read (the first render). `false` unless given. */
  initial?: () => boolean
  /**
   * Read the query once the component mounts, not only on its next change. On by default. The
   * Edit sheet turns it off: it has always taken its first answer from `initial` alone (the
   * window's width) and listened for changes only.
   */
  readOnMount?: boolean
}

const never = () => false

/** Whether `query` matches, kept up to date as the viewport changes. */
export function useMediaQuery(
  query: string,
  { initial = never, readOnMount = true }: MediaQueryOptions = {},
): boolean {
  const [matches, setMatches] = useState(initial)

  useEffect(() => {
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    if (readOnMount) update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query, readOnMount])

  return matches
}
