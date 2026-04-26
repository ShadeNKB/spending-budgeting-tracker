import { useEffect } from "react";

type Bind = Record<string, (e: KeyboardEvent) => void>;

const shouldIgnore = (target: EventTarget | null, modPressed: boolean, key: string): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  const editable = tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  if (!editable) return false;
  if (modPressed) return false;
  // Still allow ESC even when typing
  return key !== "escape";
};

/**
 * Global hotkey hook.
 *
 * Keys are lowercased. Use "mod+" prefix for Meta (macOS) or Ctrl (Win/Linux).
 * Examples: { "mod+k": fn, "n": fn, "escape": fn }
 */
export function useHotkeys(binds: Bind, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const id = `${mod ? "mod+" : ""}${key}`;
      const fn = binds[id];
      if (!fn) return;
      if (shouldIgnore(e.target, mod, key)) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [binds, enabled]);
}
