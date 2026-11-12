import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatDate } from '../lib/formatDate'
import clsx from 'clsx'
import { AlertTriangle, Download, FlaskConical, HardDrive, RotateCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { announce, type Politeness } from '../ui/announce'
import { useToast } from '../hooks/useToast'
import { downloadJSON } from '../lib/download'
import { STUCK_HINT, reloadedRecently } from '../lib/chunkReload'
import { downloadRescueFile, type RescueOutcome } from '../lib/rescue'
import { useExpenseStore, type BootReport, type LocalStatus } from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'
import { getUpdateController, type UpdateController } from './swUpdate'
import { SAFE_GUTTER_X } from './safeArea'

// What the local engine has to tell the owner about their saved data (spec §6.5): strips under
// the top bar while a state lasts, and toasts for one-off news at boot. Every strip names what
// happened and offers the one thing that keeps the data safe, a download.

/**
 * The storage layer's own toast for a write that hit the quota (AppShell shows it the moment it
 * happens). When it is on screen it has already said what the "Not saved" strip says.
 */
export const QUOTA_TOAST = 'Storage is full — export a backup and clear old data to keep saving.'

const quotaToastShown = (): boolean =>
  useUIStore.getState().toasts.some((t) => t.message === QUOTA_TOAST)

const never = (): boolean => false

/** "1 entry", "2,000 entries": counts read the same here as in Backup and the undo toasts. */
const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

const today = (): string => formatDate(new Date(), 'yyyy-MM-dd')

/** After a strip's own button removed it: focus goes to the screen, never to <body>. */
function focusMain(): void {
  document.getElementById('main')?.focus({ preventScroll: true })
}

function rescueMessage(outcome: RescueOutcome): { ok: boolean; text: string } {
  switch (outcome.kind) {
    case 'downloaded':
      // The page cannot see whether the browser saved the file (iOS asks first).
      return { ok: true, text: `Saving ${outcome.filename}… Check your Downloads.` }
    case 'empty':
      return { ok: false, text: 'Nothing is saved in this browser yet.' }
    case 'unavailable':
      return { ok: false, text: 'This browser blocked access to saved data.' }
    case 'failed':
      return { ok: false, text: "The download couldn't start. Try again, or reload first." }
  }
}

/** The local message for a save that failed, or null while saving works. */
function notSavedMessage(local: LocalStatus): string | null {
  if (local === 'error-quota') return 'Not saved: storage is full'
  if (local === 'error-storage') return 'Not saved: this browser is blocking storage'
  return null
}

/** The boot report's toast: "Your data was upgraded: 700 entries · 2 need attention". */
function upgradeMessage(report: BootReport): string {
  const upgraded = `Your data was upgraded: ${plural(report.entries, 'entry', 'entries')}`
  if (report.needsAttention === 0) return upgraded
  const verb = report.needsAttention === 1 ? 'needs' : 'need'
  return `${upgraded} · ${report.needsAttention.toLocaleString()} ${verb} attention`
}

/** "Review", "Details": Settings › Backup › Recovery, with focus on what needs attention. */
function review(): void {
  const ui = useUIStore.getState()
  ui.focusSettings('backup', 'recovery-attention')
  ui.setSettingsOpen(true)
}

/**
 * Says `message` each time it starts to show, unless something else already said it (one voice
 * per event). The strips are not live regions themselves: an open sheet hides everything outside
 * it from assistive tech, and `announce` speaks through it.
 */
function useAnnounceShown(
  message: string | null,
  politeness: Politeness,
  saidElsewhere: () => boolean = never,
): void {
  useEffect(() => {
    if (message !== null && !saidElsewhere()) announce(message, politeness)
  }, [message, politeness, saidElsewhere])
}

type Tone = 'danger' | 'warn' | 'accent'

// Tinted strips with text in the primary colour (AA in both themes); the icon carries the tone.
const TONES: Record<Tone, { strip: string; icon: string }> = {
  danger: { strip: 'border-negative/25 bg-negative/10', icon: 'text-negative' },
  warn: { strip: 'border-warning/25 bg-warning/10', icon: 'text-warning' },
  accent: { strip: 'border-accent/20 bg-accent/10', icon: 'text-accent' },
}

// 44 px tall on phones, compact on desktop (as the update banner's).
const ACTION = 'tap-target h-11 px-3.5 text-[13px] md:h-8'

function Strip({
  label,
  tone,
  icon,
  message,
  children,
}: {
  label: string
  tone: Tone
  icon: ReactNode
  message: string
  children: ReactNode
}) {
  return (
    <section aria-label={label} className={clsx('border-b', TONES[tone].strip)}>
      <div
        className={`mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 py-1 ${SAFE_GUTTER_X}`}
      >
        <span aria-hidden className={clsx('shrink-0', TONES[tone].icon)}>
          {icon}
        </span>
        <p className="min-w-[10rem] flex-1 py-1.5 text-[14px] leading-snug text-[var(--text-primary)] md:text-[13px]">
          {message}
        </p>
        {/* Capped at the strip's width, so three actions wrap on a 320 px phone. */}
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-1">{children}</div>
      </div>
    </section>
  )
}

function useDownloads() {
  const toast = useToast()
  return {
    backup: () => {
      try {
        downloadJSON(`spendtrack-backup-${today()}.json`, useExpenseStore.getState().exportBackup())
        useExpenseStore.getState().markBackedUp()
        toast.success('Backup downloaded')
      } catch {
        toast.error("The download couldn't start. Try again.")
      }
    },
    damaged: () => {
      try {
        downloadJSON(
          `spendtrack-needs-attention-${today()}.json`,
          useExpenseStore.getState().quarantineFile(),
        )
        toast.success('Damaged data downloaded')
      } catch {
        toast.error("The download couldn't start. Try again.")
      }
    },
    raw: () => {
      const { ok, text } = rescueMessage(downloadRescueFile())
      if (ok) toast.success(text)
      else toast.error(text)
    },
  }
}

/**
 * The strips and boot toasts, mounted once under the top bar: memory-only, not saved, recovered,
 * nearly full and demo. The needs-attention toast shows at most once per boot, and the boot
 * report once (then the store drops it).
 */
export function DataNotices() {
  const hydrated = useExpenseStore((s) => s.hydrated)
  const local = useExpenseStore((s) => s.local)
  const nearlyFull = useExpenseStore((s) => s.facts.nearlyFull)
  const unseen = useExpenseStore((s) => s.attention.unseen)
  const quarantined = useExpenseStore((s) => s.attention.quarantined)
  const copies = useExpenseStore((s) => s.attention.copies)
  const report = useExpenseStore((s) => s.report)
  const demo = useExpenseStore((s) => s.demo)
  const toast = useToast()
  const downloads = useDownloads()
  const attentionTold = useRef(false)

  const memoryOnly = local === 'memory-only'
  const notSaved = notSavedMessage(local)
  const recovered = report?.kind === 'recovered' ? report : null
  // A failed save already says storage is full.
  const showNearlyFull = nearlyFull && notSaved === null && !memoryOnly

  const memoryOnlyText =
    "Your saved data couldn't be read and there's no room to keep a safety copy. Nothing will be overwritten. New entries won't be kept after you close SpendTrack: download your raw data first."
  const recoveredText =
    recovered === null
      ? null
      : `We couldn't read part of your saved data. We recovered ${plural(recovered.entries, 'entry', 'entries')} from backup copies.`
  const nearlyFullText = 'Storage on this device is nearly full'

  useAnnounceShown(memoryOnly ? memoryOnlyText : null, 'assertive')
  useAnnounceShown(notSaved, 'assertive', quotaToastShown)
  useAnnounceShown(recoveredText, 'polite')
  useAnnounceShown(showNearlyFull ? nearlyFullText : null, 'polite')

  // The upgrade report: one toast, then the store forgets it. It says what needs attention, so
  // the attention toast is not repeated this boot; a recovered report has its own strip.
  useEffect(() => {
    if (!hydrated || report === null) return
    attentionTold.current = true
    if (report.kind !== 'upgraded') return
    const action = report.needsAttention > 0 ? { label: 'Review', onClick: review } : undefined
    toast.info(upgradeMessage(report), { action, duration: action ? 8000 : undefined })
    useExpenseStore.getState().dismissReport()
  }, [hydrated, report, toast])

  // Entries set aside since the owner last looked: once per boot, so it never nags. A whole
  // stored copy set aside is no entry: with one among them, the toast counts items.
  useEffect(() => {
    if (!hydrated || unseen === 0 || attentionTold.current) return
    attentionTold.current = true
    const what =
      copies === 0
        ? `${plural(unseen, 'entry', 'entries')} couldn't be read`
        : copies === quarantined
          ? `${plural(unseen, 'damaged copy', 'damaged copies')} of your saved data set aside`
          : `${plural(unseen, 'item', 'items')} couldn't be read`
    toast.info(what, { action: { label: 'Review', onClick: review }, duration: 8000 })
  }, [hydrated, unseen, copies, quarantined, toast])

  if (!hydrated) return null

  return (
    <>
      {memoryOnly && (
        <Strip
          label="Saved data unreadable"
          tone="danger"
          icon={<AlertTriangle size={14} />}
          message={memoryOnlyText}
        >
          <Button size={null} className={ACTION} onClick={downloads.raw}>
            <Download size={14} aria-hidden />
            Download raw data
          </Button>
        </Strip>
      )}
      {notSaved !== null && (
        <Strip label="Not saved" tone="danger" icon={<HardDrive size={14} />} message={notSaved}>
          <Button size={null} className={ACTION} onClick={downloads.backup}>
            <Download size={14} aria-hidden />
            Download a backup
          </Button>
        </Strip>
      )}
      {recoveredText !== null && (
        <Strip
          label="Data recovered"
          tone="warn"
          icon={<AlertTriangle size={14} />}
          message={recoveredText}
        >
          <Button size={null} className={ACTION} onClick={downloads.damaged}>
            <Download size={14} aria-hidden />
            Download damaged data
          </Button>
          <Button variant="ghost" size={null} className={ACTION} onClick={review}>
            Details
          </Button>
          {/* Named for what it closes: a toast's × is "Dismiss" too, often on screen with it. */}
          <Button
            variant="subtle"
            size={null}
            className={ACTION}
            aria-label="Dismiss recovery notice"
            onClick={() => {
              useExpenseStore.getState().dismissReport()
              focusMain()
            }}
          >
            Dismiss
          </Button>
        </Strip>
      )}
      {showNearlyFull && (
        <Strip
          label="Storage nearly full"
          tone="warn"
          icon={<HardDrive size={14} />}
          message={nearlyFullText}
        >
          <Button size={null} className={ACTION} onClick={downloads.backup}>
            <Download size={14} aria-hidden />
            Download a backup
          </Button>
        </Strip>
      )}
      {demo === 'sample' && (
        <Strip
          label="Demo mode"
          tone="accent"
          icon={<FlaskConical size={14} />}
          message="Demo mode — sample data loaded."
        >
          <Button
            variant="ghost"
            size={null}
            className={ACTION}
            onClick={() => {
              useExpenseStore.getState().clearSampleData()
              toast.success('Sample data cleared')
              focusMain()
            }}
          >
            Clear sample data
          </Button>
        </Strip>
      )}
    </>
  )
}

/**
 * A Settings data tab (Categories, Budgets, Backup) while there is no data to show: still
 * loading, or the data engine could not load. Never placeholder lists with zero counts beside
 * live delete buttons, which read as data that is gone.
 */
export function DataUnavailable({
  failed,
  detail = "Your data can't be shown here. It's still saved on this device.",
  controller = getUpdateController(),
}: {
  failed: boolean
  /** What cannot be done here, said under the heading. */
  detail?: string
  controller?: UpdateController
}) {
  const titleId = useId()
  const [status, setStatus] = useState('')
  if (!failed) {
    return (
      <p role="status" className="text-[13px] text-[var(--text-secondary)]">
        Loading your data…
      </p>
    )
  }
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/[0.07] p-4"
    >
      <div>
        <p id={titleId} className="text-[13px] font-semibold text-white">
          SpendTrack couldn't start
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">{detail}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="sm:flex-1"
          onClick={() => {
            controller.reloadToLatest()
          }}
        >
          <RotateCw size={14} aria-hidden />
          Reload
        </Button>
        <Button
          variant="ghost"
          className="sm:flex-1"
          onClick={() => {
            setStatus(rescueMessage(downloadRescueFile()).text)
          }}
        >
          <Download size={14} aria-hidden />
          Download my data
        </Button>
      </div>
      <p aria-live="polite" className="min-h-[18px] text-[12px] text-[var(--text-secondary)]">
        {status}
      </p>
    </div>
  )
}

