// Real work a fake clock cannot run: WebCrypto calls and gzip streams settle on real threads.
// A test that drives fake timers and real tasks in turn must not move the fake clock while such
// work is in flight, or the fake time it spends waiting is as long as this machine is slow: a
// loaded runner then reaches a fake deadline (a test's budget, a codec's) that a quiet one never
// does. `trackRealWork()` counts that work; `realWorkPending()` says whether any is in flight.
import { vi } from 'vitest'

const SUBTLE_CALLS = [
  'decrypt',
  'deriveBits',
  'deriveKey',
  'digest',
  'encrypt',
  'importKey',
] as const

const state = { pending: 0, installed: false }

/** How many WebCrypto calls and gzip streams are in flight now. */
export function realWorkPending(): number {
  return state.pending
}

function begin(): () => void {
  state.pending++
  let open = true
  return () => {
    if (!open) return
    open = false
    state.pending--
  }
}

type Codec = new (format: CompressionFormat) => ReadableWritablePair<Uint8Array, BufferSource>

/** The platform's (de)compression stream, counted from its making until it is read out. */
function tracked(Real: Codec): Codec {
  return class Tracked {
    readonly writable: WritableStream<BufferSource>
    readonly readable: ReadableStream<Uint8Array>

    constructor(format: CompressionFormat) {
      const inner = new Real(format)
      const end = begin()
      const reader = inner.readable.getReader()
      this.writable = inner.writable
      this.readable = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const step = await reader.read()
            if (step.done) {
              end()
              controller.close()
            } else {
              controller.enqueue(step.value)
            }
          } catch (err) {
            end()
            controller.error(err)
          }
        },
        async cancel(reason) {
          end()
          await reader.cancel(reason)
        },
      })
    }
  }
}

/**
 * Counts every WebCrypto call and gzip stream from now until `untrackRealWork()` (in a
 * `beforeEach`; `vi.unstubAllGlobals()` puts the platform's streams back). The calls are wrapped
 * on the `crypto.subtle` object itself, so a test's own spy on one of them still sees the call,
 * and still reaches the platform's.
 */
export function trackRealWork(): void {
  if (state.installed) return
  state.installed = true
  state.pending = 0
  const subtle = globalThis.crypto.subtle
  for (const name of SUBTLE_CALLS) {
    const real = (SubtleCrypto.prototype[name] as (...args: unknown[]) => Promise<unknown>).bind(
      subtle,
    )
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): Promise<unknown> => {
        const end = begin()
        try {
          const promise = real(...args)
          promise.then(end, end)
          return promise
        } catch (err) {
          end()
          throw err
        }
      },
    })
  }
  if (typeof CompressionStream === 'function') {
    vi.stubGlobal('CompressionStream', tracked(CompressionStream))
  }
  if (typeof DecompressionStream === 'function') {
    vi.stubGlobal('DecompressionStream', tracked(DecompressionStream))
  }
}

/** Puts the platform's calls back (the streams go back with `vi.unstubAllGlobals()`). */
export function untrackRealWork(): void {
  if (!state.installed) return
  state.installed = false
  const subtle = globalThis.crypto.subtle
  for (const name of SUBTLE_CALLS) Reflect.deleteProperty(subtle, name)
  state.pending = 0
}
