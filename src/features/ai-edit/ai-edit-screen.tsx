import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AI_EDIT_PROMPT_PRESETS,
  DEFAULT_AI_EDIT_PROMPT,
  MAX_AI_EDIT_PROMPT_LENGTH,
  validateAiEditPrompt,
} from '../../../modules/expo-ai-editor/src/prompt';
import { Icon } from '@/components/icon';
import { useScreenFocused } from '@/core/navigation/focus';
import { useToast } from '@/features/toast/toast-provider';
import { useTheme } from '@/hooks/use-theme';
import { userMessage } from '@/utils/user-message';

import { isAiEditingEnabled } from './enabled';
import { loadAiEditPrompt, saveAiEditPrompt } from './preferences';
import { initialPromptEditorState, presetForPrompt, promptEditorReducer } from './prompt-editor';
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
  const [editor, dispatch] = useReducer(promptEditorReducer, undefined, initialPromptEditorState);
  const [progress, setProgress] = useState('Preparing your cut…');
  const [error, setError] = useState<{ message: string; models: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const enabled = isAiEditingEnabled();
  const preset = presetForPrompt(editor.text);

  const start = useCallback(async () => {
    if (active.current || editor.loading || !isAiEditingEnabled()) return;
    Keyboard.dismiss();
    let editingPrompt: string;
    try {
      editingPrompt = validateAiEditPrompt(editor.text);
    } catch (cause) {
      const message = userMessage(
        cause,
        'Enter editing instructions before creating your cut.',
        'AI edit',
      );
      setError({ message, models: false });
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    setProgress('Preparing your cut…');
    try {
      // Freeze this job's text before any async work. Later renders and preference loads cannot
      // change the instructions used by the running selection or its subsequent batches.
      await saveAiEditPrompt(editingPrompt);
      if (controller.signal.aborted) throw new Error('AI edit cancelled.');
      const result = await runAiEdit(
        draftId,
        (message) => {
          if (!controller.signal.aborted && mounted.current) setProgress(message);
        },
        controller.signal,
        { editingPrompt },
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
  }, [draftId, editor.loading, editor.text, onResult, showToast]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!isAiEditingEnabled()) {
      dispatch({ type: 'load-failed' });
      return;
    }
    void loadAiEditPrompt()
      .then((prompt) => {
        if (!cancelled && mounted.current) dispatch({ type: 'loaded', prompt });
      })
      .catch(() => {
        if (!cancelled && mounted.current) {
          dispatch({ type: 'load-failed' });
          setError({
            message: 'Couldn’t load saved instructions. Choose a style or enter instructions.',
            models: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!focused) active.current?.abort();
  }, [focused]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') active.current?.abort();
    });
    return () => subscription.remove();
  }, []);

  const editPrompt = (prompt: string) => {
    if (active.current) return;
    dispatch({ type: 'edit', prompt });
    setError(null);
  };
  const close = () => {
    active.current?.abort();
    Keyboard.dismiss();
    onClose();
  };

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
        <Pressable
          onPress={Keyboard.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
          testID="ai-edit.dismiss-keyboard"
          style={styles.inlineButton}>
          <Text style={[styles.buttonText, { color: theme.text }]}>Done</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 20) }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <View style={styles.titleRow}>
            <Icon name="sparkles" size={30} tintColor={theme.text} />
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
              AI edit
            </Text>
          </View>
          <Text style={[styles.detail, { color: theme.textSecondary }]}>
            Create an editable cut under two minutes using your original voice and video. Your
            source project stays unchanged.
          </Text>
          {!enabled ? (
            <Text testID="ai-edit.status" style={[styles.status, { color: theme.text }]}>
              AI editing is available in developer builds.
            </Text>
          ) : busy ? (
            <View style={styles.working}>
              <ActivityIndicator size="large" color={theme.text} />
              <Text
                accessibilityLiveRegion="polite"
                testID="ai-edit.status"
                style={[styles.status, { color: theme.text }]}>
                {progress}
              </Text>
              <Text style={[styles.detail, { color: theme.textSecondary }]}>
                {preset?.label ?? 'Custom'} instructions
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.section}>
                <Text accessibilityRole="header" style={[styles.label, { color: theme.text }]}>
                  Editing style
                </Text>
                <View style={styles.presets}>
                  {AI_EDIT_PROMPT_PRESETS.map((option) => {
                    const selected = preset?.id === option.id;
                    return (
                      <Pressable
                        key={option.id}
                        onPress={() => editPrompt(option.prompt)}
                        accessibilityRole="button"
                        accessibilityLabel={`${option.label} editing style`}
                        accessibilityState={{ selected }}
                        testID={`ai-edit.preset.${option.id}`}
                        style={[
                          styles.preset,
                          { backgroundColor: selected ? theme.text : theme.backgroundElement },
                        ]}>
                        <Text
                          style={[
                            styles.presetText,
                            { color: selected ? theme.background : theme.text },
                          ]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.detail, { color: theme.textSecondary }]}>
                  {preset ? `${preset.label} instructions` : 'Custom instructions'}
                </Text>
              </View>
              <View style={styles.section}>
                <Text accessibilityRole="header" style={[styles.label, { color: theme.text }]}>
                  Editing instructions
                </Text>
                <TextInput
                  value={editor.text}
                  onChangeText={editPrompt}
                  multiline
                  textAlignVertical="top"
                  accessibilityLabel="Editing instructions"
                  accessibilityHint={`Describe what to keep in the cut. Maximum ${MAX_AI_EDIT_PROMPT_LENGTH} characters.`}
                  testID="ai-edit.prompt"
                  placeholder="Describe what to keep in the cut…"
                  placeholderTextColor={theme.textSecondary}
                  selectionColor={theme.text}
                  style={[
                    styles.prompt,
                    { color: theme.text, backgroundColor: theme.backgroundElement },
                  ]}
                />
                <Text
                  style={[
                    styles.characterCount,
                    {
                      color:
                        editor.text.trim().length > MAX_AI_EDIT_PROMPT_LENGTH
                          ? theme.destructive
                          : theme.textSecondary,
                    },
                  ]}>
                  {editor.text.trim().length.toLocaleString()} /{' '}
                  {MAX_AI_EDIT_PROMPT_LENGTH.toLocaleString()} characters
                </Text>
                <Pressable
                  onPress={() => editPrompt(DEFAULT_AI_EDIT_PROMPT)}
                  accessibilityRole="button"
                  accessibilityLabel="Reset editing instructions to default"
                  testID="ai-edit.reset"
                  style={styles.reset}>
                  <Text style={[styles.buttonText, { color: theme.text }]}>Reset to default</Text>
                </Pressable>
              </View>
              {error && (
                <View style={styles.section}>
                  <Text
                    accessibilityLiveRegion="polite"
                    testID="ai-edit.status"
                    style={[styles.status, { color: theme.text }]}>
                    {error.message}
                  </Text>
                  {error.models && (
                    <Pressable
                      onPress={onOpenModels}
                      accessibilityRole="button"
                      testID="ai-edit.models"
                      style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
                      <Text style={[styles.buttonText, { color: theme.text }]}>On-device AI</Text>
                    </Pressable>
                  )}
                </View>
              )}
              {editor.loading && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.detail, { color: theme.textSecondary }]}>
                  Loading saved instructions…
                </Text>
              )}
              <Pressable
                onPress={() => void start()}
                disabled={editor.loading}
                accessibilityRole="button"
                accessibilityState={{ disabled: editor.loading }}
                testID="ai-edit.create"
                style={[
                  styles.button,
                  { backgroundColor: theme.text, opacity: editor.loading ? 0.5 : 1 },
                ]}>
                <Text style={[styles.buttonText, { color: theme.background }]}>Create AI cut</Text>
              </Pressable>
            </>
          )}
          <Pressable onPress={close} accessibilityRole="button" style={styles.close}>
            <Text style={[styles.buttonText, { color: theme.textSecondary }]}>
              {busy ? 'Cancel' : 'Back to editor'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
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
  content: { flexGrow: 1, gap: 20, paddingHorizontal: 24, paddingTop: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flexShrink: 1, fontSize: 30, fontWeight: '700' },
  detail: { fontSize: 15, lineHeight: 22 },
  section: { gap: 10 },
  label: { flexShrink: 1, fontSize: 16, fontWeight: '600' },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: {
    maxWidth: '100%',
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  presetText: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  inlineButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  prompt: {
    minHeight: 220,
    maxHeight: 360,
    padding: 16,
    borderRadius: 16,
    fontSize: 16,
    lineHeight: 23,
  },
  characterCount: { fontSize: 13, textAlign: 'right' },
  reset: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  working: { flexGrow: 1, minHeight: 200, justifyContent: 'center', alignItems: 'center', gap: 20 },
  status: { fontSize: 16, lineHeight: 23 },
  button: {
    minHeight: 52,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
});
