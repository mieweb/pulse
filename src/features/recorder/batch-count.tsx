import { StyleSheet, Text, View } from 'react-native';

// Held as the clip chips over thumbnails are: it has a fixed spot on the button's edge.
const BATCH_COUNT_TEXT_SCALE = 1.2;

/**
 * Which image of a batch the busy "+" is on ("2/5"): a small pill on the button's top-right edge,
 * outside its layout so nothing moves, and not animated. Screen readers hear it in the button's
 * value ("Adding 2 of 5"), so it's hidden from them here.
 */
export function BatchCount({
  text,
  color,
  background,
}: {
  text: string;
  color: string;
  background: string;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.pill, { backgroundColor: background, borderColor: color }]}>
      <Text
        style={[styles.text, { color }]}
        numberOfLines={1}
        maxFontSizeMultiplier={BATCH_COUNT_TEXT_SCALE}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 22,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
  },
  text: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
