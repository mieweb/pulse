import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { lineAt, type CaptionLine } from '@/features/transcription/compose';
import type { DraftCaptions } from '@/features/transcription/use-draft-captions';
import { useTheme } from '@/hooks/use-theme';
import { formatClipCount } from '@/utils/format';

import { CaptionToolbar } from './clip-toolbar';
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

/**
 * What the captions are waiting on, over the top of the preview: the model's download (or its
 * error) always; while the captions tools are open, also clips being transcribed, ones that
 * failed, and a model to pick or download. Tappable when there's something to do.
 */
export function CaptionStatus({ captions, open }: { captions: DraftCaptions; open: boolean }) {
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
    onPress = () => router.push('/on-device-ai');
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
