import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { shieldGesture } from '../../ui/pressShield'
import {
  OLD_DEVICE_WAITING,
  SYNC_RELOAD_MESSAGE,
  failureSeverity,
  isPrivateCode,
  loadSyncEngine,
  newBuildWaiting,
  subscribeNewBuild,
  syncsWhenOnline,
  useSyncStore,
  type SyncResult,
} from '../../stores/useSyncStore'
import type { MoveResult } from '../../stores/syncEngine'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { privateSyncReady, syncEnabled } from '../../services/syncConfig'
import { useTick } from '../../hooks/useTick'
import { useToast } from '../../hooks/useToast'
import { JoinSync } from './JoinSync'
import { SyncBanners } from './SyncBanners'
import { SyncCode } from './SyncCode'
import { SyncDevices } from './SyncDevices'
import { DisconnectSync } from './SyncDisconnect'
import { MoveLines, MoveOffer } from './SyncMove'
import { NotConfigured } from './SyncNotConfigured'
import { AppVersion, CodeSafety } from './SyncNotes'
import { ReplaceCopy } from './SyncReplace'
import { SyncStatusRow } from './SyncStatusRow'
import { UnlinkedSync } from './SyncUnlinked'
import {
  failureBanner,
  setupFailure,
  statusView,
  useFailingTurn,
  type SetupLead,
  type SetupRequest,
} from './syncPanelView'
import { forgetPrevious, keepPrevious, readPrevious } from './previousCode'

/** Controls that take focus after a view swap (see `focusNext`). */
type FocusTarget = 'sync-now' | 'generate' | 'reconnect' | 'disconnect' | 'replace' | 'make-private'

/** Said once a plain sync was made private here: the new code is on screen now. */
const MOVED_MESSAGE = 'Sync made private. Enter the new sync code on your other devices.'

export function SyncPanel() {
  if (!syncEnabled) return <NotConfigured />
  return <SyncContent />
}

