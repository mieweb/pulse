import { cubicBezier, Easing } from 'react-native-reanimated';

/**
 * Motion shared across the app, so the same kind of movement feels the same everywhere.
 *
 * - `EaseOut` for anything entering, leaving or reacting to a press: fast start, soft landing.
 * - Springs are critically damped (`dampingRatio: 1`) unless a finger threw the thing, in which
 *   case the release velocity carries into the spring.
 */
export const EaseOut = Easing.bezier(0.23, 1, 0.32, 1);
/** `EaseOut` for Reanimated CSS transitions (`transitionTimingFunction`). */
export const EaseOutCss = cubicBezier(0.23, 1, 0.32, 1);

/** Lists closing a gap (a deleted row). */
export const ListReflowMs = 250;
