import { useEffect, useId, useRef, useState } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { Input } from '../../ui/Input'
import { shieldGesture } from '../../ui/pressShield'
import { useToast } from '../../hooks/useToast'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { SYNC_RELOAD_MESSAGE, loadSyncEngine } from '../../stores/useSyncStore'
import type { JoinPreview } from '../../stores/syncEngine'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OFFLINE = "You're offline. Join when you're back online."
/** A busy button that keeps keyboard focus: it looks and acts disabled, but is not `disabled`. */
export const ARIA_DISABLED = 'aria-disabled:pointer-events-none aria-disabled:opacity-40'

type Found = Extract<JoinPreview, { kind: 'found' }>
type Step =
  | { kind: 'field' }
  | { kind: 'demo'; code: string }
  | { kind: 'checking' }
  | { kind: 'preview'; code: string; found: Found }

interface Notice {
  tone: 'error' | 'warning'
  text: string
  /** The typed code itself is wrong (the field is marked invalid). */
  invalid?: boolean
}

const NOTICE_TONE = {
  error: 'text-negative',
  warning: 'text-warning [[data-theme=light]_&]:text-[#92400e]',
} as const

const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

/** The preview's detail, with exact counts (spec §3.12). */
function previewText(p: Found): string {
  const counts = `This device: ${entries(p.here)} · Synced: ${entries(p.synced)} · After joining: about ${entries(p.after)}.`
  const removed =
    p.removed === 0
      ? 'Nothing here is removed.'
      : `${entries(p.removed)} here ${p.removed === 1 ? 'was' : 'were'} deleted on your other devices and ${p.removed === 1 ? 'goes' : 'go'} when you join; a copy is kept on this device.`
  const unreadable =
    p.unreadable === 0
      ? ''
      : ` ${p.unreadable.toLocaleString()} synced ${p.unreadable === 1 ? "entry can't be read; it's" : "entries can't be read; they're"} set aside, not merged.`
  return `${counts} ${removed}${unreadable}`
}

/** What a preview that found nothing to join says under the field. */
const NOT_JOINED: Record<'not-found' | 'newer' | 'unreadable', Notice> = {
  'not-found': {
    tone: 'error',
    text: 'No synced data found for this code. Check it on your other device.',
  },
  newer: {
    tone: 'warning',
    text: 'This sync was moved by a newer SpendTrack. Reload SpendTrack to update, then join.',
  },
  unreadable: {
    tone: 'warning',
    text: "The synced copy can't be read. Join from a device that synced it before.",
  },
}

const previewNotice = (p: Exclude<JoinPreview, Found>): Notice =>
  p.kind === 'failed'
    ? { tone: 'warning', text: p.result.error === 'offline' ? OFFLINE : p.result.message }
    : NOT_JOINED[p.kind]

/**
 * "Or join an existing one" (§3.7 Join). The code is checked before anything goes on the wire,
 * and nothing is saved until the owner has seen what joining does: `previewJoin` reads the
 * synced copy and counts the merge, writing nothing anywhere. A code with no synced copy is
 * never created here (a typo would start a new, empty sync). The demo's sample-data question
 * comes first, as before Generate (F-027). While it checks or asks, the panel's other setups
 * wait (`onActiveChange`), and it waits for theirs (`busy`): one question at a time.
 */
