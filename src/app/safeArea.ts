/**
 * The page gutter, widened to clear the notch: an installed iPhone app in landscape draws
 * under the side cut-outs (viewport-fit=cover), so content keeps at least the safe-area inset.
 * One definition for the header row, the update banner, <main> and the full-page error.
 */
export const SAFE_GUTTER_X =
  'pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] md:pl-[max(2rem,env(safe-area-inset-left,0px))] md:pr-[max(2rem,env(safe-area-inset-right,0px))]'
