import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TypedConfirm } from './TypedConfirm'

function renderConfirm(over: Partial<React.ComponentProps<typeof TypedConfirm>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <TypedConfirm
      question="Delete all 12 entries on this device and on your other devices?"
      detail="They go everywhere when your devices next sync."
      word="DELETE"
      confirmLabel="Delete everywhere"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  )
  const field = screen.getByRole('textbox', { name: 'Type DELETE to confirm' })
  const confirm = screen.getByRole('button', { name: 'Delete everywhere' })
  return { onConfirm, onCancel, field, confirm }
}

describe('TypedConfirm', () => {
  it('is a group named by the question and described by the detail, with the field focused', () => {
    const { field } = renderConfirm()
    const group = screen.getByRole('group', {
      name: 'Delete all 12 entries on this device and on your other devices?',
    })
    expect(group).toHaveAccessibleDescription('They go everywhere when your devices next sync.')
    expect(field).toHaveFocus()
    // Nothing for the phone keyboard to "help" with: no suggestions, capitals by default.
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAttribute('autocapitalize', 'characters')
    expect(field).toHaveAttribute('autocorrect', 'off')
    expect(field).toHaveAttribute('spellcheck', 'false')
  })

  it('keeps the confirm button disabled until the exact word is typed', async () => {
    const user = userEvent.setup()
    const { field, confirm, onConfirm } = renderConfirm()
    expect(confirm).toBeDisabled()
    await user.type(field, 'delete')
    expect(confirm).toBeDisabled()
    await user.clear(field)
    await user.type(field, 'DELET')
    expect(confirm).toBeDisabled()
    await user.type(field, 'E')
    expect(confirm).toBeEnabled()
    await user.type(field, 'S')
    expect(confirm).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // On a laptop nothing capitalises: the label is drawn in capitals, so case is easy to miss.
  it('says under the field that the word wants capitals, and Enter says it again', async () => {
    const user = userEvent.setup()
    const { field, confirm, onConfirm } = renderConfirm()
    expect(field).not.toHaveAccessibleDescription()
    await user.type(field, 'delete')
    expect(confirm).toBeDisabled()
    expect(field).toHaveAccessibleDescription('Type it in capitals: DELETE')
    await user.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
    await user.clear(field)
    await user.type(field, 'DELETE')
    expect(field).not.toHaveAccessibleDescription()
    // a different word is no case slip: no hint
    await user.clear(field)
    await user.type(field, 'remove')
    expect(field).not.toHaveAccessibleDescription()
  })

  it('ignores spaces around the word (a phone keyboard may add one)', async () => {
    const user = userEvent.setup()
    const { field, confirm } = renderConfirm()
    await user.type(field, ' DELETE ')
    expect(confirm).toBeEnabled()
  })

  it('Enter in the field does nothing until the word matches, then confirms once', async () => {
    const user = userEvent.setup()
    const { field, onConfirm } = renderConfirm()
    await user.type(field, 'DEL{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
    await user.type(field, 'ETE{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('a held Enter (auto-repeat) and a second Enter cannot confirm twice', () => {
    const { field, onConfirm } = renderConfirm()
    fireEvent.change(field, { target: { value: 'DELETE' } })
    fireEvent.keyDown(field, { key: 'Enter', repeat: true })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter', repeat: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('a double tap on the confirm button confirms once', async () => {
    const user = userEvent.setup()
    const { field, confirm, onConfirm } = renderConfirm()
    await user.type(field, 'DELETE')
    await user.dblClick(confirm)
    fireEvent.click(confirm, { detail: 1 })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Enter while an IME composes is not a confirm', () => {
    const { field, onConfirm } = renderConfirm()
    fireEvent.change(field, { target: { value: 'DELETE' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Escape cancels the question (and is marked handled, so the sheet stays open)', () => {
    const { field, onCancel } = renderConfirm()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    field.dispatchEvent(event)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Cancel cancels', async () => {
    const user = userEvent.setup()
    const { onCancel, onConfirm } = renderConfirm()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('works for another word', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <TypedConfirm
        question="Replace with this file?"
        word="REPLACE"
        confirmLabel="Replace"
        tone="warning"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    )
    const field = screen.getByRole('textbox', { name: 'Type REPLACE to confirm' })
    await user.type(field, 'REPLACE')
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
