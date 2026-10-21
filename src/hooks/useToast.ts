import { useUIStore, type Toast } from '../stores/useUIStore'

type ToastOptions = Pick<Toast, 'duration' | 'action'>

const push = (kind: Toast['kind'], message: string, opts?: ToastOptions) =>
  useUIStore.getState().pushToast({ kind, message, ...opts })

// One module-level API: callers can list it in effect/memo deps without re-running them.
const toastApi = Object.freeze({
  success: (message: string, opts?: ToastOptions) => push('success', message, opts),
  error: (message: string, opts?: Pick<ToastOptions, 'duration'>) => push('error', message, opts),
  info: (message: string, opts?: ToastOptions) => push('info', message, opts),
  warning: (message: string, opts?: Pick<ToastOptions, 'duration'>) =>
    push('warning', message, opts),
})

export function useToast() {
  return toastApi
}
