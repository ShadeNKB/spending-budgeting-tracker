/** Where a deleted category's entries go: it can be neither renamed nor deleted. */
export const OTHER = 'Other'

/** What an action that refused its input said (P2-13). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "That didn't work. Nothing was changed."
}
