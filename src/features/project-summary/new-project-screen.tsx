import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { ProjectThumbnail } from '@/components/project-thumbnail';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CardShadow, MaxTextScale, Opacity, Radius, Spacing } from '@/constants/theme';
import { draftDisplayName, draftListQuery } from '@/db/drafts';
import {
  createSummary,
  latestSummaryQuery,
  selectSummaryBeats,
  summaryBeatsQuery,
  type SummarySelection,
} from '@/db/summaries';
import { usePlaceLabels } from '@/features/upload/pairing/use-destinations';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { DRAFT_NAME_MAX_LENGTH, dropSplitSurrogate } from '@/utils/draft-name';
import { formatCount, formatDuration } from '@/utils/format';
import { formatDateTime } from '@/utils/relative-date';
import { userMessage } from '@/utils/user-message';

import { SummaryDateRange } from './summary-date-range';
import { formatSummaryDate, summaryDateRange, todayDate } from './summary-dates';

type Props = {
  onClose: () => void;
  onBlankProject: () => void;
  onCreated: (draftId: string) => void;
  onOpenSummary: (draftId: string) => void;
};

const MODES = [
  { mode: 'range', label: 'Date range' },
  { mode: 'projects', label: 'Choose projects' },
  { mode: 'since-last', label: 'Since last summary' },
] as const;

