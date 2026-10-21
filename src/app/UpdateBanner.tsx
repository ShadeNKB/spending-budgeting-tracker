import { useEffect, useRef, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { Button } from '../ui/Button'
import { getUpdateController, type UpdateController, type UpdateState } from './swUpdate'
import { SAFE_GUTTER_X } from './safeArea'

const MESSAGE: Record<Exclude<UpdateState, 'idle'>, string> = {
  ready: 'A new version of SpendTrack is ready.',
  'updated-elsewhere': 'SpendTrack was updated in another tab.',
  confirm: "Reloading will clear what you've typed.",
  reloading: 'Updating…',
}

// 44 px tall on phones, compact on desktop.
const ACTION = 'h-11 px-3.5 text-[13px] md:h-8'

/**
 * Sticky strip inside the TopBar header. It never dismisses itself: a new version is only
 * applied when the user taps Reload, and typed text gets a confirm step first.
 *
 * Every action swaps out the button that was pressed, so focus is placed on purpose: the
 * confirm step focuses "Reload anyway", and "Keep editing" and "Later" hand focus back to the
 * field the user came from (usually the quick add they were typing in).
 */
export function UpdateBanner({
  controller = getUpdateController(),
}: {
  controller?: UpdateController
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const rootRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cameFrom = useRef<HTMLElement | null>(null)

  const remember = (element: EventTarget | null) => {
    if (
      element instanceof HTMLElement &&
      element !== document.body &&
      !rootRef.current?.contains(element)
    ) {
      cameFrom.current = element
    }
  }

  const giveFocusBack = () => {
    const target = cameFrom.current
    if (target?.isConnected) target.focus()
  }

  useEffect(() => {
    if (state === 'confirm') confirmRef.current?.focus()
  }, [state])

  return (
    <div
      ref={rootRef}
      role="status"
      // Keyboard: the element focus left. Pointer: the element still focused when the press
      // starts (WebKit never focuses a pressed button, and blurs the field instead).
      onFocusCapture={(event) => {
        remember(event.relatedTarget)
      }}
      onPointerDownCapture={() => {
        remember(document.activeElement)
      }}
    >
      {state !== 'idle' && (
        <div className="border-t border-accent/20 bg-accent/10 motion-safe:animate-fade-in">
          <div
            className={`mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 py-1 ${SAFE_GUTTER_X}`}
          >
            <p className="min-w-[9rem] flex-1 text-[13px] leading-snug text-[var(--text-primary)]">
              {MESSAGE[state]}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {state === 'confirm' ? (
                <>
                  <Button
                    ref={confirmRef}
                    size={null}
                    className={ACTION}
                    onClick={() => {
                      controller.confirmApply()
                    }}
                  >
                    Reload anyway
                  </Button>
                  <Button
                    variant="subtle"
                    size={null}
                    className={ACTION}
                    onClick={() => {
                      controller.cancelConfirm()
                      giveFocusBack()
                    }}
                  >
                    Keep editing
                  </Button>
                </>
              ) : (
                <Button
                  size={null}
                  className={ACTION}
                  disabled={state === 'reloading'}
                  onClick={() => {
                    controller.apply()
                  }}
                >
                  Reload
                </Button>
              )}
              {state === 'ready' && (
                <Button
                  variant="subtle"
                  size={null}
                  className="h-11 min-w-11 px-2.5 text-[13px] md:h-8 md:min-w-0"
                  onClick={() => {
                    controller.dismiss()
                    giveFocusBack()
                  }}
                >
                  <X size={14} aria-hidden />
                  <span className="sr-only sm:not-sr-only">Later</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
