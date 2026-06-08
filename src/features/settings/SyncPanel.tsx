import { useEffect, useRef, useState } from 'react'
import {
  Cloud,
  CloudOff,
  Copy,
  Check,
  Link2,
  Link2Off,
  RefreshCw,
  AlertCircle,
  Loader2,
  Smartphone,
  Monitor,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { useSyncStore } from '../../stores/useSyncStore'
import { syncEnabled } from '../../services/syncService'
import { useToast } from '../../hooks/useToast'
import clsx from 'clsx'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export function SyncPanel() {
  if (!syncEnabled) return <NotConfigured />
  return <SyncContent />
}

function NotConfigured() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <CloudOff size={14} className="text-[var(--text-tertiary)]" />
          Cloud sync not configured
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          To enable cross-device sync, add Supabase credentials to your environment. Your data stays
          local-first — Supabase is only used as a relay.
        </p>
        <ol className="mt-1 flex flex-col gap-1.5 text-[12px] text-[var(--text-tertiary)]">
          <li className="flex gap-2">
            <span className="font-mono text-accent">1.</span>
            Create a free project at <span className="font-mono text-white/60">supabase.com</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">2.</span>
            Run the SQL migration from{' '}
            <span className="font-mono text-white/60">supabase/migrations/001_sync.sql</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">3.</span>
            Add <span className="font-mono text-white/60">VITE_SUPABASE_URL</span> and{' '}
            <span className="font-mono text-white/60">VITE_SUPABASE_ANON_KEY</span> to Vercel and
            your local <span className="font-mono text-white/60">.env.local</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">4.</span>
            Redeploy — sync activates automatically
          </li>
        </ol>
      </div>
    </div>
  )
}

