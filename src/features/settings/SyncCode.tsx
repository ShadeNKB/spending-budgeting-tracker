import { Fragment, useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { Button } from '../../ui/Button'
import { announce } from '../../ui/announce'
import { useToast } from '../../hooks/useToast'
import { maskCode, spokenEnd } from './previousCode'

/** A revealed code masks itself again after this long. */
const REVEAL_MS = 30_000
// 44 px tall on a phone (min-height wins over the small button's height), 32 px from md up.
const BUTTON = 'min-h-11 md:min-h-0'

/**
 * "Your sync code" (F-104): masked by default, so a screenshot or a glance over the shoulder
 * does not give it away. Show / Hide is one button whose name says what a tap does (no
 * aria-pressed: a toggle that changes its name must not also be pressed), not press-and-hold,
 * so a keyboard and one thumb both work; the code masks itself again after 30 s, when the page
 * is hidden and when the panel closes (unmount). Copy always takes the full code (a share
 * sheet did not earn its weight: track spec §8 cut 3).
 */
export function SyncCode({ code }: { code: string }) {
  const toast = useToast()
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!shown) return undefined
    const hide = () => {
      setShown(false)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide()
    }
    const timer = setTimeout(hide, REVEAL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [shown])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      toast.error("Couldn't copy. Tap Show, then select the code and copy it.")
      return
    }
    setCopied(true)
    // A focused button's new name is often not read again: say it.
    announce('Sync code copied')
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      setCopied(false)
      copiedTimer.current = null
    }, 2000)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-[var(--text-tertiary)]">Your sync code</span>
      <p className="flex min-h-11 items-center rounded-md border border-white/[0.06] bg-surface-2 px-3 py-2 font-mono text-[12px] text-white/80 md:min-h-9">
        {shown ? (
          // Lines break only between the groups, never inside one: a split group read aloud or
          // typed on the other device looks like two.
          <span className="select-all break-words">
            {code.split('-').map((group, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <>
                    -<wbr />
                  </>
                )}
                {group}
              </Fragment>
            ))}
          </span>
        ) : (
          <>
            <span className="sr-only">Sync code, hidden, ends in {spokenEnd(code)}</span>
            <span aria-hidden="true">{maskCode(code)}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          className={BUTTON}
          aria-label={shown ? 'Hide code' : 'Show code'}
          onClick={() => {
            setShown((s) => !s)
          }}
        >
          {shown ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          {shown ? 'Hide' : 'Show'}
        </Button>
        <Button size="sm" variant="ghost" className={BUTTON} onClick={() => void copy()}>
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
