import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router } from 'expo-router';
import { Icon } from '@/components/icon';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateMessage } from '@/components/state-message';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { EaseOut, ListReflowMs } from '@/constants/motion';
import { FloatShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { deleteDraft, type DraftListClip, draftListQuery, renameDraft } from '@/db/drafts';
import { useDraftTransfer } from '@/features/draft-transfer/use-draft-transfer';
import { DraftCard } from '@/features/home/draft-card';
import { DraftMenu } from '@/features/home/draft-menu';
import { useOnboardingRedirect } from '@/features/onboarding/use-onboarding-redirect';
import { useDraftsWithHiddenClips, useHiddenClips } from '@/features/recorder/clip-deletes';
import { useToast } from '@/features/toast/toast-provider';
import { DestinationsFloat } from '@/features/upload/destinations-float';
import { useNow } from '@/hooks/use-now';
import { useTheme, useThemeToggle } from '@/hooks/use-theme';
import { formatCount } from '@/utils/format';
import { userMessage } from '@/utils/user-message';

// Dev-only seeding controls, behind a `__DEV__`-guarded require so the component and `@/dev/seed`
// (with its perf fixtures) are dead-code-eliminated from the production bundle, not just hidden.
const DevSeedRow = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay conditional (see above)
    (require('@/dev/dev-seed-row') as typeof import('@/dev/dev-seed-row')).DevSeedRow
  : null;

/** How often the cards' date labels ("Just now", "Today, 2:30 PM", …) re-evaluate. */
const DATE_LABEL_REFRESH_MS = 60_000;

// A deleted (or undone) card closes (or opens) its gap with the cards below gliding, instead of
// every one of them jumping a row.
const LIST_REFLOW = LinearTransition.duration(ListReflowMs).easing(EaseOut);
// Only an exit, no `entering`: the list mounts cells as they scroll into view, and those would
// fade in while scrolling. Opacity only, so it stays under Reduce Motion (`Never`): gentler than
// the card vanishing, and nothing moves.
const CARD_EXIT = FadeOut.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);

