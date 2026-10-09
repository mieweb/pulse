import { Image } from 'expo-image';
import { Icon } from '@/components/icon';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { ThemedText } from '@/components/themed-text';
import { CardShadow, Spacing } from '@/constants/theme';
import { shareUploadLink, watchUpload } from '@/features/upload/link-actions';
import type { WatchLink } from '@/features/upload/upload-manager';
import { useDraftUploadState, useWatchLink } from '@/features/upload/use-uploads';
import { uploadPhaseLabel } from '@/features/upload/phase-label';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { useThumbnail } from '@/hooks/use-thumbnail';
import { formatClipCount, formatDuration } from '@/utils/format';
import { formatRelativeDate } from '@/utils/relative-date';

const NAME_MAX_LENGTH = 40;

type Props = {
  id: string;
  /** Persisted upload status, so the card can show its own upload state on the cover. */
  uploadStatus?: 'uploading' | 'uploaded' | null;
  name: string | null;
  /** Relative path of the draft's first clip; the cover frame's legacy runtime fallback. */
  firstSegmentFilename?: string | null;
  /** Relative path of the first clip's persisted jpeg thumbnail (preferred cover frame). */
  firstSegmentThumbnail?: string | null;
  segmentCount: number;
  durationMs: number;
  lastModified: number;
  /** Wall-clock time the date label is relative to (the home screen's `useNow`). */
  now: number;
  /** Swaps the name for an inline text input; entered via long press or the ⋯ menu. */
  editing?: boolean;
  /** Multi-select mode: the ⋯ menu is replaced by a checkbox and onPress toggles selection. */
  selectionMode?: boolean;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /**
   * The ⋯ menu (draft-menu.tsx), shown after the link pill, given the draft's watch link: the card
   * looks it up once (uploaded drafts only) for both the pill and the menu.
   */
  menu?: (watchLink: WatchLink | null) => ReactNode;
  /** Fires once when editing ends (keyboard done or blur) with the trimmed name. */
  onSubmitName?: (name: string) => void;
};

export function DraftCard({
  id,
  uploadStatus,
  name,
  firstSegmentFilename,
  firstSegmentThumbnail,
  segmentCount,
  durationMs,
  lastModified,
  now,
  editing = false,
  selectionMode = false,
  selected = false,
  onPress,
  onLongPress,
  menu,
  onSubmitName,
}: Props) {
  const theme = useTheme();
  // The app's resolved mode (manual Light/Dark override, else OS) — not the OS scheme, which
  // gave a light card a white shadow when Light was pinned on a dark-mode phone.
  const isDark = useThemeMode() === 'dark';
  const thumbnail = useThumbnail(firstSegmentThumbnail, firstSegmentFilename);

  // An upload in progress is a ring on the cover — from the live state, or the persisted status
  // until the launch check settles a draft a killed app left `uploading`. A finished one gets a
  // one-tap link button beside ⋯ (see `LinkPill`). A failure is a toast, not a badge.
  const live = useDraftUploadState(id);
  const uploading = live.status === 'uploading' || uploadStatus === 'uploading';
  const uploadProgress = live.status === 'uploading' ? live.progress : 0;
  const uploaded = uploadStatus === 'uploaded' && !uploading;

  return (
    <Pressable
      onPress={editing ? undefined : onPress}
      onLongPress={selectionMode ? undefined : onLongPress}
      style={({ pressed }) => [
        styles.card,
        {
          // Rows highlight by fill swap (action-menu rows, home header buttons), not by dimming.
          backgroundColor: pressed && !editing ? theme.backgroundSelected : theme.card,
        },
      ]}>
      <View
        style={[
          styles.thumb,
          {
            backgroundColor: theme.backgroundSelected,
            borderColor: theme.border,
            // Opposite-tone shadow so it reads in both modes: black in light, white in dark.
            shadowColor: isDark ? '#fff' : '#000',
          },
        ]}>
        {thumbnail ? (
          <Image source={thumbnail} style={styles.thumbImage} contentFit="cover" />
        ) : (
          <Icon name="video.fill" size={18} tintColor={theme.textSecondary} />
        )}
        {uploading && (
          <View
            style={styles.uploadScrim}
            pointerEvents="none"
            accessible
            // The ring alone can't say WHAT is uploading; announce the phase so a
            // backgrounded/resumed run is as legible here as on the export screen.
            accessibilityLabel={live.status === 'uploading' ? uploadPhaseLabel(live) : 'Uploading'}>
            <UploadRing progress={uploadProgress} />
          </View>
        )}
      </View>

      <View style={styles.body}>
        {editing ? (
          <TextInput
            defaultValue={name ?? ''}
            placeholder="Name this draft"
            placeholderTextColor={theme.textSecondary}
            autoFocus
            selectTextOnFocus
            maxLength={NAME_MAX_LENGTH}
            returnKeyType="done"
            onEndEditing={(e) => onSubmitName?.(e.nativeEvent.text.trim())}
            style={[styles.name, styles.nameInput, { color: theme.text }]}
          />
        ) : (
          <ThemedText style={styles.name} numberOfLines={1}>
            {name || 'Untitled'}
          </ThemedText>
        )}
        <ThemedText themeColor="textSecondary" type="small" numberOfLines={1}>
          {formatClipCount(segmentCount)} · {formatDuration(durationMs)} ·{' '}
          {formatRelativeDate(lastModified, now)}
        </ThemedText>
      </View>

      {selectionMode ? (
        <View
          style={styles.more}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected }}>
          <Icon
            name={selected ? 'checkmark.circle.fill' : 'circle'}
            size={22}
            tintColor={selected ? theme.accent : theme.textSecondary}
          />
        </View>
      ) : (
        !editing && (
          <View style={styles.trailing}>
            {uploaded ? <UploadedTrailing draftId={id} name={name} menu={menu} /> : menu?.(null)}
          </View>
        )
      )}
    </Pressable>
  );
}

