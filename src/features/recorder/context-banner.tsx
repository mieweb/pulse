import { Pressable, StyleSheet, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { ThemedText } from '@/components/themed-text';
import { Opacity, Spacing } from '@/constants/theme';
import type { HostContext } from '@/db/host-context';
import { uploadRulesOf } from '@/features/export/send-checks';

/** Text over the live camera stops growing here, as the recorder's other chrome does. */
const MAX_SCALE = 1.3;

/**
 * The banner's lines for a host place (C7): "For: <label> · <type title>" ("For: Fix login ·
 * Ticket"), and the upload type's prompt ("Say what you finished today") when it has one.
 */
export function bannerLines(context: HostContext): { title: string; prompt: string | null } {
  const rules = uploadRulesOf(context.uploadType);
  const label = context.label.trim();
  return {
    title: rules?.title ? `For: ${label} · ${rules.title}` : `For: ${label}`,
    prompt: rules?.prompt ?? null,
  };
}

/**
 * What the recording is for, over the top of the camera: shown when a host opened the recorder
 * for one of its places, never in the Pulse app. One accessible element (read as a whole), and no
 * animation: it is there from the first frame.
 */
export function ContextBanner({ context }: { context: HostContext }) {
  const { title, prompt } = bannerLines(context);
  return (
    <GlassPill
      style={styles.pill}
      accessible
      accessibilityRole="text"
      accessibilityLabel={prompt ? `${title}. ${prompt}` : title}
      testID="recorder.context">
      <ThemedText
        type="subheadlineEmphasized"
        style={styles.text}
        numberOfLines={2}
        maxFontSizeMultiplier={MAX_SCALE}>
        {title}
      </ThemedText>
      {prompt && (
        <ThemedText
          type="footnote"
          style={[styles.text, styles.prompt]}
          numberOfLines={3}
          maxFontSizeMultiplier={MAX_SCALE}>
          {prompt}
        </ThemedText>
      )}
    </GlassPill>
  );
}

export type NoticeAction = { label: string; onPress: () => void; testID?: string };

/**
 * A notice under the banner, on the same glass: the microphone offer, the captions model's
 * question or its blocked download. Recording carries on around it. Its state change is read out
 * (a live region), with no animation.
 */
export function RecorderNotice({
  title,
  message,
  actions = [],
  testID,
}: {
  title?: string;
  message: string;
  actions?: NoticeAction[];
  testID?: string;
}) {
  return (
    <GlassPill style={styles.notice} testID={testID}>
      <View accessible accessibilityLiveRegion="polite" accessibilityRole="text">
        {title && (
          <ThemedText
            type="subheadlineEmphasized"
            style={styles.text}
            maxFontSizeMultiplier={MAX_SCALE}>
            {title}
          </ThemedText>
        )}
        <ThemedText
          type="footnote"
          style={[styles.text, title ? styles.prompt : null]}
          maxFontSizeMultiplier={MAX_SCALE}>
          {message}
        </ThemedText>
      </View>
      {actions.length > 0 && (
        <View style={styles.actions}>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              onPress={action.onPress}
              accessibilityRole="button"
              testID={action.testID}
              hitSlop={8}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <ThemedText
                type="subheadlineEmphasized"
                style={styles.actionLabel}
                maxFontSizeMultiplier={MAX_SCALE}>
                {action.label}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      )}
    </GlassPill>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    maxWidth: '100%',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 16,
  },
  notice: {
    alignSelf: 'stretch',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 16,
    gap: Spacing.one,
  },
  // White over the live camera whatever the theme, like the timer.
  text: { color: '#fff', textAlign: 'center' },
  prompt: { color: 'rgba(255,255,255,0.85)', marginTop: Spacing.half },
  actions: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: Spacing.two },
  action: { minHeight: 36, justifyContent: 'center', paddingHorizontal: Spacing.two },
  actionLabel: { color: '#fff', textDecorationLine: 'underline' },
  pressed: { opacity: Opacity.pressed },
});
