import { ActivityIndicator, I18nManager, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { lineAt, type CaptionLine } from '@/features/transcription/compose';
import type { DraftCaptions } from '@/features/transcription/use-draft-captions';
import { useTheme } from '@/hooks/use-theme';
import { formatClipCount } from '@/utils/format';
import { Icon } from '@/components/icon';

import { CaptionToolbar } from './clip-toolbar';
import { CommandButton } from './editor-controls';
import { usePlayheadCaption } from './use-playhead-caption';

/**
 * The captions tools. Split and Merge act at the playhead, so this follows where it is among the
 * captions (`usePlayheadCaption`): a new word under it re-renders only these tools, not the
 * editor.
 */
export function CaptionTools({
  lines,
  timeMs,
  onSplit,
  onMerge,
  ...rest
}: {
  lines: readonly CaptionLine[];
  timeMs: SharedValue<number>;
  hasWord: boolean;
  busy: boolean;
  edited: boolean;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** A new sentence from word `i` of the clip's words on. */
  onSplit: (clipId: string, i: number) => void;
  /** The sentence ending before word `to` of the clip's words joined with the next. */
  onMerge: (clipId: string, to: number) => void;
  onModel: () => void;
  onReset: () => void;
}) {
  const at = usePlayheadCaption(lines, timeMs, true);
  // Split: at the word boundary nearest the playhead inside the sentence under it (never inside a
  // word).
  const splitLine =
    at.line >= 0 && (lines[at.line].words?.length ?? 0) >= 2 ? lines[at.line] : null;
  const split = () => {
    // The sentence under the playhead now (the one shown can lag a moment while playing).
    const pos = timeMs.get() / 10;
    const now = lineAt(lines, pos);
    const line = now >= 0 ? lines[now] : null;
    const ws = line?.words ?? [];
    if (!line || ws.length < 2) return;
    let k = 1;
    for (let j = 2; j < ws.length; j++) {
      if (Math.abs(ws[j].t0 - pos) < Math.abs(ws[k].t0 - pos)) k = j;
    }
    onSplit(line.clipId, line.from + k);
  };
  // Merge: the sentence under the playhead and the next, or the two either side of the gap it's
  // in (in the same clip).
  const first = at.line >= 0 ? at.line : at.next > 0 ? at.next - 1 : -1;
  const mergeLine =
    first >= 0 && first + 1 < lines.length && lines[first].clipId === lines[first + 1].clipId
      ? lines[first]
      : null;
  return (
    <CaptionToolbar
      {...rest}
      canSplit={!!splitLine}
      canMerge={!!mergeLine}
      onSplit={split}
      onMerge={() => mergeLine && onMerge(mergeLine.clipId, mergeLine.to)}
    />
  );
}

/** A button path to each transcript word, including words painted in the timeline canvas. */
export function CaptionWordPicker({
  lines,
  picked,
  timeMs,
  busy,
  canCutSpeech,
  onPick,
  onCutSpeech,
}: {
  lines: readonly CaptionLine[];
  picked: { clipId: string; i: number } | null;
  timeMs: SharedValue<number>;
  busy: boolean;
  canCutSpeech: boolean;
  onPick: (line: number, word: number) => void;
  onCutSpeech: () => void;
}) {
  const theme = useTheme();
  const words = lines.flatMap((line, l) =>
    (line.words ?? []).map((word, w) => ({ ...word, clipId: line.clipId, i: line.from + w, l, w })),
  );
  const selected = words.findIndex((w) => w.clipId === picked?.clipId && w.i === picked.i);
  const select = (direction: -1 | 1) => {
    let index = selected + direction;
    if (selected < 0) {
      const after = words.findIndex((w) => w.t0 * 10 >= timeMs.get());
      index = direction === 1 ? (after < 0 ? 0 : after) : after <= 0 ? words.length - 1 : after - 1;
    }
    const word = words[index];
    if (word) onPick(word.l, word.w);
  };
  const label =
    selected < 0
      ? 'Choose a transcript word'
      : `Word ${selected + 1} of ${words.length}: ${words[selected].text}`;
  return (
    <View style={styles.wordPicker}>
      <CommandButton
        icon={I18nManager.isRTL ? 'chevron.right' : 'chevron.left'}
        label="Select previous word"
        disabled={busy || words.length === 0 || selected === 0}
        onPress={() => select(-1)}
        testID="editor.previousWord"
      />
      <View style={styles.wordActions}>
        <Text
          style={[styles.selectedWord, { color: theme.text }]}
          accessibilityLiveRegion="polite"
          testID="editor.selectedWord"
          numberOfLines={2}>
          {label}
        </Text>
        <Pressable
          onPress={onCutSpeech}
          disabled={busy || !canCutSpeech}
          accessibilityRole="button"
          accessibilityLabel="Cut selected word from video"
          accessibilityHint={
            canCutSpeech
              ? 'Removes its audio and video. Undo restores the word.'
              : 'Select a word with video before and after it.'
          }
          accessibilityState={{ disabled: busy || !canCutSpeech, busy }}
          testID="editor.cutSpeech"
          style={({ pressed }) => [
            styles.cutSpeech,
            { backgroundColor: theme.backgroundElement },
            (busy || !canCutSpeech || pressed) && styles.dim,
          ]}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <Icon name="scissors" size={16} tintColor={theme.text} />
          )}
          <Text style={[styles.cutLabel, { color: theme.text }]} maxFontSizeMultiplier={1.3}>
            Cut speech
          </Text>
        </Pressable>
      </View>
      <CommandButton
        icon={I18nManager.isRTL ? 'chevron.left' : 'chevron.right'}
        label="Select next word"
        disabled={busy || words.length === 0 || selected === words.length - 1}
        onPress={() => select(1)}
        testID="editor.nextWord"
      />
    </View>
  );
}

