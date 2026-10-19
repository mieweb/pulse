import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import type { CaptionStyle } from './caption-style';
import { captionRows } from './caption-track';
import { lineAt } from './compose';
import { wordGap } from './group-lines';
import type { TranscriptLine } from './whisper';

/** The word to highlight in `line` at `posCs`: the one under the playhead, else the last one
 * already started (so the highlight rests on the most recent word during short gaps). */
export function activeWord(line: TranscriptLine, posCs: number): number {
  const words = line.words ?? [];
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (posCs >= words[i].t0) active = i;
    if (posCs >= words[i].t0 && posCs <= words[i].t1) break;
  }
  return active;
}

/**
 * One caption as the style draws it on a picture `height` dp tall: its rows (caption-track.ts,
 * never re-wrapped; a row too wide for the picture shrinks to fit), words already spoken in
 * `color`, the current one in `activeColor`, the rest in `futureColor`, on the style's box. The
 * text doesn't follow the phone's text size: it's sized to the picture, as the video will show it.
 */
export function CaptionText({
  line,
  active,
  style,
  height,
}: {
  line: TranscriptLine;
  /** The word to highlight (`activeWord`). */
  active: number;
  style: CaptionStyle;
  height: number;
}) {
  const size = style.size * height;
  const text = {
    fontSize: size,
    lineHeight: size * style.lineHeight,
    fontWeight: `${style.weight}` as const,
  };
  let index = 0;
  return (
    <View
      style={{
        backgroundColor: style.background,
        borderRadius: style.radius * size,
        paddingHorizontal: style.padX * size,
        paddingVertical: style.padY * size,
      }}>
      {captionRows(line).map((row, r) => (
        <Text
          key={r}
          numberOfLines={1}
          adjustsFontSizeToFit
          allowFontScaling={false}
          style={[styles.text, text]}>
          {row.map((w, i) => {
            const at = index++;
            const color =
              at === active ? style.activeColor : at < active ? style.color : style.futureColor;
            return (
              <Text key={i} style={{ color }}>
                {(i > 0 ? wordGap(row[i - 1].text, w.text) : '') + w.text}
              </Text>
            );
          })}
        </Text>
      ))}
    </View>
  );
}

/**
 * A row across the picture whose middle is at the style's `y`: what's laid in it is centred on
 * that line, whatever its height. Twice the picture's height, so the text always has room to lay
 * out (a zero-height row measures text into no lines at all). Absolute; style it over the picture.
 */
export function captionRowStyle(style: CaptionStyle, height: number): ViewStyle {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (style.y - 1) * height,
    height: height * 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: style.margin * style.size * height,
  };
}

type Props = {
  /** Effective caption lines (centiseconds), sorted by start. */
  lines: readonly TranscriptLine[];
  /** Current playback position in milliseconds, in the same time base as `lines`. */
  positionMs: number;
  style: CaptionStyle;
  /** The picture's height, dp. */
  height: number;
};

/**
 * Word-level (karaoke) caption overlay over a player: the line under `positionMs`, drawn by the
 * style. Time sync is the caller's job (e.g. expo-video's `timeUpdate`).
 */
export function CaptionOverlay({ lines, positionMs, style, height }: Props) {
  const posCs = positionMs / 10;
  const i = lineAt(lines, posCs);
  const line = i >= 0 ? lines[i] : undefined;
  if (!line || height <= 0) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={captionRowStyle(style, height)}>
        <CaptionText
          key={i}
          line={line}
          active={activeWord(line, posCs)}
          style={style}
          height={height}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  text: { textAlign: 'center' },
});
