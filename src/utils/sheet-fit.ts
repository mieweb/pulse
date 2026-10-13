import { Dimensions, PixelRatio } from 'react-native';

/** Above this system text size (Dynamic Type / font scale), a tall sheet outgrows the screen. */
const MAX_FONT_SCALE = 1.15;
/** Below this window height (e.g. iPhone SE, 667 pt), it outgrows the screen at any text size. */
const MIN_WINDOW_HEIGHT = 700;

/**
 * Whether the app's taller content-sized sheets (About, On-device AI) fit on this screen at this
 * text size. When they don't, they open full height and scroll instead of being clipped: a form
 * sheet sized to its content cuts off whatever is taller than the screen.
 *
 * Read when the sheet opens (route options and the screen agree on it); a text-size change while
 * one is open applies the next time it opens.
 */
export function tallSheetFits(): boolean {
  return (
    PixelRatio.getFontScale() <= MAX_FONT_SCALE &&
    Dimensions.get('window').height >= MIN_WINDOW_HEIGHT
  );
}

/** Route options for a tall sheet: sized to its content when it fits, else full height. */
export function tallSheetOptions() {
  return tallSheetFits()
    ? { sheetAllowedDetents: 'fitToContents' as const }
    : { sheetAllowedDetents: [1] };
}