/**
 * An uploaded draft's one-tap link button beside ⋯, while its link still opens: Share (the share
 * sheet) for a link that's safe to share, or Watch for one carrying the upload token. Nothing
 * otherwise — not a button that could only say it can't. Its own component so only uploaded
 * drafts run the link's expiry check.
 */
/**
 * An uploaded draft's trailing controls: the one subscription to its watch link (it carries a
 * clock for the link's expiry), shared by the link pill and the ⋯ menu.
 */
function UploadedTrailing({
  draftId,
  name,
  menu,
}: {
  draftId: string;
  name: string | null;
  menu: Props['menu'];
}) {
  const link = useWatchLink(draftId);
  return (
    <>
      {link && <LinkPill link={link} name={name} />}
      {menu?.(link)}
    </>
  );
}

function LinkPill({ link, name }: { link: WatchLink; name: string | null }) {
  const theme = useTheme();
  const { url, shareable } = link;
  return (
    <Pressable
      onPress={() =>
        void (shareable
          ? shareUploadLink(url, name ?? undefined).catch(() => {})
          : watchUpload(url))
      }
      // Only a sliver toward ⋯, so the two tap targets don't overlap.
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={shareable ? 'Share link' : 'Watch'}
      style={({ pressed }) => [
        styles.share,
        { backgroundColor: pressed ? theme.backgroundSelected : theme.cardRaised },
      ]}>
      <Icon
        name={shareable ? 'square.and.arrow.up' : 'play.fill'}
        size={14}
        tintColor={theme.text}
      />
      <ThemedText type="small">{shareable ? 'Share' : 'Watch'}</ThemedText>
    </Pressable>
  );
}

const RING = 28;
const RING_STROKE = 3;
const RING_R = (RING - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/** A small determinate ring shown over a draft's cover while it uploads (white on a dark scrim). */
function UploadRing({ progress }: { progress: number }) {
  const clamped = Math.max(0.03, Math.min(1, progress));
  return (
    <Svg width={RING} height={RING}>
      <Circle
        cx={RING / 2}
        cy={RING / 2}
        r={RING_R}
        stroke="rgba(255,255,255,0.3)"
        strokeWidth={RING_STROKE}
        fill="none"
      />
      <Circle
        cx={RING / 2}
        cy={RING / 2}
        r={RING_R}
        stroke="#fff"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - clamped)}
        transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  uploadScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.two,
    paddingRight: Spacing.three,
    borderRadius: Spacing.three,
    ...CardShadow,
  },
  thumb: {
    width: 44,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    // Lift the cover off the card so it pops a little. A hairline ring carries the separation
    // in dark mode (where a black shadow is invisible against the dark card); the shadow does
    // the lifting in light mode.
    borderWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontWeight: '600',
  },
  nameInput: {
    // Match the name Text (body: 17/22) exactly so swapping in the input never changes the
    // text size or the body height (which would nudge the subtitle).
    fontSize: 17,
    height: 22,
    padding: 0,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  share: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    height: 28,
    paddingHorizontal: Spacing.two + Spacing.half,
    borderRadius: 14,
    ...CardShadow,
  },
  // The trailing slot's size: the selection checkbox, and the ⋯ menu beside it (draft-menu.tsx).
  more: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
