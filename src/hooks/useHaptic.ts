const vibrate = (pattern: number | number[] = 8): void => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(pattern)
    } catch {
      /* noop */
    }
  }
}

// One module-level function, so it is a stable dependency for effects and memos.
export function useHaptic() {
  return vibrate
}
