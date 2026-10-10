import { useWindowDimensions } from 'react-native';

/**
 * A React `key` for text that changes when the system text size does. React Native (0.86, the new
 * architecture) keeps each text node's measurement from the size it was first laid out at, so after
 * a text-size change while the app runs, a text that re-renders for any other reason is drawn at
 * the new size in a box measured at the old one (clipped glyphs, cut-off labels) until the app is
 * relaunched. Keying text by the size makes it remount, and so re-measure, exactly when it changes.
 */
export function useTextSizeKey(): string {
  return String(useWindowDimensions().fontScale);
}
