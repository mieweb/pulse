import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Image } from 'expo-image';
import { useRef, useState, type ReactElement } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import type { ClipAnchor } from '@/core/clip-anchor';
import { copyClipsInto, draftDisplayName, otherDraftsQuery, segmentsForDraft } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { useToast } from '@/features/toast/toast-provider';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { useThumbnail } from '@/hooks/use-thumbnail';
import { formatClipCount, formatCount, formatDuration } from '@/utils/format';
import { formatRelativeDate } from '@/utils/relative-date';
import { effMs } from '@/utils/segment-window';
import { userMessage } from '@/utils/user-message';

import { fromAnotherPulseAction } from './add-menu-actions';

type DraftRow = Awaited<ReturnType<typeof otherDraftsQuery>>[number];

const DATE_LABEL_REFRESH_MS = 60_000;
const COLUMNS = 3;
const GRID_GAP = Spacing.two;
// The clip labels' size stays put over the thumbnails, as on the recorder's clip strip.
const THUMB_TEXT_SCALE = 1.2;

/**
 * "From another Pulse" in the "+" menu (#308), for the editor and the recorder: the menu item
 * (none while no other draft has clips) and its sheet. Pick a draft, then some of its clips; they
 * are copied into this draft at the "+"'s place (`copyClipsInto`) with their edits and captions,
 * and the source is unchanged. The draft the clips go into is `draftId`, or the one `target` makes
 * (a recorder before its first take). `anchor` is read once, as the item is picked, and kept:
 * the copies land there whatever moves while the sheet is open, as the menu's other items do.
 *
 * The sheet is the screen's own (a React Native Modal: a page sheet on iOS, full screen on
 * Android), not a route, so the Pulse app and the embed present it the same way.
 */
export function useFromAnotherPulse({
  draftId,
  target,
  anchor,
  onOpen,
}: {
  draftId: string | null;
  target: () => Promise<string>;
  anchor: () => ClipAnchor;
  /** Before the sheet shows (the editor pauses its preview). */
  onOpen?: () => void;
}): { action: ReturnType<typeof fromAnotherPulseAction> | null; sheet: ReactElement | null } {
  const { data: others } = useLiveQuery(otherDraftsQuery(draftId), [draftId]);
  // Open: at the anchor taken as the item was picked.
  const [open, setOpen] = useState<{ anchor: ClipAnchor } | null>(null);
  const show = () => {
    onOpen?.();
    setOpen({ anchor: anchor() });
  };
  return {
    action: others.length > 0 ? fromAnotherPulseAction(show) : null,
    sheet: open ? (
      <FromAnotherPulseSheet
        drafts={others}
        target={target}
        anchor={open.anchor}
        onClose={() => setOpen(null)}
      />
    ) : null,
  };
}