/**
 * In place of the screen when the data engine could not load (`bootError`). It needs nothing
 * but the update controller and localStorage: Reload installs a waiting build first, and the raw
 * download works without the engine.
 */
export function BootFailure({
  controller = getUpdateController(),
}: {
  controller?: UpdateController
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const captionId = useId()
  const [status, setStatus] = useState('')

  // Announce the problem and give keyboard users a starting point.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section className="mx-auto w-full max-w-[560px] py-4 md:py-8">
      <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-5 md:p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <AlertTriangle size={18} aria-hidden />
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 text-[19px] font-semibold tracking-tight text-white"
        >
          SpendTrack couldn't start.
        </h1>
        <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Part of the app didn't load, so your data can't be shown. It's still saved on this device.
          {reloadedRecently() ? ` ${STUCK_HINT}` : ''}
        </p>
        <div className="mt-5 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <Button
            size="lg"
            className="w-full md:w-auto"
            onClick={() => {
              controller.reloadToLatest()
            }}
          >
            <RotateCw size={16} aria-hidden />
            Reload
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full md:w-auto"
            aria-describedby={captionId}
            onClick={() => {
              setStatus(rescueMessage(downloadRescueFile()).text)
            }}
          >
            <Download size={16} aria-hidden />
            Download my data
          </Button>
        </div>
        <p id={captionId} className="mt-2.5 text-[12px] text-[var(--text-tertiary)]">
          Saves a copy of everything stored in this browser, exactly as it is.
        </p>
        <p
          aria-live="polite"
          className="mt-1 min-h-[18px] text-[12px] text-[var(--text-secondary)]"
        >
          {status}
        </p>
      </div>
    </section>
  )
}
