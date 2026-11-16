import type { Ref } from 'react'
import { Cloud, Link2, Loader2 } from 'lucide-react'
import { formatDate } from '../../lib/formatDate'
import { privateSyncReady } from '../../services/syncConfig'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { shieldGesture } from '../../ui/pressShield'
import { ARIA_DISABLED, DemoQuestion, JoinSync } from './JoinSync'
import { maskCode, readPrevious, spokenEnd } from './previousCode'
import { AppVersion, CodeSafety } from './SyncNotes'
import type { SetupRequest } from './syncPanelView'

/**
 * No sync on this device yet: Generate, Reconnect to the code it left (F-050) and Join, each
 * waiting while another runs or asks. The panel owns the state and the requests; this shows them.
 */
export function UnlinkedSync({
  connecting,
  joinActive,
  askDemo,
  askSeparate,
  reconnectHintId,
  generateRef,
  reconnectRef,
  onSetUp,
  onAskSeparate,
  onConfirmSeparate,
  onCancelSeparate,
  onAnswerDemo,
  onBackOutOfDemo,
  onJoin,
  onJoinActiveChange,
}: {
  /** The setup the panel is running, if any. */
  connecting: SetupRequest['kind'] | null
  /** Join is checking a code or asking its own question. */
  joinActive: boolean
  /** The setup waiting on the question about the demo's sample rows. */
  askDemo: SetupRequest | null
  /** Generate asked whether to start a separate sync. */
  askSeparate: boolean
  reconnectHintId: string
  generateRef: Ref<HTMLButtonElement>
  reconnectRef: Ref<HTMLButtonElement>
  onSetUp: (request: SetupRequest) => void
  onAskSeparate: (ask: boolean) => void
  onConfirmSeparate: () => void
  onCancelSeparate: () => void
  onAnswerDemo: (remove: boolean) => void
  onBackOutOfDemo: () => void
  onJoin: (code: string) => void
  onJoinActiveChange: (active: boolean) => void
}) {
  const prev = readPrevious(Date.now())
  // aria-disabled, not disabled, while another setup runs or Join asks: focus stays put.
  // Generate also waits while Reconnect asks about the sample data.
  const waiting = connecting !== null || joinActive
  const generateWaits = waiting || askDemo !== null
  const generateButton = (
    <Button
      ref={generateRef}
      onClick={() => {
        if (generateWaits) return
        if (prev === null) {
          onSetUp({ kind: 'generate' })
          return
        }
        shieldGesture()
        onAskSeparate(true)
      }}
      variant={prev === null ? 'primary' : 'ghost'}
      aria-disabled={generateWaits}
      className={ARIA_DISABLED}
    >
      {connecting === 'generate' ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Cloud size={14} />
      )}
      {connecting === 'generate' ? 'Setting up…' : 'Generate sync code for this device'}
    </Button>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-accent/15 bg-accent/[0.04] p-4">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <Cloud size={14} className="text-accent" aria-hidden />
          Link your devices
        </h3>
        {/* A new sync is private where the relay can keep one safe (PRIVATE-SYNC 3.6, 3.8). The
            sentence claims only what holds from then on: a device encrypts what it sends. */}
        {privateSyncReady ? (
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Generate a sync code here, then enter it on your other device. There&apos;s no account:
            the code links them. A sync started here is private: each device encrypts what it sends,
            so only a device with the code can read the synced copy.
          </p>
        ) : (
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Generate a sync code here, then join it on your other device. There&apos;s no account:
            the code links them. The synced copy isn&apos;t encrypted yet: until the database
            lockdown (update 005), anyone with this app&apos;s public key could read it.
          </p>
        )}
      </div>

      {prev !== null &&
        (askDemo?.kind === 'reconnect' ? (
          <DemoQuestion onAnswer={onAnswerDemo} onBackOut={onBackOutOfDemo} />
        ) : (
          <div className="flex flex-col gap-1.5">
            <Button
              ref={reconnectRef}
              onClick={() => {
                if (waiting) return
                // "Reconnect instead" answers Generate's question about a separate sync.
                onAskSeparate(false)
                onSetUp({ kind: 'reconnect', code: prev.code, established: prev.established })
              }}
              aria-disabled={waiting}
              aria-label={`Reconnect to the code ending in ${spokenEnd(prev.code)}`}
              aria-describedby={reconnectHintId}
              className={ARIA_DISABLED}
            >
              {connecting === 'reconnect' ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : (
                <Link2 size={14} aria-hidden />
              )}
              Reconnect to <span className="font-mono">{maskCode(prev.code)}</span>
            </Button>
            <p id={reconnectHintId} className="text-center text-[12px] text-[var(--text-tertiary)]">
              This device remembers the code until {formatDate(prev.until, 'd MMM')}.
            </p>
          </div>
        ))}

      {askDemo?.kind === 'generate' ? (
        <DemoQuestion onAnswer={onAnswerDemo} onBackOut={onBackOutOfDemo} />
      ) : askSeparate ? (
        <InlineConfirm
          tone="warning"
          question="Start a separate sync?"
          detail="Your other devices stay on the old code. Reconnect instead to keep one sync."
          confirmLabel="Make a new code"
          onConfirm={onConfirmSeparate}
          onCancel={onCancelSeparate}
        />
      ) : (
        generateButton
      )}

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/[0.06]" />
        <span className="text-[11px] text-[var(--text-tertiary)]">or join an existing one</span>
        <div className="h-px flex-1 bg-white/[0.06]" />
      </div>

      <JoinSync
        busy={connecting !== null || askSeparate || askDemo !== null}
        joining={connecting === 'join'}
        onJoin={onJoin}
        onActiveChange={onJoinActiveChange}
      />

      <CodeSafety />
      <AppVersion />
    </div>
  )
}
