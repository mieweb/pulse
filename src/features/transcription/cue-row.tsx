import { memo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDuration } from '@/utils/format';
import { spaceBefore } from './group-lines';
import type { Cue } from './use-subtitle-editor';

const CPS_WARN = 17;
const CPS_BAD = 20;
const MAX_CHARS = 42;

export type CueLoad = 'ok' | 'warn' | 'bad';

/** Readability load of a cue: chars-per-second and line length, as a passive severity level. */
export function cueLoad(cue: Cue): CueLoad {
  const chars = cue.text.trim().length;
  const cps = chars / Math.max(0.01, (cue.t1 - cue.t0) / 100);
  if (cps > CPS_BAD || chars > MAX_CHARS) return 'bad';
  if (cps > CPS_WARN) return 'warn';
  return 'ok';
}

// Rows show a coarse clock (m:ss, h:mm:ss on long videos); the timing bar's labels show tenths.
// Floored, so a cue never reads a second later than it starts.
export const clock = (cs: number) => formatDuration(cs * 10, { floor: true });

export type CueRowState = 'view' | 'selected' | 'editing';

/**
 * One caption line in the list. `view` = tap to select (seeks the video); `selected` = accent
 * outline, tap again to edit the text in place; `editing` = the text is a live TextInput.
 * The playing row renders its text karaoke-style — spoken words solid, the word under the
 * playhead in accent, upcoming words dimmed (the same behavior CaptionOverlay draws on video).
 * The timestamp is tinted by readability load (never a "cps" number in the UI).
 *
 * Memoized: playback re-renders the editor 10×/s, so only the playing row gets a live `posCs`
 * (the caller passes 0 to the rest) and the callbacks take the cue, so the caller can pass the
 * same functions to every row and the others skip those renders.
 */
export const CueRow = memo(function CueRow({
  cue,
  state,
  playing,
  posCs,
  theme,
  onSelect,
  onBeginTextEdit,
  onChangeText,
  onEndTextEdit,
}: {
  cue: Cue;
  state: CueRowState;
  playing: boolean;
  /** Playhead position (centiseconds) — drives the word highlight of the playing row. Pass 0 to
   * rows that aren't playing, so they don't re-render on every tick. */
  posCs: number;
  theme: ReturnType<typeof useTheme>;
  onSelect: (cue: Cue) => void;
  onBeginTextEdit: (id: string) => void;
  onChangeText: (id: string, text: string) => void;
  onEndTextEdit: () => void;
}) {
  const chars = cue.text.trim().length;
  const load = cueLoad(cue);
  const active = state !== 'view';
  const tcColor =
    active || playing
      ? theme.accent
      : load === 'bad'
        ? theme.accent
        : load === 'warn'
          ? theme.warning
          : theme.textSecondary;

  return (
    <Pressable
      onPress={
        state === 'view'
          ? () => onSelect(cue)
          : state === 'selected'
            ? () => onBeginTextEdit(cue.id)
            : undefined
      }
      accessibilityRole="button"
      accessibilityLabel={state === 'view' ? 'Select caption' : 'Edit caption text'}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.row,
        {
          // Fill only at rest (no outline, no shadow: a long list of lifted rows reads busy); the
          // playing and selected rings below still use the border.
          backgroundColor: pressed ? theme.backgroundSelected : theme.card,
          borderColor: 'transparent',
        },
        playing && { borderColor: theme.accent },
        active && {
          borderColor: theme.accent,
          borderWidth: ACTIVE_RING,
          backgroundColor: theme.backgroundSelected,
        },
      ]}>
      <View style={[styles.inner, active && styles.innerActive]}>
        <ThemedText type="footnote" numberOfLines={1} style={[styles.tc, { color: tcColor }]}>
          {clock(cue.t0)}
        </ThemedText>
        {state === 'editing' ? (
          <TextInput
            value={cue.text}
            onChangeText={(text) => onChangeText(cue.id, text)}
            onBlur={onEndTextEdit}
            placeholder="Caption text"
            placeholderTextColor={theme.textSecondary}
            multiline
            autoFocus
            style={[styles.input, { color: theme.text }]}
          />
        ) : playing && chars > 0 && cue.words.length > 0 ? (
          <KaraokeText words={cue.words} posCs={posCs} theme={theme} />
        ) : (
          <ThemedText
            type="subheadline"
            numberOfLines={2}
            style={[styles.text, !chars && { color: theme.textSecondary }]}>
            {chars ? cue.text : 'Empty caption — tap to type'}
          </ThemedText>
        )}
      </View>
    </Pressable>
  );
});

/**
 * Word-level (karaoke) rendering of the playing cue's text. The active word is the one covering
 * the playhead, else the last one already started (so the highlight rests on the most recent
 * word during short gaps) — the same rule CaptionOverlay uses on video.
 */
function KaraokeText({
  words,
  posCs,
  theme,
}: {
  words: Cue['words'];
  posCs: number;
  theme: ReturnType<typeof useTheme>;
}) {
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (posCs >= words[i].t0) active = i;
    if (posCs >= words[i].t0 && posCs <= words[i].t1) break;
  }
  return (
    <ThemedText type="subheadline" numberOfLines={2} style={styles.text}>
      {words.map((w, i) => (
        <Text
          key={i}
          style={{
            color: i === active ? theme.accent : i < active ? theme.text : theme.textSecondary,
            fontWeight: i === active ? '600' : '400',
          }}>
          {(i > 0 && spaceBefore(words[i - 1].text, w.text) ? ' ' : '') + w.text}
        </Text>
      ))}
    </ThemedText>
  );
}

// The selected row's accent ring. The inner padding gives back its extra width (see
// innerActive), so selecting a row never changes its size and nudges the rows below.
const ACTIVE_RING = 1.5;
const RING_EXTRA = ACTIVE_RING - StyleSheet.hairlineWidth;

const styles = StyleSheet.create({
  row: {
    borderRadius: Radius.row,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.two,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.three,
  },
  innerActive: {
    paddingVertical: Spacing.two + 2 - RING_EXTRA,
    paddingHorizontal: Spacing.three - RING_EXTRA,
  },
  // A floor, not a fixed width: "1:02:03" or a large text size widens it rather than wrapping.
  tc: { fontVariant: ['tabular-nums'], minWidth: 38 },
  text: { flex: 1 },
  // The subheadline type's metrics (a TextInput can't take a ThemedText type).
  input: { flex: 1, fontSize: 15, lineHeight: 20, padding: 0, textAlignVertical: 'top' },
});