/**
 * What the captions are waiting on, over the top of the preview: the model's download (or its
 * error) always; while the captions tools are open, also clips being transcribed, ones that
 * failed, and a model to pick or download. Tappable when there's something to do.
 */
export function CaptionStatus({
  captions,
  open,
  onOpenModelSheet,
}: {
  captions: DraftCaptions;
  open: boolean;
  /** Opens the captions model sheet (no model picked yet). */
  onOpenModelSheet: () => void;
}) {
  const theme = useTheme();
  const st = captions.state;
  let text: string | null = null;
  let onPress: (() => void) | undefined;
  if (captions.downloadError) {
    text = 'Couldn’t download the captions model. Tap to try again.';
    onPress = captions.download;
  } else if (st.status === 'downloading') {
    text = `Downloading the captions model… ${Math.floor(st.progress * 100)}%`;
  } else if (!open) {
    text = null;
  } else if (st.status === 'no-model') {
    text = 'Tap to pick a captions model.';
    onPress = onOpenModelSheet;
  } else if (st.status === 'needs-download') {
    text = 'Tap to download the captions model.';
    onPress = captions.download;
  } else if (st.status === 'transcribing') {
    text = 'Making captions…';
  } else if (captions.failed.length) {
    text = `Couldn’t caption ${formatClipCount(captions.failed.length)}. Tap to try again.`;
    onPress = captions.retry;
  }
  if (!text) return null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      style={({ pressed }) => [
        styles.status,
        { backgroundColor: theme.backgroundElement },
        pressed && styles.dim,
      ]}>
      <Text style={[styles.statusText, { color: theme.text }]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wordPicker: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 4 },
  wordActions: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  selectedWord: { fontSize: 13, textAlign: 'center', paddingBottom: 4 },
  cutSpeech: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  cutLabel: { fontSize: 12, fontWeight: '600' },
  status: {
    position: 'absolute',
    top: 8,
    maxWidth: '86%',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  statusText: { fontSize: 13, fontWeight: '500', textAlign: 'center' },
  dim: { opacity: 0.35 },
});