export default function HomeScreen() {
  // First-run gate: pushes the onboarding tour over home when not yet completed.
  useOnboardingRedirect();

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { data: drafts } = useLiveQuery(draftListQuery);
  // One clock for every card's date label, so "Just now" and "Today" move on (and roll over at
  // midnight) without a DB write.
  const now = useNow(DATE_LABEL_REFRESH_MS);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  // The draft whose action menu (rename, delete, …) is open; null when closed.
  // Name shown ahead of the DB write; dropped once the live query reflects it.
  const [pendingRename, setPendingRename] = useState<{ id: string; name: string | null } | null>(
    null,
  );
  // Rows hidden optimistically while their delete waits out its Undo toast, then while in flight.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  // Clips deleted in the recorder whose Undo is still up: their rows are still in the db, so the
  // query still counts them. Left out here too, so the card matches the recorder it opens.
  const hiddenClips = useHiddenClips();
  const draftsWithHiddenClips = useDraftsWithHiddenClips();

  // Multi-select for `.pulse` export. `selectionMode` swaps the header for a selection toolbar
  // and turns each card into a checkbox; `selectedIds` tracks the chosen drafts.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const { busy, state: transferState, shareDrafts, importDrafts } = useDraftTransfer();
  const { showToast, showUndoToast } = useToast();

  // Appearance preference (system-follow / pinned light / pinned dark), persisted so it
  // survives restarts (see `useTheme`).
  const { preference: themePref, mode: themeMode, toggle: toggleTheme } = useThemeToggle();

  // Once the live query reflects the pending name, drop it so the DB value takes back over.
  if (
    pendingRename &&
    drafts.some((d) => d.id === pendingRename.id && d.name === pendingRename.name)
  ) {
    setPendingRename(null);
  }
  // Once a delete lands (row gone from the query), stop tracking it so the set stays small.
  if (deletingIds.size) {
    const live = new Set(drafts.map((d) => d.id));
    if ([...deletingIds].some((id) => !live.has(id))) {
      setDeletingIds(new Set([...deletingIds].filter((id) => live.has(id))));
    }
  }

  // Each draft as it will be once its pending clip deletes land: its clips (from the same query)
  // without the hidden ones, by id, so the count, length and cover match the recorder's strip and
  // never lag the delete. One left with no clips is hidden like a deleted draft: committing its
  // deletes drops the draft too (`commitClipDelete`).
  const visibleDrafts = drafts.flatMap((d) => {
    if (deletingIds.has(d.id)) return [];
    if (!draftsWithHiddenClips.has(d.id)) return [d];
    const clips = (JSON.parse(d.clipsJson) as DraftListClip[]).filter(
      (c) => !hiddenClips.has(c.id),
    );
    if (clips.length === 0) return [];
    return [
      {
        ...d,
        segmentCount: clips.length,
        durationMs: clips.reduce((sum, c) => sum + c.ms, 0),
        firstSegmentFilename: clips[0].file,
        firstSegmentThumbnail: clips[0].thumb,
      },
    ];
  });
  const allSelected = visibleDrafts.length > 0 && visibleDrafts.every((d) => selectedIds.has(d.id));

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exporting = transferState === 'exporting';
  const shareDisabled = selectedIds.size === 0 || (busy && !exporting);

  const toggleSelectAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(visibleDrafts.map((d) => d.id)));

  const submitRename = (draftId: string, currentName: string | null, input: string) => {
    setEditingDraftId(null);
    const name = input || null;
    if (name === currentName) return;
    setPendingRename({ id: draftId, name });
    renameDraft(draftId, name).catch((e) => {
      setPendingRename(null);
      showToast({
        kind: 'error',
        title: 'Couldn’t rename the draft',
        message: userMessage(e, 'Try again.', 'rename'),
      });
    });
  };

  const unhide = (draftId: string) =>
    setDeletingIds((prev) => {
      const next = new Set(prev);
      next.delete(draftId);
      return next;
    });

  // No confirm dialog: the card goes at once and the toast offers Undo. Nothing touches the DB or
  // the clips on disk until the toast goes away without Undo, so Undo is a plain unhide.
  const deleteWithUndo = (draftId: string, name: string | null) => {
    setDeletingIds((prev) => new Set(prev).add(draftId));
    showUndoToast({
      title: 'Draft deleted',
      // Which one, when it has a name; an unnamed draft's "Untitled" would say nothing.
      message: name && name !== 'Untitled' ? name : undefined,
      onUndo: () => unhide(draftId),
      onCommit: () => {
        // Delete isn't offered while uploading (see `draftMenuActions`) and `deleteDraft`
        // refuses an uploading draft, so there's no live run to stop first.
        deleteDraft(draftId).catch((e) => {
          // The card comes back, so it never vanishes without its delete having happened.
          unhide(draftId);
          showToast({
            kind: 'error',
            title: 'Couldn’t delete the draft',
            message: userMessage(e, 'Try again.', 'delete'),
          });
        });
      },
    });
  };

  // Built per-render from the open draft; new actions are added here.
  return (
    <ThemedView type="groupedBackground" style={styles.container}>
      {selectionMode ? (
        <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
          <Pressable
            onPress={exitSelection}
            hitSlop={12}
            accessibilityRole="button"
            style={({ pressed }) => [styles.selectionAction, pressed && styles.pressedText]}>
            <ThemedText themeColor="accent">Cancel</ThemedText>
          </Pressable>
          <ThemedText type="subheadlineEmphasized">
            {selectedIds.size === 0
              ? 'Select drafts'
              : formatCount(selectedIds.size, 'selected', 'selected')}
          </ThemedText>
          <Pressable
            onPress={toggleSelectAll}
            hitSlop={12}
            accessibilityRole="button"
            disabled={visibleDrafts.length === 0}
            style={({ pressed }) => [styles.selectionAction, pressed && styles.pressedText]}>
            <ThemedText themeColor={visibleDrafts.length === 0 ? 'textSecondary' : 'accent'}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.header, styles.headerEnd, { paddingTop: insets.top + Spacing.three }]}>
          <View style={styles.headerActions}>
            <Pressable
              onPress={importDrafts}
              hitSlop={12}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={
                transferState === 'importing' ? 'Importing drafts' : 'Import drafts'
              }
              accessibilityHint="Imports drafts from a .pulse file"
              accessibilityState={{ disabled: busy, busy: transferState === 'importing' }}
              style={({ pressed }) => [
                styles.headerButton,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              {transferState === 'importing' ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Icon
                  name="square.and.arrow.down"
                  size={20}
                  tintColor={busy ? theme.textSecondary : theme.text}
                />
              )}
              <ThemedText
                type="caption2"
                themeColor={busy ? 'textSecondary' : 'text'}
                style={styles.headerButtonLabel}>
                Import
              </ThemedText>
            </Pressable>
            {/* Always rendered (disabled with no drafts) so Import doesn't slide over when the
                first draft appears. */}
            <Pressable
              onPress={() => setSelectionMode(true)}
              disabled={visibleDrafts.length === 0}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Export drafts"
              accessibilityHint="Select drafts to share as a .pulse file"
              accessibilityState={{ disabled: visibleDrafts.length === 0 }}
              style={({ pressed }) => [
                styles.headerButton,
                visibleDrafts.length === 0 && styles.disabled,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              <Icon name="square.and.arrow.up" size={20} tintColor={theme.text} />
              <ThemedText type="caption2" style={styles.headerButtonLabel}>
                Export
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={toggleTheme}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Appearance"
              accessibilityHint="Cycles between system, light, and dark appearance"
              accessibilityValue={{
                text: themePref === 'system' ? `System (${themeMode})` : themePref,
              }}
              style={({ pressed }) => [
                styles.headerButton,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              <Icon
                name={
                  themePref === 'system'
                    ? 'circle.lefthalf.filled'
                    : themeMode === 'dark'
                      ? 'moon.fill'
                      : 'sun.max.fill'
                }
                size={20}
                tintColor={theme.text}
              />
              <ThemedText type="caption2" style={styles.headerButtonLabel}>
                {themePref === 'system' ? 'Auto' : themeMode === 'dark' ? 'Dark' : 'Light'}
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={() => router.push('/about')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="About"
              accessibilityHint="Shows the version, build details and debug logs"
              style={({ pressed }) => [
                styles.headerButton,
                pressed && { backgroundColor: theme.backgroundSelected },
              ]}>
              <Icon name="info.circle" size={20} tintColor={theme.text} />
              <ThemedText type="caption2" style={styles.headerButtonLabel}>
                About
              </ThemedText>
            </Pressable>
          </View>
        </View>
      )}

      {/* Dev-only seeding controls live on their own line so they never crowd the AI action. */}
      {DevSeedRow && (
        <View style={styles.devRowWrap}>
          <DevSeedRow />
        </View>
      )}

      {visibleDrafts.length === 0 ? (
        <View style={styles.empty}>
          <StateMessage
            icon="video.badge.plus"
            title="No drafts yet"
            message="Tap + to record your first video."
          />
        </View>
      ) : (
        <Animated.FlatList
          data={visibleDrafts}
          keyExtractor={(item) => item.id}
          itemLayoutAnimation={LIST_REFLOW}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + Spacing.six + Spacing.four },
          ]}
          renderItem={({ item }) => {
            const name = pendingRename?.id === item.id ? pendingRename.name : item.name;
            return (
              <Animated.View exiting={CARD_EXIT}>
                <DraftCard
                  id={item.id}
                  uploadStatus={item.uploadStatus}
                  name={name}
                  firstSegmentFilename={item.firstSegmentFilename}
                  firstSegmentThumbnail={item.firstSegmentThumbnail}
                  segmentCount={item.segmentCount}
                  durationMs={item.durationMs}
                  lastModified={item.lastModified}
                  now={now}
                  editing={editingDraftId === item.id}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(item.id)}
                  onPress={() => {
                    if (selectionMode) toggleSelected(item.id);
                    // Locked while uploading — the card shows the ring; ⋯ offers Cancel.
                    else if (item.uploadStatus !== 'uploading')
                      router.push({ pathname: '/recorder', params: { draftId: item.id } });
                  }}
                  onLongPress={
                    item.uploadStatus === 'uploading' ? undefined : () => setEditingDraftId(item.id)
                  }
                  menu={(watchLink) => (
                    <DraftMenu
                      draftId={item.id}
                      watchLink={watchLink}
                      uploading={item.uploadStatus === 'uploading'}
                      besidePill={item.uploadStatus === 'uploaded'}
                      onRename={() => setEditingDraftId(item.id)}
                      onDelete={() => deleteWithUndo(item.id, name)}
                    />
                  )}
                  onSubmitName={(input) => submitRename(item.id, item.name, input)}
                />
              </Animated.View>
            );
          }}
        />
      )}

      {selectionMode ? (
        <Pressable
          onPress={() => shareDrafts([...selectedIds])}
          // Busy isn't disabled: while it exports it ignores taps but stays at full strength
          // with its spinner. Dimmed only when there's nothing to share, or an import (no
          // spinner here) holds the transfer.
          disabled={selectedIds.size === 0 || busy}
          accessibilityRole="button"
          accessibilityLabel="Share selected drafts"
          accessibilityState={{ disabled: shareDisabled, busy: exporting }}
          style={({ pressed }) => [
            styles.fab,
            {
              backgroundColor: theme.accent,
              bottom: insets.bottom + Spacing.four,
              opacity: shareDisabled ? Opacity.disabled : pressed ? Opacity.pressed : 1,
            },
          ]}>
          {exporting ? (
            <ActivityIndicator color={theme.onAccent} />
          ) : (
            <Icon
              name="square.and.arrow.up"
              size={26}
              weight="semibold"
              tintColor={theme.onAccent}
            />
          )}
        </Pressable>
      ) : (
        <Pressable
          onPress={() => router.push('/recorder')}
          accessibilityRole="button"
          accessibilityLabel="New recording"
          style={({ pressed }) => [
            styles.fab,
            {
              backgroundColor: theme.accent,
              bottom: insets.bottom + Spacing.four,
              opacity: pressed ? Opacity.pressed : 1,
            },
          ]}>
          <Icon name="plus" size={28} weight="semibold" tintColor={theme.onAccent} />
        </Pressable>
      )}

      {/* Bottom-left float for the paired upload-destination pool (view/delete); clears the +
          FAB at bottom-right. Hidden during .pulse multi-select to avoid crowding that toolbar. */}
      {!selectionMode && <DestinationsFloat />}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // The cards' 16 pt gutter. The buttons carry their own inner padding, so their pressed fill
    // lines up with the cards' edge and the glyphs sit a little inside it.
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  // No title — the actions alone, trailing-aligned. (Selection mode keeps space-between.)
  headerEnd: { justifyContent: 'flex-end' },
  // Same 44pt row as the normal header's buttons (`headerButton.minHeight`), so entering or
  // leaving export selection doesn't change the header's height and shift the drafts.
  selectionAction: { minHeight: 44, justifyContent: 'center' },
  pressedText: { opacity: Opacity.pressedGlyph },
  disabled: { opacity: Opacity.disabled },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  // Shared header action: icon stacked above its label, with a ≥44×44pt touch target (HIG).
  headerButton: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.half,
    minHeight: 44,
    minWidth: 44,
    borderRadius: Radius.row,
    borderCurve: 'continuous',
    paddingHorizontal: Spacing.two,
  },
  // Size/leading come from the `caption2` type; semibold, as the labels under the header icons.
  headerButtonLabel: { fontWeight: '600' },
  devRowWrap: {
    alignItems: 'flex-end',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  list: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  empty: { flex: 1, justifyContent: 'center' },
  fab: {
    position: 'absolute',
    right: Spacing.four,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    ...FloatShadow,
  },
});
