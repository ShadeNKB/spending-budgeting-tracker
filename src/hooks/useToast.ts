import { useUIStore } from "../stores/useUIStore";

export function useToast() {
  const pushToast = useUIStore((s) => s.pushToast);
  return {
    success: (message: string, opts?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      pushToast({ kind: "success", message, ...opts }),
    error: (message: string, opts?: { duration?: number }) =>
      pushToast({ kind: "error", message, ...opts }),
    info: (message: string, opts?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      pushToast({ kind: "info", message, ...opts }),
    warning: (message: string, opts?: { duration?: number }) =>
      pushToast({ kind: "warning", message, ...opts }),
  };
}
