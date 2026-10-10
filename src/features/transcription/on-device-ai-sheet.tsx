import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DestructiveAction } from '@/components/destructive-action';
import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { SectionHeader } from '@/components/section-header';
import { SheetBody } from '@/components/sheet-body';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { selectedModelQuery, setSelectedModel } from '@/db/settings';
import { useToast } from '@/features/toast/toast-provider';
import { useTheme } from '@/hooks/use-theme';
import { userMessage } from '@/utils/user-message';
import { haptics } from '@/utils/haptics';
import { tallSheetFits } from '@/utils/sheet-fit';

import { currentDeviceProfile } from './device-profile';
import { applyModelSelection, isModelReady } from './model-manager';
import { getModel, LARGE_MODEL_BYTES, modelCaveat, MODELS, type WhisperModel } from './models';
import { useTranscriptionStatus } from './transcription-status';

const sizeMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Matches the active ring, so selecting a row doesn't shift the list. */
const RING_WIDTH = 1.5;

function statusLine(status: ReturnType<typeof useTranscriptionStatus>): string | null {
  switch (status.kind) {
    case 'deleting':
      return 'Removing previous model…';
    case 'downloading': {
      // Floored, so it never reads 100% while the download is still running.
      const pct =
        status.totalBytes > 0 ? Math.floor((status.bytesWritten / status.totalBytes) * 100) : 0;
      return `Downloading model… ${pct}%`;
    }
    case 'transcribing':
      return 'Generating captions…';
    default:
      return null;
  }
}

/**
 * The on-device AI sheet, opened from the export screen's captions button and the captions
 * editor. Today it holds a single section — Captions — but it's structured so future on-device
 * features can slot in as additional sections. Selecting a model persists the choice and frees the
 * previous model's weights/contexts (`applyModelSelection`); the new model is downloaded lazily the
 * next time a draft is exported, not here — so selecting records intent without blocking on a
 * download. A large model not on disk yet asks first, in the sheet itself. The active model can be
 * removed here to free disk. Same sheet style as the pairing and destinations sheets.
 */
