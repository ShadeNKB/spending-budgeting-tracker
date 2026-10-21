// Is the user in the middle of something a reload would throw away?
//
// Deliberately conservative and blind to component labels: any open dialog counts, and so
// does any visible, editable text field that holds text. A false positive only adds a
// confirm step or skips an automatic reload; it never loses data.

const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open]'
const TEXT_FIELD = 'input, textarea'
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'tel', 'url'])

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  // `type` reflects as "text" when the attribute is missing or unknown.
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)
}

function isShown(el: Element): boolean {
  if (el.closest('[hidden], [inert]')) return false
  const view = el.ownerDocument.defaultView
  if (!view) return true
  if (view.getComputedStyle(el).visibility === 'hidden') return false
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return false
  }
  return true
}

export function hasUnsavedWork(root: ParentNode = document): boolean {
  if (root.querySelector(OPEN_DIALOG)) return true
  for (const el of root.querySelectorAll(TEXT_FIELD)) {
    if (!isTextField(el) || el.disabled || el.readOnly) continue
    if (el.value.trim() !== '' && isShown(el)) return true
  }
  return false
}
