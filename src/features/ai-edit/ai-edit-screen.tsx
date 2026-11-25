import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { useScreenFocused } from '@/core/navigation/focus';
import { useToast } from '@/features/toast/toast-provider';
import { useTheme } from '@/hooks/use-theme';
import { userMessage } from '@/utils/user-message';

import { isAiEditingEnabled } from './enabled';
import { AiEditSetupError, runAiEdit } from './run-ai-edit';

type Props = {
  draftId: string;
  onClose: () => void;
  onResult: (draftId: string) => void;
  onOpenModels: () => void;
};

export function AiEditScreen({ draftId, onClose, onResult, onOpenModels }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useScreenFocused();
  const { showToast } = useToast();
  const [progress, setProgress] = useState('Preparing your cut…');
  const [error, setError] = useState<{ message: string; models: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const began = useRef(false);
  const start = useCallback(async () => {
    if (active.current || !isAiEditingEnabled()) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await runAiEdit(
        draftId,
        (message) => {
          if (!controller.signal.aborted && mounted.current) setProgress(message);
        },
        controller.signal,
      );
      if (!controller.signal.aborted && mounted.current) {
        showToast({
          kind: 'success',
          title: 'Your AI cut is ready',
          message: `${result.clipCount} cuts · ${Math.ceil(result.durationMs / 1000)} seconds. Review before sharing.`,
        });
        onResult(result.draftId);
      }
    } catch (cause) {
      if (!mounted.current) return;
      const message = controller.signal.aborted
        ? 'AI editing stopped. Keep Pulse open and try again.'
        : userMessage(cause, 'Couldn’t create the AI cut. Please try again.', 'AI edit');
      setError({ message, models: cause instanceof AiEditSetupError && cause.openModels });
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }, [draftId, onResult, showToast]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (focused && !began.current) {
      began.current = true;
      void start();
    }
    if (!focused) active.current?.abort();
  }, [focused, start]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') active.current?.abort();
    });
    return () => subscription.remove();
  }, []);

  const close = () => {
    active.current?.abort();
    onClose();
  };
  const enabled = isAiEditingEnabled();
  return (
    <View style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close AI editing"
          testID="ai-edit.close"
          style={styles.close}>
          <Icon name="xmark" size={20} tintColor={theme.text} />
        </Pressable>
        <Text style={[styles.developer, { color: theme.textSecondary }]}>Developer preview</Text>
      </View>
      <View style={styles.content}>
        <Icon name="sparkles" size={40} tintColor={theme.text} />
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
          AI edit
        </Text>
        <Text style={[styles.detail, { color: theme.textSecondary }]}>
          A cut under two minutes, using your original voice and video. Your source project stays
          unchanged.
        </Text>
        {busy && <ActivityIndicator size="large" color={theme.text} />}
        <Text
          accessibilityLiveRegion="polite"
          testID="ai-edit.status"
          style={[styles.status, { color: theme.text }]}>
          {!enabled ? 'AI editing is available in developer builds.' : (error?.message ?? progress)}
        </Text>
        {error && enabled && (
          <>
            {error.models && (
              <Pressable
                onPress={onOpenModels}
                accessibilityRole="button"
                testID="ai-edit.models"
                style={[styles.button, { backgroundColor: theme.text }]}>
                <Text style={[styles.buttonText, { color: theme.background }]}>On-device AI</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => void start()}
              accessibilityRole="button"
              accessibilityLabel="Try AI edit again"
              testID="ai-edit.retry"
              style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
              <Text style={[styles.buttonText, { color: theme.text }]}>Try again</Text>
            </Pressable>
          </>
        )}
        <Pressable onPress={close} accessibilityRole="button" style={styles.close}>
          <Text style={[styles.buttonText, { color: theme.textSecondary }]}>
            {busy ? 'Cancel' : 'Back to editor'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  close: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  developer: { fontSize: 13 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20, padding: 28 },
  title: { fontSize: 30, fontWeight: '700' },
  detail: { fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 360 },
  status: { fontSize: 16, lineHeight: 23, textAlign: 'center' },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 24,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
