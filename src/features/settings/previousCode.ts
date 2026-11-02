// Codes as Settings › Sync keeps and shows them. The Reconnect slot (P3-18): a Disconnect leaves
// the code here for 30 days, so the unlinked view can offer "Reconnect" instead of a new code
// that would split the devices. It lives under `st5:`, so Remove from this device wipes it, and
// its key says `synckey`, so the raw export leaves it behind (lib/rescue.ts) in this build and in
// the 0.10.0 and 0.9.2 a rollback runs, whose patterns already match that word. Masking follows
// core's `maskCode` (F-104):
// the UI never imports src/data, and a code it shows here is always a UUID.

import { safeSet, storage } from '../../services/storage'

export const PREV_KEY = 'st5:synckey:prev'

const KEEP_MS = 30 * 24 * 60 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PreviousCode {
  readonly code: string
  /** Epoch ms after which the slot is ignored. */
  readonly until: number
  /**
   * This device had found (or made) the code's relay copy, so it may create it again (P3-5).
   * Not: it reconnects as a join, which never creates one (the code may be mistyped).
   */
  readonly established: boolean
}

/** The remembered code, or null. Never removes anything: an unreadable slot just reads as none. */
export function readPrevious(now: number): PreviousCode | null {
  let value: unknown
  try {
    const raw = localStorage.getItem(PREV_KEY)
    if (raw === null) return null
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || !('code' in value) || !('until' in value)) {
    return null
  }
  const { code, until } = value
  if (typeof code !== 'string' || !UUID.test(code) || typeof until !== 'number') return null
  const established = 'established' in value && value.established === true
  return until > now ? { code, until, established } : null
}

/**
 * Remembers `code` for 30 days, with whether this device is established on it (read from its
 * saved setup, so call it before the Disconnect). Best effort: storage that refuses it keeps
 * nothing, and a setup that cannot be read counts as not established (it never creates).
 */
export function keepPrevious(code: string, now: number): void {
  try {
    const saved = storage.getSyncConfig()
    const established = saved?.kind === 'plain' && saved.code === code && saved.established
    safeSet(PREV_KEY, JSON.stringify({ code, until: now + KEEP_MS, established }))
  } catch {
    // Full or blocked: the unlinked view simply offers no Reconnect.
  }
}

export function forgetPrevious(): void {
  try {
    localStorage.removeItem(PREV_KEY)
  } catch {
    // Blocked storage holds no slot to forget.
  }
}

/** `••••-…-1a2b`: the last 4 characters only. */
export const maskCode = (code: string): string => `••••-…-${code.slice(-4)}`

/** The last 4 characters spelled out ("1 a 2 b"), so a screen reader reads them one by one. */
export const spokenEnd = (code: string): string => code.slice(-4).split('').join(' ')

/** "just now", "30s ago", "2m ago", "3h ago", "12 days ago". A time ahead of `now` is "just now". */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.floor((now - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${String(s)}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${String(m)}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${String(h)}h ago`
  const d = Math.floor(h / 24)
  return `${String(d)} ${d === 1 ? 'day' : 'days'} ago`
}