export function OnDeviceAiSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { data } = useLiveQuery(selectedModelQuery, []);
  const selectedId = data[0]?.value ?? null;
  const status = useTranscriptionStatus();
  const busy = statusLine(status);
  const { showToast } = useToast();
  const close = () => router.back();
  // Decided when the sheet opens, as its route options are (`tallSheetOptions`).
  const [scrolls] = useState(() => !tallSheetFits());
  // A large model not on disk yet: the sheet asks first, in place of the list. Choosing it doesn't
  // download it here; captions download it when they next run (`useMergedTranscription`).
  const [confirming, setConfirming] = useState<WhisperModel | null>(null);
  // A switch or removal under way. Each ends by closing the sheet, so a second tap while the first
  // is still saving would start another change and close twice, popping the screen underneath
  // too. Cleared only when a change fails and the sheet stays open.
  const changing = useRef(false);
  // A change can finish after the sheet was swiped away or closed: its close would then pop the
  // screen underneath, so it closes only while the sheet is still up.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const closeIfOpen = () => {
    if (mounted.current) close();
  };

  // Only ever a different model (`choose` closes on the selected one): the selection changed.
  const select = async (id: string) => {
    if (changing.current) return;
    changing.current = true;
    haptics.tap();
    // The choice is saved first: if it can't be, the previous model stays selected and on disk,
    // and the sheet stays open saying so.
    try {
      await setSelectedModel(id);
    } catch (e) {
      changing.current = false;
      showToast({
        kind: 'error',
        title: 'Couldn’t switch the model',
        message: userMessage(e, 'Try again.', 'select model'),
      });
      return;
    }
    // Free the previous model's contexts + delete other weights now; the new model itself is
    // downloaded lazily at export time (no background loop pulls it here anymore).
    void applyModelSelection(getModel(id));
    closeIfOpen();
  };

  const choose = (id: string) => {
    // Its close is already coming (see `changing`).
    if (changing.current) return;
    if (id === selectedId) {
      close();
      return;
    }
    // Warn before kicking off a large download that isn't already on disk (cellular/data cost).
    const model = getModel(id);
    if (model && model.approxBytes >= LARGE_MODEL_BYTES && !isModelReady(model)) {
      setConfirming(model);
      return;
    }
    void select(id);
  };

  const containerStyle = [styles.container, { paddingBottom: insets.bottom + Spacing.four }];

  // The sheet's close control, floating at the top right in both states (list and confirmation).
  const closeButton = (
    <Pressable
      onPress={close}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Close"
      style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
      <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
    </Pressable>
  );

  // The selection is cleared first, so captions stop using the model; if it can't be, nothing
  // changed, the sheet stays open and the toast says so. Then its weights go from disk, and only
  // once they're gone does the sheet close. If they can't be freed, the model is selected again,
  // so Remove is still there to try once more.
  const removeModel = async (id: string) => {
    if (changing.current) return;
    changing.current = true;
    try {
      await setSelectedModel(null);
    } catch (e) {
      changing.current = false;
      showToast({
        kind: 'error',
        title: 'Couldn’t remove the model',
        message: userMessage(e, 'Try again.', 'remove model'),
      });
      return;
    }
    try {
      await applyModelSelection(null);
    } catch (e) {
      await setSelectedModel(id).catch(() => {});
      changing.current = false;
      showToast({
        kind: 'error',
        title: 'Couldn’t free the model’s space',
        message: userMessage(e, 'Try removing it again.', 'free model'),
      });
      return;
    }
    closeIfOpen();
  };

  if (confirming) {
    return (
      // Scrolls like the list when it wouldn't fit (large text), so the buttons stay reachable.
      <View collapsable={false} style={scrolls ? styles.fill : undefined}>
        <SheetBody scrolls={scrolls} style={containerStyle}>
          <View style={styles.headerText}>
            <ThemedText type="title2">Use {confirming.label}?</ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              It’s about {sizeMb(confirming.approxBytes)}, downloaded when Pulse next makes
              captions. Use Wi-Fi to avoid cellular data charges.
            </ThemedText>
          </View>
          {/* The app's paired actions: side by side in one row, the choice on the right. */}
          <View style={styles.actions}>
            <PrimaryButton
              variant="card"
              label="Cancel"
              onPress={() => setConfirming(null)}
              style={styles.action}
            />
            <PrimaryButton
              label={`Use ${confirming.label}`}
              onPress={() => void select(confirming.id)}
              style={styles.action}
            />
          </View>
        </SheetBody>
        {closeButton}
      </View>
    );
  }

  return (
    // Sized to its content, or full height and scrolling where that would be clipped (large text,
    // short screens: `tallSheetFits`). The close button floats at the top right either way.
    <View collapsable={false} style={scrolls ? styles.fill : undefined}>
      <SheetBody scrolls={scrolls} style={containerStyle}>
        <View style={styles.headerText}>
          <ThemedText type="title2">On-device AI</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Runs entirely on your phone. Nothing leaves it.
          </ThemedText>
        </View>

        {/* A card like the rows below it, so it reads as part of the sheet, not a hole in it. */}
        {busy && (
          <View style={[styles.status, { backgroundColor: theme.card }]}>
            <ActivityIndicator size="small" color={theme.accent} />
            <ThemedText type="footnote" themeColor="textSecondary">
              {busy}
            </ThemedText>
          </View>
        )}

        {/* First (and currently only) feature. Future on-device features slot in as new sections,
            each under the app's section header (as on About), with its note under the list like a
            grouped list's footer. */}
        <View style={styles.section}>
          <SectionHeader title="Captions" />

          {/* A plain list, not a ScrollView: iOS takes over a form sheet's first scroll view, which
            breaks its layout under `fitToContents`. The catalog is a handful of models. */}
          <View style={styles.list}>
            {MODELS.map((model) => {
              const active = model.id === selectedId;
              // Device-aware caveat (RAM floor / Android CPU-only inference) appended to the
              // model's base note — computed here, not in the catalog, so models.ts stays pure.
              const caveat = modelCaveat(model, currentDeviceProfile());
              return (
                <Pressable
                  key={model.id}
                  onPress={() => choose(model.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: pressed ? theme.backgroundSelected : theme.card,
                      borderColor: active ? theme.accent : 'transparent',
                    },
                  ]}>
                  <View style={styles.rowText}>
                    <View style={styles.rowTitle}>
                      <ThemedText type="headline">{model.label}</ThemedText>
                      <ThemedText type="footnote" themeColor="textSecondary">
                        {model.name}
                      </ThemedText>
                    </View>
                    <ThemedText type="footnote" themeColor="textSecondary">
                      {model.note}
                      {caveat ? ` · ${caveat}` : ''} · {sizeMb(model.approxBytes)}
                    </ThemedText>
                  </View>
                  {active && (
                    <Icon name="checkmark.circle.fill" size={24} tintColor={theme.accent} />
                  )}
                </Pressable>
              );
            })}
          </View>

          <ThemedText type="footnote" themeColor="textSecondary" style={styles.sectionNote}>
            Transcribed when you export. Only the selected model stays on disk.
          </ThemedText>
        </View>

        {/* The app's destructive text action, centred below the list. */}
        {selectedId && (
          <DestructiveAction
            label="Remove model & free up space"
            onPress={() => void removeModel(selectedId)}
          />
        )}
      </SheetBody>
      {closeButton}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.three,
    paddingTop: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  fill: { flex: 1 },
  // Room on the right for the floating close button.
  headerText: { gap: Spacing.one, paddingRight: Spacing.five },
  close: { position: 'absolute', top: Spacing.five, right: Spacing.four },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    ...CardShadow,
  },
  // Header, list and note spaced as About's sections are.
  section: { gap: Spacing.two },
  // Inset to the rows' content, as the section header is.
  sectionNote: { paddingHorizontal: Spacing.three },
  list: { gap: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three - RING_WIDTH,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    borderWidth: RING_WIDTH,
    ...CardShadow,
  },
  rowText: { flex: 1, gap: Spacing.half },
  rowTitle: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.two, flexWrap: 'wrap' },
  // A 20 pt line padded to 36 pt; with the hit slop, a 52 pt target. Only as wide as its label.
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.two },
  action: { flex: 1 },
  // The close and remove buttons are bare glyphs and text.
  pressed: { opacity: Opacity.pressedGlyph },
});
