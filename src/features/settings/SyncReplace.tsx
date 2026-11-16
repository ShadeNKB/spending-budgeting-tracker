import type { Ref } from 'react'
import { Loader2, Upload } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { ARIA_DISABLED } from './JoinSync'

/**
 * A private copy this device cannot read as current, with no newer build to reload into
 * (PRIVATE-SYNC 3.9): the "newer" mark is read before the copy is opened, so a damaged one would
 * pause sync for good. The owner may replace the copy: a hint, the button, and the question in
 * its place once pressed.
 */
export function ReplaceCopy({
  asking,
  replacing,
  buttonRef,
  onAsk,
  onConfirm,
  onCancel,
}: {
  asking: boolean
  replacing: boolean
  buttonRef: Ref<HTMLButtonElement>
  onAsk: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
        Reloaded and still paused? The synced copy may be damaged. This device can replace it with
        its own copy.
      </p>
      {asking ? (
        <InlineConfirm
          tone="warning"
          question="Replace the synced copy with this device's?"
          detail="Do this only if reloading didn't help. Your other devices keep their entries and add them back when they next sync. Anything that is no longer on any of your devices is lost."
          confirmLabel="Replace"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : (
        <Button
          ref={buttonRef}
          onClick={onAsk}
          variant="ghost"
          aria-disabled={replacing}
          className={clsx('w-full [@media(pointer:coarse)]:h-11', ARIA_DISABLED)}
        >
          {replacing ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Upload size={14} aria-hidden />
          )}
          {replacing ? 'Replacing…' : 'Replace the synced copy'}
        </Button>
      )}
    </div>
  )
}
