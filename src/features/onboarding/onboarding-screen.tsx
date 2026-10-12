import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { EaseOut } from '@/constants/motion';
import { Spacing } from '@/constants/theme';
import { markOnboardingComplete } from '@/db/settings';
import { WELCOME_FEATURES } from '@/features/onboarding/steps';
import { useTextScale } from '@/hooks/use-text-scale';
import { useTheme } from '@/hooks/use-theme';

/**
 * The rows arrive one after another, after the title: quick enough not to keep anyone waiting.
 * Continue doesn't wait for them, or move: it fades in at once, so it's never a moving or invisible
 * target.
 */
const ENTER_MS = 400;
const ROW_STAGGER_MS = 80;
const rowEnter = (i: number) =>
  FadeInDown.duration(ENTER_MS)
    .easing(EaseOut)
    .delay(200 + i * ROW_STAGGER_MS);

/** Width of the column the feature glyphs centre in, at the default text size. */
const FEATURE_ICON_COLUMN = 40;

/**
 * First launch: one welcome screen, like Apple's own apps open with — what Pulse is for, a word on
 * privacy and Continue, which goes straight to the recorder. Nothing to swipe through or skip;
 * the controls are taught by one-time tips beside them as they're first used (features/tips).
 */
export function OnboardingScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // The feature glyphs grow with their text; so does the column they're centred in.
  const iconColumn = { width: Math.round(FEATURE_ICON_COLUMN * useTextScale()) };

  // Continue goes on to the recorder; Android's Back goes back to Home. Either way the welcome is
  // done: Back is the way past it without recording, as Skip was on the old tour.
  const finish = useCallback((toRecorder: boolean) => {
    // Don't block navigation on the write, but don't swallow a failure either —
    // if this never persists, the welcome re-shows on every launch.
    markOnboardingComplete().catch((e) => {
      console.warn('[onboarding] failed to persist completion; onboarding will re-show', e);
    });
    if (toRecorder) router.replace('/recorder');
    else router.back();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      finish(false);
      return true;
    });
    return () => sub.remove();
  }, [finish]);

  return (
    // Grouped, like the other full-screen screens.
    <ThemedView type="groupedBackground" style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.six }]}
        showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(ENTER_MS).easing(EaseOut)} style={styles.hero}>
          <Image
            source={require('../../../assets/images/pulse-logo-master-2048.png')}
            style={styles.logo}
            contentFit="contain"
            accessibilityIgnoresInvertColors
          />
          <ThemedText type="largeTitle" style={styles.title} accessibilityRole="header">
            Welcome to Pulse
          </ThemedText>
        </Animated.View>

        <View style={styles.features}>
          {WELCOME_FEATURES.map((feature, i) => (
            <Animated.View key={feature.title} entering={rowEnter(i)} style={styles.feature}>
              <View style={[styles.featureIcon, iconColumn]}>
                <Icon name={feature.icon} size={30} tintColor={theme.accent} scalesWithText />
              </View>
              <View style={styles.featureText}>
                <ThemedText type="headline">{feature.title}</ThemedText>
                <ThemedText type="subheadline" themeColor="textSecondary">
                  {feature.text}
                </ThemedText>
              </View>
            </Animated.View>
          ))}
        </View>
      </ScrollView>

      <Animated.View
        entering={FadeIn.duration(ENTER_MS / 2).easing(EaseOut)}
        style={[styles.footer, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.privacy}>
          <Icon name="lock.fill" size={14} tintColor={theme.textSecondary} scalesWithText />
          <ThemedText type="footnote" themeColor="textSecondary" style={styles.privacyText}>
            No account needed. Your recordings stay on this device unless you share or upload them.
          </ThemedText>
        </View>
        <PrimaryButton label="Continue" onPress={() => finish(true)} />
      </Animated.View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Text keeps a narrower column (32 pt each side) than the footer's 16 pt gutter, as Apple's
  // welcome screens do.
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.four,
    gap: Spacing.five,
  },
  hero: { alignItems: 'center', gap: Spacing.three },
  logo: { width: 96, height: 96 },
  title: { textAlign: 'center' },
  features: { gap: Spacing.four },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  // A fixed column so the three glyphs line up whatever their shape, centred on the title line.
  featureIcon: { alignItems: 'center', paddingTop: Spacing.half },
  featureText: { flex: 1, gap: Spacing.half },
  footer: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.three },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: Spacing.one + Spacing.half,
    paddingHorizontal: Spacing.three,
  },
  privacyText: { flexShrink: 1, textAlign: 'center' },
});
