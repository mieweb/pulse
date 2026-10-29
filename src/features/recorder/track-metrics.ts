import { Spacing } from '@/constants/theme';

// The recorder's clip bar geometry, and the record button's size (the drag-to-trash target sits
// where the record button is).

export const THUMB_HEIGHT = 64;
export const THUMB_WIDTH = 48;
export const TRACK_GAP = Spacing.two;
/** Record-button diameter + its gap above the bar — shared so the drag-to-trash button can
 *  sit exactly where the record button is (clean swap as one fades out and the other in). */
export const RECORD_BUTTON_SIZE = 76;
export const RECORD_BAR_GAP = Spacing.three;
/** Room above and below the thumbs inside the bar's viewport. */
export const BAR_LANE = 12;
/** Ordinal badge-pill diameter. Half of it rides above the thumb's top edge; POP_LANE (the
 *  vertical breathing room inside the scroll frame) must be at least BADGE_SIZE / 2. */
export const BADGE_SIZE = 18;
/** Vertical breathing room added inside the scroll content (top + bottom) so the badge pill
 *  riding half above the thumb's top edge (9pt) isn't clipped by the ScrollView's bounds.
 *  Symmetric → thumbs stay vertically centered. */
export const POP_LANE = 10;
