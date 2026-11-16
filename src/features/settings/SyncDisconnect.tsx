import type { Ref } from 'react'
import { Link2Off } from 'lucide-react'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'

/**
 * "Disconnect sync", and its question in the button's place once pressed. The shared
 * confirmation: Cancel takes focus, Escape takes back the question (not Settings), and neither a
 * double tap on "Disconnect sync" nor a held Enter can answer it. Cancel hands focus back to
 * "Disconnect sync".
 */
export function DisconnectSync({
  asking,
  detail,
  buttonRef,
  onAsk,
  onConfirm,
  onCancel,
}: {
  asking: boolean
  detail: string
  buttonRef: Ref<HTMLButtonElement>
  onAsk: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return asking ? (
    <InlineConfirm
      tone="warning"
      question="Disconnect sync on this device?"
      detail={detail}
      confirmLabel="Disconnect"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  ) : (
    <Button
      ref={buttonRef}
      onClick={onAsk}
      variant="ghost"
      // 44 px tall under a finger (not just its hit area); a mouse keeps the 40 px button.
      className="w-full text-[var(--text-tertiary)] hover:text-white [@media(pointer:coarse)]:h-11"
    >
      <Link2Off size={14} /> Disconnect sync
    </Button>
  )
}
