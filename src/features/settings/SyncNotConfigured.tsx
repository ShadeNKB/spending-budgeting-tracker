import type { ReactNode } from 'react'
import { CloudOff } from 'lucide-react'

/** A build with no relay settings: how to set sync up. */
export function NotConfigured() {
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
          <SetupStep n={1}>
            Create a free project at <code className={SETUP_NAME}>supabase.com</code>
          </SetupStep>
          <SetupStep n={2}>
            Run the SQL files in <code className={SETUP_NAME}>supabase/migrations</code> in order
            (001 to 006, never the <code className={SETUP_NAME}>.rollback</code> files), by hand in
            the Supabase SQL editor
          </SetupStep>
          <SetupStep n={3}>
            Set <code className={SETUP_NAME}>VITE_SUPABASE_URL</code>,{' '}
            <code className={SETUP_NAME}>VITE_SUPABASE_ANON_KEY</code> and{' '}
            <code className={SETUP_NAME}>VITE_SYNC_RELAY=rpc</code>, then rebuild
          </SetupStep>
          <SetupStep n={4}>
            Every step in full: <code className={SETUP_NAME}>docs/SELF_HOST.md</code>
          </SetupStep>
        </ol>
      </div>
    </div>
  )
}

const SETUP_NAME = 'font-mono text-white/60'

/**
 * One setup step: its number, then its words as one run of text, so a long file name or command
 * in it wraps (anywhere, if it must) instead of pushing the panel sideways at 320 px.
 */
function SetupStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="font-mono text-accent">{n}.</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </li>
  )
}
