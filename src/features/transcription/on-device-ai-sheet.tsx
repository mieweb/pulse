import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { SheetBody } from '@/components/sheet-body';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Spacing } from '@/constants/theme';
import { selectedModelQuery, setSelectedModel } from '@/db/settings';
import { useTheme } from '@/hooks/use-theme';
import { tallSheetFits } from '@/utils/sheet-fit';

import { currentDeviceProfile } from './device-profile';
import { applyModelSelection, isModelReady } from './model-manager';
import { getModel, LARGE_MODEL_BYTES, modelCaveat, MODELS, type WhisperModel } from './models';
import { useTranscriptionStatus } from './transcription-status';

const sizeMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Matches the active ring, so selecting a row doesn't shift the list. */
const RING_WIDTH = 1.5;
const BUTTON_HEIGHT = 50;

function statusLine(status: ReturnType<typeof useTranscriptionStatus>): string | null {
  switch (status.kind) {
    case 'deleting':
      return 'Removing previous model…';
    case 'downloading': {
      const pct =
        status.totalBytes > 0 ? Math.round((status.bytesWritten / status.totalBytes) * 100) : 0;
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
  const close = () => router.back();
  // Decided when the sheet opens, as its route options are (`tallSheetOptions`).
  const [scrolls] = useState(() => !tallSheetFits());
  // A large model not on disk yet: the sheet asks before the download, in place of the list.
  const [confirming, setConfirming] = useState<WhisperModel | null>(null);

  const select = (id: string) => {
    void setSelectedModel(id);
    // Free the previous model's contexts + delete other weights now; the new model itself is
    // downloaded lazily at export time (no background loop pulls it here anymore).
    void applyModelSelection(getModel(id));
    close();
  };

  const choose = (id: string) => {
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
    select(id);
  };

  const containerStyle = [styles.container, { paddingBottom: insets.bottom + Spacing.four }];

  if (confirming) {
    return (
      <View collapsable={false} style={containerStyle}>
        <View style={styles.headerText}>
          <ThemedText type="title2">Download {confirming.label}?</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            About {sizeMb(confirming.approxBytes)}. Use Wi-Fi to avoid cellular data charges.
          </ThemedText>
        </View>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => select(confirming.id)}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText type="headline" style={styles.buttonLabel}>
              Download
            </ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            hitSlop={Spacing.two}
            onPress={() => setConfirming(null)}
            style={styles.cancel}>
            <ThemedText type="body" themeColor="textSecondary">
              Cancel
            </ThemedText>
          </Pressable>
        </View>
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

        {busy && (
          <View style={[styles.status, { backgroundColor: theme.backgroundElement }]}>
            <ActivityIndicator size="small" color={theme.accent} />
            <ThemedText type="footnote" themeColor="textSecondary">
              {busy}
            </ThemedText>
          </View>
        )}

        {/* First (and currently only) feature. Future on-device features slot in as new sections. */}
        <View style={styles.section}>
          <View style={styles.sectionTitle}>
            <ThemedText type="headline">Captions</ThemedText>
            <Icon
              name="captions.bubble.fill"
              size={18}
              tintColor={selectedId ? theme.accent : theme.textSecondary}
            />
          </View>
          <ThemedText type="footnote" themeColor="textSecondary">
            Transcribed when you export. Only the selected model stays on disk.
          </ThemedText>
        </View>

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
                {active && <Icon name="checkmark.circle.fill" size={24} tintColor={theme.accent} />}
              </Pressable>
            );
          })}
        </View>

        {selectedId && (
          <Pressable
            onPress={() => {
              void setSelectedModel(null);
              void applyModelSelection(null);
              close();
            }}
            hitSlop={8}
            accessibilityRole="button"
            style={({ pressed }) => [styles.remove, pressed && styles.pressed]}>
            <Icon name="trash" size={16} tintColor={theme.accent} />
            <ThemedText type="body" themeColor="accent" style={styles.removeText}>
              Remove model & free up space
            </ThemedText>
          </Pressable>
        )}
      </SheetBody>
      <Pressable
        onPress={close}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
      </Pressable>
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
    borderRadius: 18,
  },
  section: { gap: Spacing.half },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  list: { gap: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three - RING_WIDTH,
    borderRadius: 18,
    borderWidth: RING_WIDTH,
    ...CardShadow,
  },
  rowText: { flex: 1, gap: Spacing.half },
  rowTitle: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.two, flexWrap: 'wrap' },
  remove: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  removeText: { fontWeight: '600' },
  // The pairing sheet's centered button pair.
  actions: { alignItems: 'center', gap: Spacing.two, marginTop: Spacing.two },
  button: {
    alignSelf: 'stretch',
    height: BUTTON_HEIGHT,
    borderRadius: BUTTON_HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { color: '#ffffff' },
  cancel: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.four },
  pressed: { opacity: 0.6 },
});
