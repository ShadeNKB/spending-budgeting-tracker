import { Component, type ReactNode } from 'react'

interface Props {
  /** Changing this clears a caught error (for overlays: their open flag). */
  resetKey: unknown
  fallback: (error: unknown, reset: () => void) => ReactNode
  children: ReactNode
}

interface State {
  caught: { error: unknown } | null
  resetKey: unknown
}

/** Keeps a crashing overlay from taking the rest of the app down with it. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { caught: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { caught: { error } }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null
    return { caught: null, resetKey: props.resetKey }
  }

  private readonly reset = () => {
    this.setState({ caught: null })
  }

  override render(): ReactNode {
    const { caught } = this.state
    return caught ? this.props.fallback(caught.error, this.reset) : this.props.children
  }
}
