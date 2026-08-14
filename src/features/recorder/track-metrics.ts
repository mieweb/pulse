import { Spacing } from '@/constants/theme';

// Single source of truth for the segment-track geometry, shared by the segment bar
// (layout) and the playhead cursor (px ↔ ms mapping). The bar's Sortable.Grid MUST use
// TRACK_GAP as its columnGap — the cursor mapping assumes slot i starts at i * STEP.

export const THUMB_HEIGHT = 64;
export const THUMB_WIDTH = 48;
export const TRACK_GAP = Spacing.two;
/** Record-button diameter + its gap above the bar — shared so the drag-to-trash button can
 *  sit exactly where the record button is (clean swap as one fades out and the other in). */
export const RECORD_BUTTON_SIZE = 76;
export const RECORD_BAR_GAP = Spacing.three;
/** Horizontal rhythm of the track: one thumb + the grid's column gap. */
export const STEP = THUMB_WIDTH + TRACK_GAP;
/** Extra lane below the thumbs the cursor knob hangs into (keeps it off taps/✕/drag). The
 *  knob visibly overhangs the scroll frame by ~4pt; the rest is finger headroom for its
 *  hitSlop. Also the bar's top padding (see segment-bar): the lane is bottom-only, so the
 *  bar mirrors it on top to keep the thumbs visually centered. */
export const SCRUB_LANE = 12;
export const KNOB = 14;
/** Ordinal badge-pill diameter — it doubles as the drag handle's visible affordance, so it's
 *  sized generously. Half of it rides above the thumb's top edge; POP_LANE (the vertical
 *  breathing room inside the scroll frame) must be at least BADGE_SIZE / 2. Shared with the
 *  playhead cursor so its line can start below the pill instead of striking through it. */
export const BADGE_SIZE = 18;
/** Left inset of the track content so the playhead knob at globalMs=0 (centered on the line at
 *  the first thumb's left edge) isn't clipped by the viewport's overflow:hidden. The cursor adds
 *  the same inset to its x so the line stays aligned with the thumbnails. */
export const SCRUB_INSET = KNOB / 2;
/** Vertical breathing room added inside the scroll content (top + bottom) so the badge
 *  drag-handle pill riding half above the thumb's top edge (9pt) isn't clipped by the
 *  ScrollView's bounds. Symmetric → thumbs stay vertically centered. The playhead line
 *  shifts down by this much to stay on the thumb's top edge. */
export const POP_LANE = 10;