/** Standalone project kickoff. Summary copies are ordinary editable projects in the recorder. */
export function NewProjectScreen({ onClose, onBlankProject, onCreated, onOpenSummary }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(60_000);
  const {
    data: beats,
    error: beatsError,
    updatedAt: beatsUpdatedAt,
  } = useLiveQuery(summaryBeatsQuery);
  const {
    data: summaries,
    error: summaryError,
    updatedAt: summaryUpdatedAt,
  } = useLiveQuery(latestSummaryQuery);
  const latest = summaries[0] ?? null;
  // Use Home's cover query so a filtered range still shows the project's familiar cover.
  const { data: draftRows } = useLiveQuery(draftListQuery);
  const covers = new Map(draftRows.map((draft) => [draft.id, draft]));
  const placeLabel = usePlaceLabels();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [chosenMode, setChosenMode] = useState<SummarySelection['mode'] | null>(null);
  const mode = chosenMode ?? (latest ? 'since-last' : 'range');
  const [startDate, setStartDate] = useState(() => todayDate(Date.now()));
  const [endDate, setEndDate] = useState(() => todayDate(Date.now()));
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = !!beatsUpdatedAt && !!summaryUpdatedAt;
  const queryFailed = !!beatsError || !!summaryError;
  const range = summaryDateRange(startDate, endDate);
  const selection: SummarySelection | null =
    mode === 'projects'
      ? { mode, projectIds: [...selectedIds] }
      : mode === 'since-last'
        ? latest
          ? { mode }
          : null
        : range
          ? { mode, ...range }
          : null;
  const matches = selection
    ? selectSummaryBeats(beats, selection, {
        // The snapshot includes additions in the query's own millisecond. Creation freezes
        // its separate half-open collection window when the person taps Create.
        cutoffAt: Math.max(now, (beatsUpdatedAt?.getTime() ?? now) + 1),
        lastSummaryCutoffAt: latest?.summaryCutoffAt ?? null,
      })
    : [];
  const projects = new Map<string, { id: string; name: string; count: number }>();
  for (const beat of mode === 'projects' ? beats : matches) {
    const existing = projects.get(beat.projectId);
    if (existing) existing.count++;
    else
      projects.set(beat.projectId, {
        id: beat.projectId,
        name: draftDisplayName(beat.projectName, placeLabel(beat.contextServer, beat.contextRef)),
        count: 1,
      });
  }
  const allSelected = projects.size > 0 && [...projects.keys()].every((id) => selectedIds.has(id));
  const matchingProjectCount = new Set(matches.map((beat) => beat.projectId)).size;
  const defaultName = `Summary · ${formatSummaryDate(todayDate(now))}`;
  const canCreate = loaded && !queryFailed && matches.length > 0 && !!selection;

  // The full-screen route has no swipe-dismiss. Keep Android Back from leaving mid-copy too.
  useEffect(() => {
    if (!busy) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [busy]);

  const toggleProject = (id: string) => {
    setError(null);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const create = async () => {
    if (!selection || !canCreate || creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await createSummary({
        name: dropSplitSurrogate(name.trim()) || defaultName,
        selection,
      });
      onCreated(result.draftId);
    } catch (cause) {
      setError(userMessage(cause, 'Your summary wasn’t created. Try again.', 'summary'));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  return (
    <ThemedView type="groupedBackground" style={styles.fill}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
          <ThemedText type="headline">New project</ThemedText>
          <Pressable
            onPress={onClose}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Close new project"
            accessibilityState={{ disabled: busy }}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <Icon name="xmark" size={22} tintColor={theme.text} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <ThemedText type="largeTitle" accessibilityRole="header">
              Start something new
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              Start fresh, or bring your day’s work together.
            </ThemedText>
          </View>

          <View style={styles.choices}>
            {(
              [
                {
                  value: 'blank',
                  title: 'Blank project',
                  detail: 'Start with a new recording.',
                  icon: 'plus',
                },
                {
                  value: 'summary',
                  title: 'Summary',
                  detail: 'Collect beats from your projects.',
                  icon: 'rectangle.stack',
                },
              ] as const
            ).map((option) => (
              <Pressable
                key={option.value}
                onPress={() => {
                  if (option.value === 'blank') {
                    onBlankProject();
                    return;
                  }
                  setSummaryOpen(true);
                  setError(null);
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={option.title}
                accessibilityHint={
                  option.value === 'blank' ? 'Opens the recorder immediately' : option.detail
                }
                accessibilityState={{
                  disabled: busy,
                  expanded: option.value === 'summary' ? summaryOpen : undefined,
                }}
                testID={`new-project.${option.value}`}
                style={({ pressed }) => [
                  styles.choice,
                  {
                    backgroundColor: pressed ? theme.backgroundSelected : theme.card,
                    borderColor:
                      summaryOpen && option.value === 'summary' ? theme.accent : 'transparent',
                  },
                ]}>
                <Icon
                  name={option.icon}
                  size={24}
                  tintColor={
                    summaryOpen && option.value === 'summary' ? theme.accent : theme.textSecondary
                  }
                />
                <ThemedText type="headline">{option.title}</ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary">
                  {option.detail}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          {summaryOpen && (
            <>
              <View style={styles.section}>
                <ThemedText type="headline" accessibilityRole="header">
                  Summary name
                </ThemedText>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder={defaultName}
                  placeholderTextColor={theme.textSecondary}
                  accessibilityLabel="Summary name"
                  maxLength={DRAFT_NAME_MAX_LENGTH}
                  maxFontSizeMultiplier={MaxTextScale}
                  editable={!busy}
                  returnKeyType="done"
                  style={[styles.input, { color: theme.text, backgroundColor: theme.card }]}
                />
              </View>

              <View style={[styles.reminder, { backgroundColor: theme.card }]}>
                <Icon name="rectangle.stack" size={20} tintColor={theme.accent} scalesWithText />
                <View style={styles.reminderText}>
                  <ThemedText type="subheadlineEmphasized">
                    {latest ? 'Your last summary' : 'Your first summary'}
                  </ThemedText>
                  <ThemedText type="footnote" themeColor="textSecondary">
                    {latest
                      ? `${latest.name || 'Untitled summary'}\nCollected through ${formatDateTime(latest.summaryCutoffAt!)}`
                      : 'Choose a date range or projects. Next time, pick up from this summary.'}
                  </ThemedText>
                  {latest && (
                    <Pressable
                      onPress={() => onOpenSummary(latest.id)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel="View last summary"
                      accessibilityState={{ disabled: busy }}
                      style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                      <ThemedText type="subheadlineEmphasized" themeColor="accent">
                        View last summary
                      </ThemedText>
                      <Icon name="arrow.right" size={14} tintColor={theme.accent} />
                    </Pressable>
                  )}
                </View>
              </View>

              <View style={styles.section}>
                <ThemedText type="headline" accessibilityRole="header">
                  Collect beats
                </ThemedText>
                <View style={styles.modes}>
                  {MODES.map((option) => {
                    const disabled = busy || (option.mode === 'since-last' && !latest);
                    return (
                      <Pressable
                        key={option.mode}
                        onPress={() => {
                          setChosenMode(option.mode);
                          setError(null);
                        }}
                        disabled={disabled}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ selected: mode === option.mode, disabled }}
                        style={({ pressed }) => [
                          styles.mode,
                          {
                            backgroundColor:
                              mode === option.mode
                                ? theme.accent
                                : pressed
                                  ? theme.backgroundSelected
                                  : theme.card,
                            opacity: disabled ? Opacity.disabled : 1,
                          },
                        ]}>
                        <ThemedText
                          type="subheadlineEmphasized"
                          style={{ color: mode === option.mode ? theme.onAccent : theme.text }}>
                          {option.label}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
                {mode === 'range' && (
                  <SummaryDateRange
                    startDate={startDate}
                    endDate={endDate}
                    disabled={busy}
                    onChange={(start, end) => {
                      setStartDate(start);
                      setEndDate(end);
                      setError(null);
                    }}
                  />
                )}
                <ThemedText type="footnote" themeColor="textSecondary">
                  {mode === 'projects'
                    ? 'Include all beats from the projects you check below.'
                    : mode === 'since-last'
                      ? 'New beats added to any project since your last summary.'
                      : 'Include beats added during these dates, even in older projects.'}
                </ThemedText>
                {mode === 'range' && !range && (
                  <ThemedText type="footnote" themeColor="accent" accessibilityRole="alert">
                    Choose an end date on or after the start date.
                  </ThemedText>
                )}
              </View>

              <View style={styles.section}>
                <View style={styles.sectionHeading}>
                  <ThemedText type="headline" accessibilityRole="header">
                    {mode === 'projects' ? 'Choose projects' : 'Included projects'}
                  </ThemedText>
                  {mode === 'projects' && projects.size > 0 && (
                    <Pressable
                      disabled={busy}
                      onPress={() =>
                        setSelectedIds(allSelected ? new Set() : new Set(projects.keys()))
                      }
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy }}
                      style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                      <ThemedText type="subheadlineEmphasized" themeColor="accent">
                        {allSelected ? 'Deselect all' : 'Select all'}
                      </ThemedText>
                    </Pressable>
                  )}
                </View>
                {queryFailed ? (
                  <ThemedText themeColor="accent" accessibilityRole="alert">
                    Couldn’t load your projects. Close this screen and try again.
                  </ThemedText>
                ) : !loaded ? (
                  <ThemedText themeColor="textSecondary">Loading projects…</ThemedText>
                ) : projects.size === 0 ? (
                  <ThemedText themeColor="textSecondary">
                    {beats.length === 0
                      ? 'No source beats yet. Start a blank project and record a few beats first.'
                      : mode === 'since-last'
                        ? 'You’re all caught up. Add more beats or choose a different collection option.'
                        : 'No beats in this date range. Try other dates or choose projects.'}
                  </ThemedText>
                ) : (
                  <View style={[styles.projectList, { backgroundColor: theme.card }]}>
                    {[...projects.values()].map((project, index) => {
                      const cover = covers.get(project.id);
                      const row = (
                        <>
                          <ProjectThumbnail
                            filename={cover?.firstSegmentFilename}
                            thumbnail={cover?.firstSegmentThumbnail}
                            editState={cover?.firstSegmentEditState}
                          />
                          <View style={styles.projectText}>
                            <ThemedText type="subheadlineEmphasized">{project.name}</ThemedText>
                            <ThemedText type="footnote" themeColor="textSecondary">
                              {formatCount(project.count, 'beat', 'beats')}
                            </ThemedText>
                          </View>
                          {mode === 'projects' && (
                            <Icon
                              name={
                                selectedIds.has(project.id) ? 'checkmark.circle.fill' : 'circle'
                              }
                              size={23}
                              tintColor={
                                selectedIds.has(project.id) ? theme.accent : theme.textSecondary
                              }
                            />
                          )}
                        </>
                      );
                      const rowStyle = [
                        styles.projectRow,
                        index > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: theme.border,
                        },
                      ];
                      return mode === 'projects' ? (
                        <Pressable
                          key={project.id}
                          disabled={busy}
                          onPress={() => toggleProject(project.id)}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`${project.name}, ${formatCount(project.count, 'beat', 'beats')}`}
                          accessibilityState={{
                            checked: selectedIds.has(project.id),
                            disabled: busy,
                          }}
                          style={({ pressed }) => [
                            rowStyle,
                            pressed && { backgroundColor: theme.backgroundSelected },
                          ]}>
                          {row}
                        </Pressable>
                      ) : (
                        <View key={project.id} style={rowStyle}>
                          {row}
                        </View>
                      );
                    })}
                  </View>
                )}
                <ThemedText type="footnote" themeColor="textSecondary">
                  Beats are copied into an editable summary. Your source projects stay as they are.
                </ThemedText>
              </View>
            </>
          )}
        </ScrollView>

        {summaryOpen && (
          <View
            style={[
              styles.footer,
              {
                paddingBottom: Math.max(insets.bottom, Spacing.three),
                borderTopColor: theme.border,
              },
            ]}>
            <ThemedText type="subheadlineEmphasized" accessibilityLiveRegion="polite">
              {formatCount(matches.length, 'beat', 'beats')} from{' '}
              {formatCount(matchingProjectCount, 'project', 'projects')}
              {matches.length > 0
                ? ` · ${formatDuration(matches.reduce((sum, beat) => sum + beat.durationMs, 0))}`
                : ''}
            </ThemedText>
            {error && (
              <ThemedText type="footnote" themeColor="accent" accessibilityRole="alert">
                {error}
              </ThemedText>
            )}
            <PrimaryButton
              label={busy ? 'Collecting beats…' : 'Create summary'}
              icon="rectangle.stack"
              onPress={() => void create()}
              busy={busy}
              disabled={busy || !canCreate}
              testID="new-project.create"
            />
          </View>
        )}
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  content: { padding: Spacing.three, paddingBottom: Spacing.four, gap: Spacing.four },
  section: { gap: Spacing.two },
  choices: { flexDirection: 'row', gap: Spacing.two },
  choice: {
    flex: 1,
    padding: Spacing.three,
    gap: Spacing.two,
    borderRadius: Radius.card,
    borderWidth: 2,
    ...CardShadow,
  },
  input: {
    fontSize: 17,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
    borderRadius: Radius.row,
  },
  reminder: {
    flexDirection: 'row',
    padding: Spacing.three,
    gap: Spacing.two,
    borderRadius: Radius.card,
  },
  reminderText: { flex: 1, gap: Spacing.one },
  inlineAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  mode: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: Radius.row,
    minHeight: 44,
    justifyContent: 'center',
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  projectList: { borderRadius: Radius.card, overflow: 'hidden' },
  projectRow: {
    padding: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  projectText: { flex: 1, gap: Spacing.one },
  footer: { padding: Spacing.three, gap: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: Opacity.pressedGlyph },
});
