import { Sheet } from './Sheet'

/** Each shortcut, with the key combinations that do it (any one of them). */
const SHORTCUTS: readonly { readonly combos: readonly (readonly string[])[]; label: string }[] = [
  { combos: [['Ctrl', 'K']], label: 'Open command palette' },
  {
    combos: [
      ['Ctrl', 'N'],
      ['Alt', 'N'],
    ],
    label: 'Add new expense',
  },
  { combos: [['Ctrl', ',']], label: 'Open settings' },
  { combos: [['Ctrl', 'Z']], label: 'Undo last action' },
  { combos: [['Delete']], label: 'Delete the focused ledger entry' },
  { combos: [['?']], label: 'Show keyboard shortcuts' },
  { combos: [['Esc']], label: 'Close the top panel or picker' },
]

export function HotkeyHints({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts" side="bottom">
      <div className="px-5 pb-6 pt-4">
        <ul className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <li
              key={s.label}
              className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.05] bg-surface-2/50 px-3 py-2.5"
            >
              <span className="text-[13px] text-[var(--text-secondary)]">{s.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {s.combos.map((combo, i) => (
                  <span key={combo.join('+')} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="px-0.5 text-[11px] text-[var(--text-tertiary)]">or</span>
                    )}
                    {combo.map((k) => (
                      <kbd
                        key={k}
                        className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-white/[0.1] bg-surface-3 px-1.5 text-[11px] font-medium text-[var(--text-tertiary)]"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-[var(--text-tertiary)]">
          While you type in a field, Ctrl+Z and ? keep their usual meaning. A browser tab may keep
          Ctrl+N for a new window: Alt+N works there too. On a Mac keyboard, Delete is fn + delete.
        </p>
      </div>
    </Sheet>
  )
}
