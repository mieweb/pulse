import type { TipId } from './tips';

export type TipAnchorProps = {
  id: TipId;
  /** From `useTip`: whether the tip is on screen. */
  shown: boolean;
  /** From `useTip`: the tip was closed. */
  onDismiss: () => void;
  /** iOS: which side of the control the arrow points from; the system picks when unset. */
  arrowEdge?: 'top' | 'bottom' | 'leading' | 'trailing';
};
