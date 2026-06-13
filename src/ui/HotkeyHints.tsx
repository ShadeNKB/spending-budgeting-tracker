import { Sheet } from './Sheet'

const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], label: 'Open command palette' },
  { keys: ['Ctrl', 'N'], label: 'Add new expense' },
  { keys: ['Ctrl', ','], label: 'Open settings' },
  { keys: ['Ctrl', 'Z'], label: 'Undo last action' },
  { keys: ['?'], label: 'Show keyboard shortcuts' },
  { keys: ['Esc'], label: 'Close any open panel' },
] as const

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
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-white/[0.1] bg-surface-3 px-1.5 text-[11px] font-medium text-[var(--text-tertiary)]"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-[var(--text-tertiary)]">
          Shortcuts work globally except when typing in a text field.
        </p>
      </div>
    </Sheet>
  )
}