function FromAnotherPulseSheet({
  drafts,
  target,
  anchor,
  onClose,
}: {
  drafts: DraftRow[];
  target: () => Promise<string>;
  anchor: ClipAnchor;
  onClose: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copying, setCopying] = useState<{ done: number; total: number } | null>(null);
  const running = useRef(false);
  const source = drafts.find((d) => d.id === sourceId) ?? null;
  const { data: clips } = useLiveQuery(segmentsForDraft(sourceId ?? ''), [sourceId]);
  // In the draft's order; a clip deleted meanwhile drops out of the selection.
  const chosen = clips.filter((c) => selected.has(c.id)).map((c) => c.id);

  const back = () => {
    if (copying) return;
    if (sourceId) {
      setSourceId(null);
      setSelected(new Set());
    } else onClose();
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allChosen = clips.length > 0 && chosen.length === clips.length;

  const add = async () => {
    if (!sourceId || chosen.length === 0 || running.current) return;
    running.current = true;
    setCopying({ done: 0, total: chosen.length });
    try {
      const into = await target();
      const { segmentIds, skipped } = await copyClipsInto(
        into,
        sourceId,
        chosen,
        anchor,
        (done, total) => setCopying({ done, total }),
      );
      onClose();
      if (segmentIds.length === 0) {
        showToast({
          kind: 'error',
          title: 'Couldn’t add the clips',
          message: 'Their videos are missing from that Pulse.',
        });
      } else if (skipped > 0) {
        showToast({
          kind: 'info',
          title: `Added ${formatClipCount(segmentIds.length)}`,
          message: `${formatCount(skipped, 'clip wasn’t', 'clips weren’t')} copied: the video is missing.`,
        });
      }
    } catch (e) {
      onClose();
      showToast({
        kind: 'error',
        title: 'Couldn’t add the clips',
        message: userMessage(e, 'Try again.', 'copy clips'),
      });
    } finally {
      running.current = false;
      setCopying(null);
    }
  };

  const android = Platform.OS === 'android';
  const header = (
    <View style={styles.header}>
      {source ? (
        <Pressable
          onPress={back}
          disabled={!!copying}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityHint="Shows your other Pulses."
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <Icon name="chevron.left" size={22} weight="semibold" tintColor={theme.accent} />
        </Pressable>
      ) : null}
      <ThemedText type="headline" numberOfLines={1} style={styles.title} accessibilityRole="header">
        {source ? draftDisplayName(source.name, null) : 'From another Pulse'}
      </ThemedText>
      {source && clips.length > 0 ? (
        <Pressable
          onPress={() => setSelected(allChosen ? new Set() : new Set(clips.map((c) => c.id)))}
          disabled={!!copying}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [pressed && styles.pressed]}>
          <ThemedText type="subheadlineEmphasized" style={{ color: theme.accent }}>
            {allChosen ? 'Deselect all' : 'Select all'}
          </ThemedText>
        </Pressable>
      ) : null}
      {!source ? (
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <Modal
      visible
      // iOS: the system's page sheet (its own presentation). Android: full screen, at once.
      animationType={android ? 'none' : 'slide'}
      presentationStyle={android ? undefined : 'pageSheet'}
      allowSwipeDismissal={!copying}
      statusBarTranslucent
      navigationBarTranslucent
      // Android's back steps back to the drafts; iOS asks this once the sheet is swiped away.
      onRequestClose={android ? back : () => !copying && onClose()}>
      <View
        // VoiceOver's escape (two-finger Z) steps back too.
        onAccessibilityEscape={back}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.groupedBackground,
            paddingTop: (android ? insets.top : 0) + Spacing.three,
          },
        ]}>
        {header}
        {source ? (
          <>
            <ClipGrid clips={clips} selected={selected} onToggle={copying ? null : toggle} />
            <View style={[styles.footer, { paddingBottom: insets.bottom + Spacing.three }]}>
              <PrimaryButton
                label={
                  copying
                    ? `Copying ${Math.min(copying.done + 1, copying.total)} of ${copying.total}…`
                    : chosen.length > 0
                      ? `Add ${formatClipCount(chosen.length)}`
                      : 'Select clips to add'
                }
                busy={!!copying}
                disabled={chosen.length === 0 || !!copying}
                onPress={() => void add()}
                testID="anotherPulse.add"
              />
            </View>
          </>
        ) : (
          <DraftList
            drafts={drafts}
            bottomInset={insets.bottom}
            onPick={(id) => {
              setSelected(new Set());
              setSourceId(id);
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function DraftList({
  drafts,
  bottomInset,
  onPick,
}: {
  drafts: DraftRow[];
  bottomInset: number;
  onPick: (id: string) => void;
}) {
  const now = useNow(DATE_LABEL_REFRESH_MS);
  return (
    <FlatList
      data={drafts}
      keyExtractor={(d) => d.id}
      contentContainerStyle={[styles.list, { paddingBottom: bottomInset + Spacing.three }]}
      ListEmptyComponent={
        <ThemedText type="body" themeColor="textSecondary" style={styles.empty}>
          Your other Pulses’ clips show here.
        </ThemedText>
      }
      renderItem={({ item }) => (
        <DraftRowView draft={item} now={now} onPress={() => onPick(item.id)} />
      )}
    />
  );
}

/** A draft as Home's card shows it: its cover, name, clip count, length and date. */
function DraftRowView({
  draft,
  now,
  onPress,
}: {
  draft: DraftRow;
  now: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const thumbnail = useThumbnail(
    draft.firstSegmentThumbnail,
    draft.firstSegmentFilename,
    draft.firstSegmentEditState,
  );
  const name = draftDisplayName(draft.name, null);
  const details = `${formatClipCount(draft.segmentCount)} · ${formatDuration(
    draft.durationMs > 0 ? Math.max(draft.durationMs, 1000) : 0,
  )} · ${formatRelativeDate(draft.lastModified, now)}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${details}`}
      accessibilityHint="Shows its clips to add."
      testID="anotherPulse.draft"
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.backgroundSelected : theme.card },
      ]}>
      <View style={[styles.rowThumb, { backgroundColor: theme.backgroundSelected }]}>
        {thumbnail ? (
          <Image source={thumbnail} style={styles.rowThumbImage} contentFit="cover" />
        ) : (
          <Icon name="video.fill" size={18} tintColor={theme.textSecondary} />
        )}
      </View>
      <View style={styles.rowBody}>
        <ThemedText type="headline" numberOfLines={1}>
          {name}
        </ThemedText>
        <ThemedText type="subheadline" themeColor="textSecondary" numberOfLines={2}>
          {details}
        </ThemedText>
      </View>
      <Icon name="chevron.compact.right" size={16} tintColor={theme.textSecondary} />
    </Pressable>
  );
}

function ClipGrid({
  clips,
  selected,
  onToggle,
}: {
  clips: Segment[];
  selected: ReadonlySet<string>;
  /** Null while the copy runs. */
  onToggle: ((id: string) => void) | null;
}) {
  const { width } = useWindowDimensions();
  const size = Math.floor((width - Spacing.three * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS);
  return (
    <FlatList
      data={clips}
      keyExtractor={(c) => c.id}
      numColumns={COLUMNS}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={styles.grid}
      renderItem={({ item }) => (
        <ClipCell
          clip={item}
          size={size}
          checked={selected.has(item.id)}
          onPress={onToggle ? () => onToggle(item.id) : undefined}
        />
      )}
    />
  );
}

function ClipCell({
  clip,
  size,
  checked,
  onPress,
}: {
  clip: Segment;
  size: number;
  checked: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();
  // As on the recorder's clip strip: the cover, else the clip the editor plays, its edit applied.
  const thumbnail = useThumbnail(
    clip.thumbnail,
    clip.editedFilename ?? clip.originalFilename,
    clip.editedFilename ? null : clip.editState,
  );
  const ms = effMs(clip);
  const length = ms > 0 ? formatDuration(Math.max(ms, 1000)) : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !onPress }}
      accessibilityLabel={`Clip ${clip.label ?? ''}${length ? `, ${length}` : ''}`}
      testID="anotherPulse.clip"
      style={({ pressed }) => [
        styles.cell,
        {
          width: size,
          height: Math.round((size * 4) / 3),
          backgroundColor: theme.backgroundSelected,
          borderColor: checked ? theme.accent : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      {thumbnail ? (
        <Image source={thumbnail} style={styles.cellImage} contentFit="cover" />
      ) : (
        <Icon name="video.fill" size={22} tintColor={theme.textSecondary} />
      )}
      {clip.label ? (
        <View style={[styles.chip, styles.labelChip]} pointerEvents="none">
          <Text style={styles.chipText} maxFontSizeMultiplier={THUMB_TEXT_SCALE}>
            {clip.label}
          </Text>
        </View>
      ) : null}
      {length ? (
        <View style={[styles.chip, styles.lengthChip]} pointerEvents="none">
          <Text style={styles.chipText} maxFontSizeMultiplier={THUMB_TEXT_SCALE}>
            {length}
          </Text>
        </View>
      ) : null}
      <View style={styles.check} pointerEvents="none">
        <Icon
          name={checked ? 'checkmark.circle.fill' : 'circle'}
          size={24}
          tintColor={checked ? theme.accent : '#fff'}
        />
      </View>
    </Pressable>
  );
}

const CELL_RADIUS = Radius.row;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    minHeight: 44,
  },
  headerButton: { minWidth: 28, minHeight: 28, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  pressed: { opacity: Opacity.pressedGlyph },
  list: { gap: Spacing.two, paddingHorizontal: Spacing.three },
  empty: { textAlign: 'center', paddingTop: Spacing.five },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.two,
    paddingRight: Spacing.three,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    ...CardShadow,
  },
  // Home's draft card cover (draft-card.tsx): 44 × 60, concentric with the row.
  rowThumb: {
    width: 44,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.card - Spacing.two,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  rowThumbImage: { width: '100%', height: '100%' },
  rowBody: { flex: 1, gap: 2 },
  grid: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.three, gap: GRID_GAP },
  gridRow: { gap: GRID_GAP },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CELL_RADIUS,
    borderCurve: 'continuous',
    borderWidth: 3,
    overflow: 'hidden',
  },
  cellImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  chip: {
    position: 'absolute',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  labelChip: { top: Spacing.one, left: Spacing.one },
  lengthChip: { bottom: Spacing.one, right: Spacing.one },
  chipText: { color: '#fff', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  check: {
    position: 'absolute',
    top: Spacing.one,
    right: Spacing.one,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 0 },
  },
  footer: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two },
});
