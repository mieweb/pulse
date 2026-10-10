import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Icon } from '@/components/icon';
import { useCallback, useRef, useState } from 'react';
import {
  type FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CardShadow, Opacity, Spacing } from '@/constants/theme';
import { markOnboardingComplete } from '@/db/settings';
import { ONBOARDING_STEPS } from '@/features/onboarding/steps';
import { useTheme } from '@/hooks/use-theme';

const DOT = 8;
const DOT_ACTIVE = 22;
const DOT_GAP = Spacing.two;
/**
 * The dot row's width, the same at every scroll position: the page arriving widens its dot by as
 * much as the page leaving narrows its own, so one active dot's width is always shared out.
 */
const DOTS_WIDTH = DOT_ACTIVE + (ONBOARDING_STEPS.length - 1) * (DOT + DOT_GAP);

/** How wide dot `i` is with the pages scrolled to `x` (pages `width` wide). */
function dotWidth(i: number, x: number, width: number): number {
  'worklet';
  return interpolate(
    x,
    [(i - 1) * width, i * width, (i + 1) * width],
    [DOT, DOT_ACTIVE, DOT],
    Extrapolation.CLAMP,
  );
}

/**
 * A single page indicator that grows/brightens as its page scrolls into view. Absolutely placed
 * in a fixed track and childless, so its width and position change every scroll frame without
 * laying out anything else: in a flowing row, each frame's width change re-laid the whole row.
 * Its offset is the dots before it at their resting width, plus however much they've grown.
 */
function Dot({
  index,
  scrollX,
  width,
  color,
}: {
  index: number;
  scrollX: SharedValue<number>;
  width: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const x = scrollX.get();
    let offset = index * (DOT + DOT_GAP);
    for (let i = 0; i < index; i++) offset += dotWidth(i, x, width) - DOT;
    return {
      width: dotWidth(index, x, width),
      transform: [{ translateX: offset }],
      opacity: interpolate(
        x,
        [(index - 1) * width, index * width, (index + 1) * width],
        [0.35, 1, 0.35],
        Extrapolation.CLAMP,
      ),
    };
  });
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

export function OnboardingScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scrollX = useSharedValue(0);
  const listRef = useRef<FlatList<(typeof ONBOARDING_STEPS)[number]>>(null);
  const [index, setIndex] = useState(0);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.set(e.contentOffset.x);
  });

  const isLast = index === ONBOARDING_STEPS.length - 1;

  // Both "Skip" and the final CTA mark onboarding done so it never reappears.
  // Skipping returns to home; finishing drops the user straight into the recorder.
  const finish = useCallback((toRecorder: boolean) => {
    // Don't block navigation on the write, but don't swallow a failure either —
    // if this never persists, onboarding re-shows on every launch.
    markOnboardingComplete().catch((e) => {
      console.warn('[onboarding] failed to persist completion; onboarding will re-show', e);
    });
    if (toRecorder) router.replace('/recorder');
    else router.back();
  }, []);

  const next = () => {
    if (isLast) finish(true);
    else listRef.current?.scrollToIndex({ index: index + 1, animated: true });
  };

  return (
    // Grouped, like the other full-screen screens: the white icon tile reads as a card on it.
    <ThemedView type="groupedBackground" style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + Spacing.two }]}>
        <Pressable
          onPress={() => finish(false)}
          hitSlop={12}
          accessibilityRole="button"
          style={({ pressed }) => pressed && styles.pressedText}>
          <ThemedText type="subheadlineEmphasized" themeColor="textSecondary">
            Skip
          </ThemedText>
        </Pressable>
      </View>

      <Animated.FlatList
        ref={listRef}
        data={ONBOARDING_STEPS}
        keyExtractor={(item) => item.key}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <ScrollView
            style={{ width }}
            contentContainerStyle={styles.page}
            showsVerticalScrollIndicator={false}>
            {item.image ? (
              <Image source={item.image} style={styles.logo} contentFit="contain" />
            ) : (
              <View style={[styles.iconCard, { backgroundColor: theme.card }]}>
                <Icon name={item.symbol ?? 'sparkles'} size={56} tintColor={theme.accent} />
              </View>
            )}
            <ThemedText type="title1" style={styles.title}>
              {item.title}
            </ThemedText>
            <View style={styles.bullets}>
              {item.bullets.map((bullet, i) => (
                <View key={i} style={styles.bulletRow}>
                  <View style={styles.bulletLead}>
                    {bullet.record ? (
                      <View style={[styles.recordRing, { borderColor: theme.accent }]}>
                        <View style={[styles.recordDot, { backgroundColor: theme.accent }]} />
                      </View>
                    ) : bullet.icon ? (
                      <Icon name={bullet.icon} size={19} tintColor={theme.accent} scalesWithText />
                    ) : (
                      <View style={[styles.bulletDot, { backgroundColor: theme.accent }]} />
                    )}
                  </View>
                  <ThemedText type="body" style={styles.bulletText}>
                    {bullet.text}
                  </ThemedText>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.dots}>
          {ONBOARDING_STEPS.map((step, i) => (
            <Dot key={step.key} index={i} scrollX={scrollX} width={width} color={theme.accent} />
          ))}
        </View>
        <PrimaryButton label={isLast ? 'Start recording' : 'Next'} onPress={next} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // The app's 16 pt full-screen gutter for the bar and the footer; the pages' text keeps a
  // narrower column (32 pt each side), easier to read at a glance.
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.three,
  },
  page: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.four,
    gap: Spacing.four,
  },
  logo: {
    width: 132,
    height: 132,
  },
  iconCard: {
    width: 116,
    height: 116,
    borderRadius: 28,
    borderCurve: 'continuous',
    ...CardShadow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Size/leading come from the `title1` type; keep it centered and bold for the onboarding hero.
  title: {
    textAlign: 'center',
    fontWeight: '700',
  },
  bullets: {
    width: '100%',
    gap: Spacing.three,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
  },
  // Fixed lead column, sized to the first text line (body's lineHeight 22) and centering
  // whatever glyph it holds — so icon, dot, and record bullets all align to the first line.
  bulletLead: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  // Mini record button: a red disc inside a red ring, matching the recorder's shutter.
  recordRing: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
  },
  bulletText: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.four,
  },
  // A fixed track the dots are placed in (see `Dot`), centred in the footer.
  dots: {
    alignSelf: 'center',
    width: DOTS_WIDTH,
    height: 10,
  },
  dot: {
    position: 'absolute',
    top: (10 - DOT) / 2,
    left: 0,
    height: DOT,
    borderRadius: DOT / 2,
  },
  pressedText: { opacity: Opacity.pressedGlyph },
});
