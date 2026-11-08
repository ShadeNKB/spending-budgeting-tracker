import { useEffect, useId } from 'react'
import { format } from 'date-fns'
import { Download, FileWarning, ListChecks } from 'lucide-react'
import { Button } from '../../ui/Button'
import { useToast } from '../../hooks/useToast'
import { downloadJSON } from '../../lib/download'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

/**
 * What is set aside, in the owner's words. Entries are entries; a whole stored copy kept as it was
 * found (the damaged envelope a recovered boot set aside) is no entry, and saying "1 entry" for
 * it would read as one expense missing.
 */
function keptText(entries: number, copies: number): string {
  const couldNot = `${entries.toLocaleString()} ${entries === 1 ? 'entry' : 'entries'} couldn't be read`
  const damaged =
    copies === 1
      ? 'a damaged copy of your saved data'
      : `${copies.toLocaleString()} damaged copies of your saved data`
  if (copies === 0) {
    return `${couldNot}. ${entries === 1 ? "It's" : "They're"} kept on this device, untouched.`
  }
  if (entries === 0) {
    const is = copies === 1 ? 'is' : 'are'
    return `${damaged.charAt(0).toUpperCase()}${damaged.slice(1)} ${is} kept on this device, untouched.`
  }
  return `${couldNot}, and ${damaged} ${copies === 1 ? 'was' : 'were'} set aside. All of it is kept on this device, untouched.`
}

/**
 * The entries this device could not read (from storage, a file or the relay), and whole stored
 * copies set aside as they were found. They are kept, never deleted, and can be downloaded as
 * they are. Seeing the card marks them seen, so the "couldn't be read" toast stops coming back
 * for them. Review opens Recovery on the list, where each one can be fixed or discarded.
 */
export function NeedsAttentionCard() {
  const quarantined = useExpenseStore((s) => s.attention.quarantined)
  const copies = useExpenseStore((s) => s.attention.copies)
  const unseen = useExpenseStore((s) => s.attention.unseen)
  const full = useExpenseStore((s) => s.attention.full)
  const toast = useToast()
  const titleId = useId()

  useEffect(() => {
    if (quarantined > 0 && unseen > 0) useExpenseStore.getState().markAttentionSeen()
  }, [quarantined, unseen])

  if (quarantined === 0) return null

  const one = quarantined === 1
  const download = () => {
    downloadJSON(
      `spendtrack-needs-attention-${format(new Date(), 'yyyy-MM-dd')}.json`,
      useExpenseStore.getState().quarantineFile(),
    )
    toast.success(
      !one
        ? 'Downloaded them'
        : copies === 1
          ? 'Downloaded the damaged copy'
          : 'Downloaded the entry',
    )
  }

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/[0.07] p-4"
    >
      <div className="flex items-start gap-2">
        <FileWarning size={15} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <h3 id={titleId} className="text-[13px] font-semibold text-white">
            Needs attention
          </h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {keptText(quarantined - copies, copies)}
          </p>
          {full && (
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              There's no room to keep any more of them here. Download these to keep them safe.
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="ghost"
          className="sm:flex-1"
          onClick={() => {
            useUIStore.getState().focusSettings('backup', 'recovery-attention')
          }}
        >
          <ListChecks size={14} aria-hidden /> Review
        </Button>
        <Button variant="ghost" className="sm:flex-1" onClick={download}>
          <Download size={14} aria-hidden /> {one ? 'Download it' : 'Download them'}
        </Button>
      </div>
    </section>
  )
}