export function JoinSync({
  busy,
  joining,
  onJoin,
  onActiveChange,
}: {
  /** A setup this panel started is running, or another question is open: Join waits for it. */
  busy: boolean
  /** That setup is this join. */
  joining: boolean
  onJoin: (code: string) => void
  /** Join is checking a code or asking a question (true), or back at its field (false). */
  onActiveChange: (active: boolean) => void
}) {
  const toast = useToast()
  const [input, setInput] = useState('')
  const [step, setStep] = useState<Step>({ kind: 'field' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeId = useId()
  // A press that swaps the row puts focus on its successor as it mounts (Cancel → Join).
  const focusJoin = useRef(false)
  // Each check takes a number; one that comes back after the panel moved on reports nothing.
  const checkGen = useRef(0)
  // A check is on the wire: a second press before the re-render shows "Checking…" waits too.
  const inFlight = useRef(false)
  useEffect(
    () => () => {
      checkGen.current++
    },
    [],
  )

  const checking = step.kind === 'checking'
  const active = step.kind !== 'field'
  useEffect(() => {
    onActiveChange(active)
  }, [active, onActiveChange])
  useEffect(
    () => () => {
      onActiveChange(false)
    },
    [onActiveChange],
  )

  /** Back to the field, saying why nothing was joined. */
  const refuse = (why: Notice) => {
    focusJoin.current = true
    setStep({ kind: 'field' })
    setNotice(why)
  }

  const preview = async (code: string) => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      refuse({ tone: 'warning', text: OFFLINE })
      return
    }
    const gen = ++checkGen.current
    inFlight.current = true
    setStep({ kind: 'checking' })
    let result: JoinPreview
    try {
      result = await (await loadSyncEngine()).previewJoin(code)
    } catch {
      result = {
        kind: 'failed',
        result: { ok: false, error: 'reload', message: SYNC_RELOAD_MESSAGE },
      }
    }
    if (gen !== checkGen.current) return
    inFlight.current = false
    if (result.kind === 'found') {
      // The question takes the button's place: a second tap of the press must not answer it.
      shieldGesture()
      setStep({ kind: 'preview', code, found: result })
      return
    }
    refuse(previewNotice(result))
  }

  const submit = () => {
    if (checking || busy || inFlight.current) return
    const typed = input.trim().toLowerCase()
    if (!typed) return
    if (typed.startsWith('st5')) {
      setNotice({
        tone: 'error',
        invalid: true,
        text: "That's a private sync code. Update SpendTrack on this device to use it.",
      })
      return
    }
    if (!UUID.test(typed)) {
      setNotice({
        tone: 'error',
        invalid: true,
        text: "That code isn't valid. Paste the full code from your other device.",
      })
      return
    }
    setNotice(null)
    if (useExpenseStore.getState().demo === 'sample') {
      shieldGesture()
      setStep({ kind: 'demo', code: typed })
      return
    }
    void preview(typed)
  }

  const backToField = () => {
    focusJoin.current = true
    setStep({ kind: 'field' })
  }

  const answerDemo = (code: string, remove: boolean) => {
    if (remove) {
      try {
        useExpenseStore.getState().clearSampleData()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't remove the sample data.")
        backToField()
        return
      }
    }
    focusJoin.current = true
    void preview(code)
  }

  let row: React.ReactNode
  if (step.kind === 'demo') {
    row = (
      <DemoQuestion
        onAnswer={(remove) => {
          answerDemo(step.code, remove)
        }}
        onBackOut={backToField}
      />
    )
  } else if (step.kind === 'preview') {
    // A join that removes entries here says so on its button, in the danger colour.
    const { removed } = step.found
    row = (
      <InlineConfirm
        tone={removed > 0 ? 'danger' : 'warning'}
        question="Join this sync?"
        detail={previewText(step.found)}
        confirmLabel={removed > 0 ? `Join and remove ${removed.toLocaleString()}` : 'Join'}
        onConfirm={() => {
          // Focus waits on Join ("Joining…") until the linked view takes it.
          focusJoin.current = true
          setStep({ kind: 'field' })
          onJoin(step.code)
        }}
        onCancel={backToField}
      />
    )
  } else {
    row = (
      <div className="flex gap-2">
        {/* min-w-0 lets the field shrink, so Join stays on screen at 320 px. */}
        <div className="min-w-0 flex-1">
          <Input
            label="Sync code"
            placeholder="Paste your sync code"
            value={input}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value)
              setNotice(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Without this, the Enter's own activation (keypress) lands on what the view
              // swaps in. A held Enter checks once.
              e.preventDefault()
              if (!e.repeat) submit()
            }}
            aria-invalid={notice?.invalid === true ? true : undefined}
            aria-describedby={noticeId}
            className="min-w-0"
          />
        </div>
        <Button
          ref={(el) => {
            if (el && focusJoin.current) {
              focusJoin.current = false
              el.focus()
            }
          }}
          onClick={submit}
          disabled={!input.trim()}
          aria-disabled={checking || busy}
          className={clsx('shrink-0 self-end', ARIA_DISABLED)}
        >
          {checking || joining ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Link2 size={14} aria-hidden />
          )}
          {checking ? 'Checking…' : joining ? 'Joining…' : 'Join'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {row}
      {/* Always mounted, so a message that appears in it is announced. */}
      <p
        id={noticeId}
        role="status"
        className={clsx(
          'text-[13px] leading-relaxed empty:hidden md:text-[12px]',
          notice && NOTICE_TONE[notice.tone],
        )}
      >
        {notice?.text}
      </p>
    </div>
  )
}

/**
 * "Remove the sample data first?" before this device links up (P2-22). The sample rows never
 * reach the relay either way, so both answers go on; Escape backs out instead.
 */
export function DemoQuestion({
  onAnswer,
  onBackOut,
}: {
  onAnswer: (remove: boolean) => void
  onBackOut: () => void
}) {
  return (
    <div
      // Both answers are long: on a phone they take a row each instead of running past the card
      // (InlineConfirm's button row does not wrap; its buttons keep their labels on one line).
      className="[&_[role=group]>div:last-child]:flex-wrap"
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
        e.preventDefault()
        e.stopPropagation()
        onBackOut()
      }}
    >
      <InlineConfirm
        tone="warning"
        question="Remove the sample data first?"
        detail="Sample entries stay on this device and never sync. Remove them to start with your own."
        confirmLabel="Remove and connect"
        cancelLabel="Keep it on this device"
        onConfirm={() => {
          onAnswer(true)
        }}
        onCancel={() => {
          onAnswer(false)
        }}
      />
    </div>
  )
}