function SyncContent() {
  const syncId = useSyncStore((s) => s.syncId)
  const cloudStatus = useSyncStore((s) => s.cloudStatus)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const lastError = useSyncStore((s) => s.lastError)
  const pendingLocal = useSyncStore((s) => s.pendingLocal)
  const pending = useSyncStore((s) => s.pending)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const move = useSyncStore((s) => s.view?.move)
  const resumes = useSyncStore(syncsWhenOnline)
  const setupSync = useSyncStore((s) => s.setupSync)
  const disconnectSync = useSyncStore((s) => s.disconnectSync)
  const triggerSync = useSyncStore((s) => s.triggerSync)
  const buildWaiting = useSyncExternalStore(subscribeNewBuild, newBuildWaiting)
  const toast = useToast()

  // The setup this panel is running, if any: every setup control waits for it.
  const [connecting, setConnecting] = useState<SetupRequest['kind'] | null>(null)
  const [manualSyncing, setManualSyncing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // The owner's way out of a private copy this device cannot read (PRIVATE-SYNC 3.9).
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [replacing, setReplacing] = useState(false)
  // "Make sync private" (PRIVATE-SYNC 4.5): its question, and the move while it runs.
  const [confirmMove, setConfirmMove] = useState(false)
  const [moving, setMoving] = useState(false)
  const syncNow = useRef<HTMLButtonElement | null>(null)
  // Generate while this device remembers a code it left (F-050): one sync or two?
  const [askSeparate, setAskSeparate] = useState(false)
  // Generate or Reconnect asked while the demo's sample rows are here (P2-22): they never
  // sync, so the owner decides first whether to keep them on this device. (Join asks in its
  // own row.)
  const [askDemo, setAskDemo] = useState<SetupRequest | null>(null)
  // Join is checking a code or asking its own question: Generate and Reconnect wait, and Join
  // waits while they ask, so one question is on screen at a time.
  const [joinActive, setJoinActive] = useState(false)
  // Each request this panel starts takes a number, and Disconnect moves past it: a request
  // still on the wire then (a hung first sync) keeps no button busy and reports nothing.
  const requestGen = useRef(0)
  // A press that swaps the view unmounts the pressed control. Its successor takes focus when
  // it mounts, so keyboard and screen-reader focus stays in the panel, never on <body>.
  const focusNext = useRef<FocusTarget | null>(null)
  const statusId = useId()
  const reconnectHintId = useId()
  const moveHintId = useId()
  useFailingTurn(lastError)
  // Replace answers a private copy this device cannot read as current, with no newer build to
  // reload into (PRIVATE-SYNC 3.9). That pause can end by itself, when the other device
  // repairs the copy: the block then leaves with focus inside it, its question included, so
  // the question is taken back and Sync now takes the focus.
  const canReplace =
    syncId !== null &&
    isPrivateCode(syncId) &&
    lastError?.kind === 'update-required' &&
    !buildWaiting
  if (!canReplace && confirmReplace) setConfirmReplace(false)
  const replaceShown = useRef(false)
  useEffect(() => {
    if (replaceShown.current && !canReplace && document.activeElement === document.body) {
      syncNow.current?.focus()
    }
    replaceShown.current = canReplace
  }, [canReplace])
  // The engine offers the move on a plain sync it can make private (4.1). The offer can go while
  // its question is open (the sync paused, an old device wrote): the question is taken back, and
  // a block that leaves with focus inside it hands the focus to Sync now, as Replace's does.
  const canMove = syncId !== null && !isPrivateCode(syncId) && move?.offered === true
  if (!canMove && confirmMove) setConfirmMove(false)
  // A running move keeps its busy button only while the sync is still plain: once the switch has
  // made it private (the old row may take a while to close), the block leaves with the old code.
  const moveShown = syncId !== null && !isPrivateCode(syncId) && (canMove || moving)
  const moveWasShown = useRef(false)
  useEffect(() => {
    if (moveWasShown.current && !moveShown && document.activeElement === document.body) {
      syncNow.current?.focus()
    }
    moveWasShown.current = moveShown
  }, [moveShown])
  // A move that failed half-way may have left a record that belongs to nothing: it is removed as
  // the panel opens (4.2), by the engine, which a linked device has loaded already.
  useEffect(() => {
    if (useSyncStore.getState().syncId === null) return
    loadSyncEngine()
      .then((engine) => engine.sweepMoveRecord())
      .catch(() => undefined)
  }, [])
  // "Synced · 2m ago" ages while the panel stays open, as on the pill; a retry counts down.
  useTick(lastError?.retryAt === undefined ? 15_000 : 5_000)

  /** A ref that focuses its element on mount when it is the successor asked for. */
  const focusWhenShown = (target: FocusTarget) => (element: HTMLElement | null) => {
    if (element && focusNext.current === target) {
      focusNext.current = null
      element.focus()
    }
  }

  /** Forgets a successor that never mounted (the request failed before the view changed). */
  const dropFocusRequest = (target: FocusTarget) => {
    if (focusNext.current === target) focusNext.current = null
  }

  /** Runs one panel request; `report` sees its result only if no Disconnect came between. */
  const runRequest = async <T,>(
    setBusy: (busy: boolean) => void,
    request: () => Promise<T>,
    report: (result: T) => void,
  ) => {
    const gen = ++requestGen.current
    setBusy(true)
    try {
      const result = await request()
      if (gen === requestGen.current) report(result)
    } finally {
      if (gen === requestGen.current) setBusy(false)
    }
  }

  /**
   * A failed result in its colour: the streak it belongs to decides (a retried failure turns red
   * after 10 minutes). 'off' means sync was switched off meanwhile: no toast.
   */
  const reportFailure = (result: SyncResult, message?: string) => {
    if (result.ok || result.error === 'off') return
    const streak = useSyncStore.getState().lastError
    const since = streak?.kind === result.error ? streak.since : Date.now()
    const text = message ?? result.message
    if (failureSeverity({ kind: result.error, since }) === 'warning') toast.warning(text)
    else toast.error(text)
  }

  /**
   * The banners now say something about the last failure that they did not say before the
   * request (`before`): their live region announces it, so a toast must not say it again.
   */
  const bannerNowSays = (before: string | null): boolean => {
    const shown = failureBanner(useSyncStore.getState().lastError)
    return shown !== null && shown !== before
  }

  /** Held back for an old device: saved here, but the relay does not hold this copy. */
  const heldBack = () => useSyncStore.getState().waitingForOld > 0

  /** Runs one setup, then says how it went: `done` on success. */
  const link = async (
    kind: SetupRequest['kind'],
    request: () => Promise<SyncResult>,
    done: string,
    after?: (result: SyncResult) => void,
  ) => {
    focusNext.current = 'sync-now'
    const lead: SetupLead = kind === 'generate' ? 'generated' : 'connected'
    const before = failureBanner(useSyncStore.getState().lastError)
    const setBusy = (busy: boolean) => {
      setConnecting(busy ? kind : null)
    }
    await runRequest(setBusy, request, (result) => {
      after?.(result)
      if (!result.ok) reportFailure(result, setupFailure(lead, result, bannerNowSays(before)))
      else if (heldBack()) toast.info(OLD_DEVICE_WAITING)
      else toast.success(done)
    })
    dropFocusRequest('sync-now')
  }

  const run = (request: SetupRequest) => {
    switch (request.kind) {
      case 'generate': {
        // A build whose relay writes by compare-and-set starts a private sync (PRIVATE-SYNC
        // 3.6). Its code is made by the engine, which the screens load on demand; a build on the
        // upsert transport makes a plain code, as before.
        void link(
          'generate',
          async (): Promise<SyncResult> => {
            let code: string
            try {
              code = privateSyncReady
                ? (await loadSyncEngine()).newPrivateCode()
                : crypto.randomUUID()
            } catch {
              return { ok: false, error: 'reload', message: SYNC_RELOAD_MESSAGE }
            }
            return setupSync(code)
          },
          privateSyncReady
            ? 'Private sync code created. Enter it on your other device.'
            : 'Sync code created. Join it on your other device.',
        )
        return
      }
      case 'join':
        void link(
          'join',
          () => setupSync(request.code, { join: true }),
          'Joined. This device is synced.',
        )
        return
      case 'reconnect':
        void link(
          'reconnect',
          // Not established when it left (a join that never found its copy): a join again.
          () => setupSync(request.code, { join: !request.established }),
          'Reconnected. This device is synced.',
          (result) => {
            // The code is this device's again (saved with the setup): the slot is spent.
            if (result.ok || result.error !== 'off') forgetPrevious()
          },
        )
    }
  }

  /** Sets up now, or first asks about the demo's sample rows while they are here. */
  const setUp = (request: SetupRequest) => {
    if (useExpenseStore.getState().demo !== 'sample') {
      run(request)
      return
    }
    // The question takes the pressed control's place: a double tap's second tap must not
    // answer it.
    shieldGesture()
    setAskDemo(request)
  }

  const answerDemo = (remove: boolean) => {
    const request = askDemo
    if (request === null) return
    setAskDemo(null)
    // The question's place goes back to the control that asked it until the linked view mounts.
    focusNext.current = request.kind === 'reconnect' ? 'reconnect' : 'generate'
    if (remove) {
      try {
        useExpenseStore.getState().clearSampleData()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't remove the sample data.")
        return
      }
    }
    run(request)
  }

  const backOutOfDemo = () => {
    if (askDemo === null) return
    focusNext.current = askDemo.kind === 'reconnect' ? 'reconnect' : 'generate'
    setAskDemo(null)
  }

  const handleManualSync = () => {
    // aria-disabled, not disabled, while it runs: the button keeps keyboard focus.
    if (manualSyncing) return
    // A result that puts a new banner up is said by the banner (its live region announces it); a
    // toast would say the same sentence a second time. A result the banners already showed
    // changes nothing there, so the toast is what tells the owner the tap was answered.
    const before = useSyncStore.getState()
    const shownBefore = {
      failure: failureBanner(before.lastError),
      waiting: before.waitingForOld > 0,
    }
    void runRequest(
      setManualSyncing,
      () => triggerSync({ resetBackoff: true }),
      (result) => {
        if (!result.ok) {
          if (!bannerNowSays(shownBefore.failure)) reportFailure(result)
        } else if (heldBack()) {
          if (shownBefore.waiting) toast.info(OLD_DEVICE_WAITING)
        } else toast.success('Synced')
      },
    )
  }

  const handleReplace = () => {
    setConfirmReplace(false)
    // The question leaves: its button comes back, busy, and takes focus.
    focusNext.current = 'replace'
    // The engine's own action, reached as Generate reaches it: the chunk is loaded on demand.
    const replace = async (): Promise<SyncResult> => {
      try {
        return await (await loadSyncEngine()).replaceRelayCopy()
      } catch {
        return { ok: false, error: 'reload', message: SYNC_RELOAD_MESSAGE }
      }
    }
    void runRequest(setReplacing, replace, (result) => {
      if (result.ok) {
        // The pause is over and this block leaves with it: focus goes to Sync now.
        syncNow.current?.focus()
        toast.success('Synced copy replaced')
      } else reportFailure(result)
    })
  }

  const handleMove = () => {
    setConfirmMove(false)
    // The question leaves: its button comes back, busy, and takes focus.
    focusNext.current = 'make-private'
    // The engine's own action, reached as Replace reaches it: the chunk is loaded on demand.
    const makePrivate = async (): Promise<MoveResult> => {
      try {
        return await (await loadSyncEngine()).makePrivate()
      } catch {
        return { ok: false, message: SYNC_RELOAD_MESSAGE }
      }
    }
    void runRequest(setMoving, makePrivate, (result) => {
      if (result.ok) {
        // This device is private now and the offer leaves with the plain sync: focus goes to
        // Sync now, and the new code is on screen under it.
        syncNow.current?.focus()
        toast.success(MOVED_MESSAGE)
      } else toast.warning(result.message)
    })
  }

  /** Stops syncing here. A plain code is remembered for 30 days for a one-tap Reconnect. */
  const handleDisconnect = (code: string | null) => {
    if (code !== null) keepPrevious(code, Date.now())
    focusNext.current = readPrevious(Date.now()) === null ? 'generate' : 'reconnect'
    requestGen.current++
    setConnecting(null)
    setManualSyncing(false)
    setReplacing(false)
    setConfirmReplace(false)
    setMoving(false)
    setConfirmMove(false)
    disconnectSync()
    setConfirmDisconnect(false)
    toast.info('Sync disconnected')
  }

  const disconnect = (code: string | null, detail: string) => (
    <DisconnectSync
      asking={confirmDisconnect}
      detail={detail}
      buttonRef={focusWhenShown('disconnect')}
      onAsk={() => {
        // The question takes this button's place: a double tap's second tap must not
        // answer it.
        shieldGesture()
        setConfirmDisconnect(true)
      }}
      onConfirm={() => {
        handleDisconnect(code)
      }}
      onCancel={() => {
        focusNext.current = 'disconnect'
        setConfirmDisconnect(false)
      }}
    />
  )

  // A newer SpendTrack set sync up on this device: this build cannot read it, so it offers no
  // Generate or Join (either would overwrite it), only a reload or an explicit Disconnect.
  if (syncId === null && cloudStatus === 'paused') {
    return (
      <div className="flex flex-col gap-3">
        <SyncBanners flush />
        <div className="border-t border-white/[0.06] pt-3">
          {disconnect(
            null,
            'This device forgets the sync a newer SpendTrack set up here. Your data stays on this device and on your other devices.',
          )}
        </div>
        <AppVersion />
      </div>
    )
  }

  if (!syncId) {
    return (
      <UnlinkedSync
        connecting={connecting}
        joinActive={joinActive}
        askDemo={askDemo}
        askSeparate={askSeparate}
        reconnectHintId={reconnectHintId}
        generateRef={focusWhenShown('generate')}
        reconnectRef={focusWhenShown('reconnect')}
        onSetUp={setUp}
        onAskSeparate={setAskSeparate}
        onConfirmSeparate={() => {
          setAskSeparate(false)
          focusNext.current = 'generate'
          setUp({ kind: 'generate' })
        }}
        onCancelSeparate={() => {
          focusNext.current = 'generate'
          setAskSeparate(false)
        }}
        onAnswerDemo={answerDemo}
        onBackOutOfDemo={backOutOfDemo}
        onJoin={(code) => {
          run({ kind: 'join', code })
        }}
        onJoinActiveChange={setJoinActive}
      />
    )
  }

  const status = statusView({
    status: cloudStatus,
    lastSyncAt,
    pendingLocal,
    pending,
    lastError,
    waitingForOld,
    manual: manualSyncing,
    resumes,
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div>
          <SyncStatusRow
            status={status}
            statusId={statusId}
            syncing={manualSyncing}
            buttonRef={(element) => {
              syncNow.current = element
              focusWhenShown('sync-now')(element)
              // The pill that opened Settings asked for it.
              if (element && useUIStore.getState().takeSettingsFocus('sync-now')) element.focus()
            }}
            onSync={handleManualSync}
          />
          <SyncBanners />
        </div>
        {/* Fenced out of this sync because it was made private on another device (PRIVATE-SYNC
            3.7): the field for the new code is here, in place. Joining keeps this device's
            entries and merges them. */}
        {lastError?.kind === 'moved-private' && (
          <div className="flex flex-col gap-2">
            <JoinSync
              busy={connecting !== null}
              joining={connecting === 'join'}
              onJoin={(code) => {
                run({ kind: 'join', code })
              }}
              onActiveChange={setJoinActive}
            />
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              No code? Use Disconnect at the bottom of this page, then start a new sync. Your
              entries stay on this device.
            </p>
          </div>
        )}
        {/* A private copy this device cannot read as current, with no newer build to reload
            into (PRIVATE-SYNC 3.9). */}
        {canReplace && (
          <ReplaceCopy
            asking={confirmReplace}
            replacing={replacing}
            buttonRef={focusWhenShown('replace')}
            onAsk={() => {
              if (replacing) return
              // The question takes this button's place: a double tap's second tap must
              // not answer it.
              shieldGesture()
              setConfirmReplace(true)
            }}
            onConfirm={handleReplace}
            onCancel={() => {
              focusNext.current = 'replace'
              setConfirmReplace(false)
            }}
          />
        )}
        {/* A fenced device's code is the old one, which no device syncs with any more: the
            field above is where the new one goes, and one code on screen is enough. */}
        {lastError?.kind !== 'moved-private' && <SyncCode code={syncId} />}
        {isPrivateCode(syncId) && (
          <>
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              Private sync: what this device sends is encrypted here first. Only a device with this
              code can read the synced copy from now on.
            </p>
            {/* What the engine says of a move this device made: closing the old sync, the next
                step, contested, a write to the old sync after it was closed (PRIVATE-SYNC
                4.5). Only a private sync has them; the switch itself is said by its toast. */}
            <MoveLines lines={move?.lines ?? []} tones={move?.tones ?? []} />
          </>
        )}
        {moveShown && (
          <MoveOffer
            asking={confirmMove}
            moving={moving}
            buttonRef={focusWhenShown('make-private')}
            hintId={moveHintId}
            onAsk={() => {
              if (moving) return
              // The question takes this button's place: a double tap's second tap must not
              // answer it.
              shieldGesture()
              setConfirmMove(true)
            }}
            onConfirm={handleMove}
            onCancel={() => {
              focusNext.current = 'make-private'
              setConfirmMove(false)
            }}
          />
        )}
        <CodeSafety />
      </div>

      <SyncDevices />

      <div className="border-t border-white/[0.06] pt-3">
        {disconnect(
          syncId,
          [
            // Disconnect forgets a private code for good (PRIVATE-SYNC 3.2): there is no Reconnect.
            isPrivateCode(syncId)
              ? 'This device stops syncing and forgets the sync code. Copy it first if you may link this device again. Your data stays here and on your other devices.'
              : 'This device stops syncing. Your data stays on this device, on your other devices and in the relay.',
            // While the old sync is open, or no other device has the new code yet (4.5).
            ...(move?.disconnect ?? []),
          ].join(' '),
        )}
      </div>
      <AppVersion />
    </div>
  )
}