function SyncContent() {
  const syncId = useSyncStore((s) => s.syncId)
  const cloudStatus = useSyncStore((s) => s.cloudStatus)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const setupSync = useSyncStore((s) => s.setupSync)
  const disconnectSync = useSyncStore((s) => s.disconnectSync)
  const triggerSync = useSyncStore((s) => s.triggerSync)
  const toast = useToast()

  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    },
    [],
  )

  const handleGenerate = async () => {
    const id = crypto.randomUUID()
    setConnecting(true)
    try {
      await setupSync(id)
      toast.success('Sync code generated — enter it on your other device')
    } catch {
      toast.error('Failed to set up sync')
    } finally {
      setConnecting(false)
    }
  }

  const handleConnect = async () => {
    const trimmed = codeInput.trim().toLowerCase()
    if (!trimmed) return
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (!uuidRegex.test(trimmed)) {
      toast.error('Invalid sync code — paste the full code from your other device')
      return
    }
    setConnecting(true)
    try {
      await setupSync(trimmed)
      toast.success('Connected — data synced')
      setCodeInput('')
    } catch {
      toast.error('Failed to connect — check your sync code')
    } finally {
      setConnecting(false)
    }
  }

  const handleCopy = async () => {
    if (!syncId) return
    await navigator.clipboard.writeText(syncId)
    setCopied(true)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => {
      setCopied(false)
      copyResetTimer.current = null
    }, 2000)
  }

  const handleManualSync = async () => {
    try {
      await triggerSync()
      toast.success('Synced')
    } catch {
      toast.error('Sync failed')
    }
  }

  if (!syncId) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-lg border border-accent/15 bg-accent/[0.04] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Cloud size={14} className="text-accent" />
            Link your devices
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Generate a sync code on one device, then paste it on every other device you want to keep
            in sync. There are no accounts and no passwords — the code itself is the shared secret.
          </p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-surface-1 p-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                1
              </span>
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-white">On this device</div>
                <div className="text-[10px] leading-snug text-[var(--text-tertiary)]">
                  Generate a sync code
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-surface-1 p-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                2
              </span>
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-white">On other devices</div>
                <div className="text-[10px] leading-snug text-[var(--text-tertiary)]">
                  Settings → Sync → paste it
                </div>
              </div>
            </div>
          </div>
        </div>

        <Button onClick={handleGenerate} variant="primary" disabled={connecting}>
          {connecting ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
          {connecting ? 'Setting up…' : 'Generate sync code for this device'}
        </Button>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/[0.06]" />
          <span className="text-[11px] text-[var(--text-tertiary)]">or join an existing one</span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              label=""
              placeholder="Paste sync code from another device"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConnect()
              }}
            />
          </div>
          <Button
            onClick={handleConnect}
            disabled={!codeInput.trim() || connecting}
            className="mt-0 self-end"
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
            Connect
          </Button>
        </div>

        <div className="flex items-start gap-2 pt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          <ShieldCheck size={12} className="mt-0.5 shrink-0 text-positive/70" />
          <span>
            Treat the sync code like a password. Anyone with it can read &amp; write your synced
            data. Don&apos;t share it in chats or screenshots.
          </span>
        </div>
      </div>
    )
  }

  const statusColor: Record<typeof cloudStatus, string> = {
    idle: 'text-[var(--text-tertiary)]',
    syncing: 'text-accent',
    synced: 'text-positive',
    error: 'text-negative',
  }

  const statusLabel: Record<typeof cloudStatus, string> = {
    idle: 'Ready',
    syncing: 'Syncing…',
    synced: lastSyncAt ? `Synced · ${timeAgo(lastSyncAt)}` : 'Synced',
    error: 'Sync failed',
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={clsx(
                'h-2 w-2 rounded-full',
                cloudStatus === 'synced' && 'bg-positive',
                cloudStatus === 'syncing' && 'animate-pulse bg-accent',
                cloudStatus === 'error' && 'bg-negative',
                cloudStatus === 'idle' && 'bg-white/20',
              )}
            />
            <span className={clsx('text-[12px] font-medium', statusColor[cloudStatus])}>
              {statusLabel[cloudStatus]}
            </span>
          </div>
          <button
            onClick={handleManualSync}
            disabled={cloudStatus === 'syncing'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white disabled:opacity-40"
            title="Sync now"
          >
            <RefreshCw size={13} className={cloudStatus === 'syncing' ? 'animate-spin' : ''} />
          </button>
        </div>

        {cloudStatus === 'error' && (
          <div className="flex items-center gap-2 rounded-md border border-negative/20 bg-negative/10 px-2.5 py-2 text-[11px] text-negative">
            <AlertCircle size={12} className="shrink-0" />
            Could not reach sync server. Changes saved locally and will push when connection is
            restored.
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-tertiary)]">Your sync code</span>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 text-[11px] text-accent/80 transition hover:text-accent"
            >
              {copied ? (
                <>
                  <Check size={11} /> Copied
                </>
              ) : (
                <>
                  <Copy size={11} /> Copy
                </>
              )}
            </button>
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-surface-2 px-3 py-2 text-left transition hover:border-accent/30"
            title="Tap to copy"
          >
            <span className="flex-1 select-all truncate font-mono text-[11px] text-white/80">
              {syncId}
            </span>
          </button>
        </div>
      </div>

      {!lastSyncAt && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-accent/15 bg-accent/[0.04] p-3.5">
          <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white">
            <Smartphone size={12} className="text-accent" /> Link your phone in 3 steps
          </div>
          <ol className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                1
              </span>{' '}
              Open{' '}
              <span className="font-mono text-white/80">
                {typeof window !== 'undefined' ? window.location.host : 'this site'}
              </span>{' '}
              on your phone browser.
            </li>
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                2
              </span>{' '}
              Go to Settings → <strong className="text-white/90">Sync</strong>.
            </li>
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                3
              </span>{' '}
              Paste the code above into <strong className="text-white/90">Connect</strong>.
            </li>
          </ol>
          <div className="mt-1 inline-flex items-center gap-1.5 border-t border-white/[0.04] pt-1 text-[10px] text-[var(--text-tertiary)]">
            <Monitor size={10} /> Same flow on any other laptop, tablet, or browser profile.
          </div>
        </div>
      )}

      <div className="border-t border-white/[0.06] pt-3">
        {confirmDisconnect ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/[0.07] p-3">
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Disconnect sync? Your local data stays intact — other devices stop syncing.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  disconnectSync()
                  setConfirmDisconnect(false)
                  toast.info('Sync disconnected')
                }}
                variant="primary"
                className="flex-1 border-warning/30 !bg-warning/20 !text-warning hover:!bg-warning/30"
              >
                Disconnect
              </Button>
              <Button
                onClick={() => setConfirmDisconnect(false)}
                variant="ghost"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            onClick={() => setConfirmDisconnect(true)}
            variant="ghost"
            className="w-full text-[var(--text-tertiary)] hover:text-white"
          >
            <Link2Off size={14} /> Disconnect sync
          </Button>
        )}
      </div>
    </div>
  )
}
