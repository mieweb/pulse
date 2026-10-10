import { CalloutAnchor } from './tip-callout';
import type { TipAnchorProps } from './tip-anchor-types';

/**
 * A one-time tip pointing at whatever this is laid over. Android draws every tip as a callout
 * (`tip-callout`): Material's tooltip has no arrow, so it didn't show which control it was about.
 */
export function TipAnchor({ id, shown, onDismiss }: TipAnchorProps) {
  return <CalloutAnchor id={id} shown={shown} onDismiss={onDismiss} />;
}
