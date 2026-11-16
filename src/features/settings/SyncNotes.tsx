import { ShieldCheck } from 'lucide-react'

const CODE_SAFETY =
  'Share the code only with your own devices: anyone with it can change your synced data.'

/** Who may see the code: said beside every place it can be copied or typed. */
export function CodeSafety() {
  return (
    <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
      <ShieldCheck size={12} className="mt-0.5 shrink-0 text-positive/70" aria-hidden />
      <span>{CODE_SAFETY}</span>
    </p>
  )
}

/** Which SpendTrack this device runs: after an update, both devices should show the same. */
export function AppVersion() {
  return (
    <p className="text-center text-[11px] text-[var(--text-tertiary)]">
      This device runs SpendTrack {__APP_VERSION__}
    </p>
  )
}
