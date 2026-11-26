import { probe } from '@mieweb/pulse-editor';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import type { TranscriptCutRequest } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { createQuietPauseAnalyzer } from '@/features/transcription/audio-pause-analysis';
import type { CaptionWord } from '@/features/transcription/caption-edits';
import {
  DEFAULT_FILLER_WORDS,
  findFillerCandidates,
  type CleanupCandidate,
} from '@/features/transcription/speech-cleanup';
import { useTheme } from '@/hooks/use-theme';
import { planTranscriptCut } from '@/utils/bulk-transcript-cut';
import { clipRender, type ClipWindow } from '@/utils/segment-window';
import { userMessage } from '@/utils/user-message';
import { CommandButton } from './editor-controls';
import { transcriptSelectionRanges } from './transcript-selection';
import { useTranscriptDrag } from './use-transcript-drag';
export type TranscriptSource = {
  segment: Segment;
  sourceKey: string;
  uri: string;
  label: string;
  words: CaptionWord[];
  fps: number | null;
  sourceMuted?: boolean;
  transcript?: {
    model: string;
    file: string;
    words: string;
  };
};
type Word = {
  id: string;
  source: TranscriptSource;
  index: number;
  word: CaptionWord;
};
type Candidate = CleanupCandidate & {
  source: TranscriptSource;
  reviewOnly: boolean;
};
const PAUSE_OPTIONS_MS = [400, 700, 1000, 1500, 2000];
const seconds = (ms: number) =>
  `${(Math.round(ms / 100) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s`;
const wordId = (source: TranscriptSource, index: number) => `${source.segment.id}:word:${index}`;
/** A frozen transcript review: selection and analysis propose source cuts; Apply commits once. */
export function TranscriptEditorSheet({
  sources,
  initialClipId,
  onApply,
  onPreview,
  onStopPreview,
  onClose,
}: {
  sources: readonly TranscriptSource[];
  initialClipId: string | null;
  onApply: (requests: TranscriptCutRequest[]) => Promise<void>;
  onPreview: (clipId: string, startMs: number, endMs: number) => void;
  onStopPreview: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [frozen] = useState(() =>
    sources.map((source) => ({
      ...source,
      segment: { ...source.segment },
      words: source.words.map((word) => ({ ...word })),
      transcript: source.transcript && { ...source.transcript },
    })),
  );
  const currentId = frozen.some((source) => source.segment.id === initialClipId)
    ? initialClipId
    : (frozen[0]?.segment.id ?? null);
  const [scope, setScope] = useState<'beat' | 'pulse'>('beat');
  const [mode, setMode] = useState<'words' | 'cleanup'>('words');
  const [rates, setRates] = useState(
    () => new Map(frozen.map((source) => [source.segment.id, source.fps])),
  );
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selectedWords, setSelectedWords] = useState<ReadonlySet<string>>(new Set());
  const [rangeMode, setRangeMode] = useState(false);
  const [draggedSelection, setDraggedSelection] = useState(false);
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [fillers, setFillers] = useState(true);
  const [quiet, setQuiet] = useState(true);
  const [pauseMs, setPauseMs] = useState(700);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<ReadonlySet<string>>(new Set());
  const [analysis, setAnalysis] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [analyzed, setAnalyzed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);
  const scoped =
    scope === 'pulse' ? frozen : frozen.filter((source) => source.segment.id === currentId);
  const words: Word[] = scoped.flatMap((source) => {
    const rendered = clipRender(source.segment);
    return source.words.flatMap((word, index) => {
      const mid = (word.t0 + word.t1) * 5;
      return Number.isFinite(mid) &&
        word.t1 > word.t0 &&
        mid >= rendered.inMs &&
        mid < rendered.outMs
        ? [{ id: wordId(source, index), source, index, word }]
        : [];
    });
  });
  const { scrollRef: transcriptScrollRef, ...drag } = useTranscriptDrag({
    words: words.map((entry) => ({ id: entry.id, group: entry.source.segment.id })),
    selected: selectedWords,
    enabled: mode === 'words' && !applying && analysis === null,
    onStart: () => {
      setRangeMode(false);
      setRangeAnchor(null);
      setDraggedSelection(true);
      onStopPreview();
      return () => {
        setRangeMode(rangeMode);
        setRangeAnchor(rangeAnchor);
        setDraggedSelection(draggedSelection);
      };
    },
    onChange: (selection, index) => {
      setSelectedWords(selection);
      setCursor(index);
    },
  });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        for (const source of frozen) {
          if (!live) return;
          if (source.fps && source.fps > 0) continue;
          const fps = (await probe(source.uri)).video?.fps;
          if (!live) return;
          if (!fps || fps <= 0)
            throw new Error(`Couldn’t read the frame rate for ${source.label}.`);
          if (live) setRates((previous) => new Map(previous).set(source.segment.id, fps));
        }
      } catch (failure) {
        if (live)
          setPrepareError(
            userMessage(
              failure,
              'Close and reopen the transcript to try again.',
              'prepare transcript',
            ),
          );
      }
    })();
    return () => {
      live = false;
    };
  }, [frozen, retry]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  const stopAnalysis = () => {
    abort.current?.abort();
    abort.current = null;
    setAnalysis(null);
  };
  const close = () => {
    if (applyingRef.current) return;
    drag.cancel();
    stopAnalysis();
    onStopPreview();
    onClose();
  };
  const invalidateAnalysis = () => {
    stopAnalysis();
    setCandidates([]);
    setSelectedCandidates(new Set());
    setAnalyzed(false);
    setError(null);
  };
  const changeScope = (next: 'beat' | 'pulse') => {
    if (next === scope) return;
    invalidateAnalysis();
    onStopPreview();
    setScope(next);
    setSelectedWords(new Set());
    setDraggedSelection(false);
    setRangeAnchor(null);
    setCursor(0);
  };
  const toggleWord = (entry: Word) => {
    setDraggedSelection(false);
    setCursor(words.findIndex((word) => word.id === entry.id));
    if (rangeMode) {
      const first = words.findIndex((word) => word.id === rangeAnchor);
      if (first < 0) {
        setRangeAnchor(entry.id);
        setSelectedWords(new Set([entry.id]));
        return;
      }
      const last = words.findIndex((word) => word.id === entry.id);
      setSelectedWords(
        new Set(
          words.slice(Math.min(first, last), Math.max(first, last) + 1).map((word) => word.id),
        ),
      );
      setRangeAnchor(null);
    } else
      setSelectedWords((previous) => {
        const next = new Set(previous);
        if (!next.delete(entry.id)) next.add(entry.id);
        return next;
      });
  };
  const toggleCandidate = (id: string) =>
    setSelectedCandidates((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const analyze = async () => {
    invalidateAnalysis();
    onStopPreview();
    const controller = new AbortController();
    abort.current = controller;
    const scan = createQuietPauseAnalyzer(controller.signal);
    const proposed: Candidate[] = [];
    setAnalysis({ done: 0, total: scoped.length });
    try {
      for (let i = 0; i < scoped.length; i++) {
        const source = scoped[i];
        const rendered = clipRender(source.segment);
        if (controller.signal.aborted) return;
        // Muted/no-audio material can be intentional B-roll. Automatic cleanup leaves it alone.
        const media = rendered.muted || source.sourceMuted ? null : await probe(source.uri);
        if (media?.audio) {
          const window = { startMs: rendered.inMs, endMs: rendered.outMs };
          const found = [
            ...(fillers ? findFillerCandidates(source.words, DEFAULT_FILLER_WORDS, window) : []),
            ...(quiet
              ? await scan(source.uri, {
                  minPauseMs: pauseMs * rendered.speed,
                  keepMs: 120 * rendered.speed,
                  window,
                })
              : []),
          ];
          for (const candidate of found)
            proposed.push({
              ...candidate,
              source,
              id: `${source.segment.id}:${candidate.id}`,
              reviewOnly: !!candidate.requiresReview,
            });
        }
        if (controller.signal.aborted) return;
        setAnalysis({ done: i + 1, total: scoped.length });
      }
      if (controller.signal.aborted) return;
      setCandidates(proposed);
      setAnalyzed(true);
      setCursor(0);
      setSelectedCandidates(
        new Set(
          proposed.filter((candidate) => !candidate.reviewOnly).map((candidate) => candidate.id),
        ),
      );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(userMessage(failure, 'Try analyzing again.', 'analyze transcript'));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setAnalysis(null);
      }
    }
  };
  const selectedRanges =
    mode === 'words'
      ? transcriptSelectionRanges(
          scoped.map((source) => ({ clipId: source.segment.id, ...clipRender(source.segment) })),
          words.map((entry) => ({
            id: entry.id,
            clipId: entry.source.segment.id,
            index: entry.index,
            startMs: entry.word.t0 * 10,
            endMs: entry.word.t1 * 10,
          })),
          selectedWords,
          rangeMode ? true : draggedSelection ? 'runs' : false,
        )
      : new Map<string, ClipWindow[]>();
  const addRange = (id: string, range: ClipWindow) =>
    selectedRanges.set(id, [...(selectedRanges.get(id) ?? []), range]);
  if (mode === 'cleanup')
    for (const candidate of candidates) {
      if (selectedCandidates.has(candidate.id)) addRange(candidate.source.segment.id, candidate);
    }
  const requests: TranscriptCutRequest[] = [];
  let removedMs = 0;
  let cutCount = 0;
  let missingRate = false;
  for (const source of scoped) {
    const ranges = selectedRanges.get(source.segment.id);
    if (!ranges?.length) continue;
    const fps = rates.get(source.segment.id);
    if (!fps) {
      missingRate = true;
      continue;
    }
    const plan = planTranscriptCut(source.segment, ranges, fps);
    if (!plan) continue;
    requests.push({
      clipId: source.segment.id,
      sourceKey: source.sourceKey,
      captionKey: source.segment.captionEdit,
      ranges: plan.removed,
      fps,
      transcript: source.transcript,
    });
    removedMs += plan.removedMs;
    cutCount += plan.removed.length;
  }
  const busy = applying || analysis !== null;
  const controlsBusy = busy || drag.dragging;
  const apply = async () => {
    if (
      busy ||
      drag.isActive() ||
      abort.current ||
      applyingRef.current ||
      !requests.length ||
      missingRate ||
      (rangeMode && rangeAnchor !== null && mode === 'words')
    )
      return;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    onStopPreview();
    try {
      await onApply(requests);
      onClose();
    } catch (failure) {
      setError(
        userMessage(
          failure,
          'Close and reopen this transcript, then review the cuts again.',
          'apply transcript cuts',
        ),
      );
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };
  const count = mode === 'words' ? words.length : candidates.length;
  const activeWord = mode === 'words' ? words[Math.min(cursor, words.length - 1)] : null;
  const activeCandidate =
    mode === 'cleanup' ? candidates[Math.min(cursor, candidates.length - 1)] : null;
  const currentLabel =
    activeWord?.word.text ??
    activeCandidate?.label ??
    (mode === 'words' ? 'No transcript words' : 'Analyze to find cuts');
  const currentSelected = activeWord
    ? selectedWords.has(activeWord.id)
    : activeCandidate
      ? selectedCandidates.has(activeCandidate.id)
      : false;
  const preview = (source: TranscriptSource, startMs: number, endMs: number) =>
    onPreview(source.segment.id, startMs, endMs);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      allowSwipeDismissal={!applying && mode !== 'words'}
      onRequestClose={close}>
      <GestureHandlerRootView style={styles.flex}>
        <View
          onAccessibilityEscape={close}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.groupedBackground,
              paddingTop: Platform.OS === 'android' ? insets.top : 0,
            },
          ]}>
          <ThemedText type="title3" accessibilityRole="header" style={styles.title}>
            Edit transcript
          </ThemedText>
          <GestureDetector gesture={drag.pan}>
            <View style={styles.flex} collapsable={false} onLayout={drag.viewportLayout}>
              <GestureDetector gesture={drag.native}>
                <Animated.ScrollView
                  ref={transcriptScrollRef}
                  onScroll={drag.onScroll}
                  onContentSizeChange={drag.contentSize}
                  scrollEventThrottle={16}
                  contentInsetAdjustmentBehavior="never"
                  bounces={false}
                  keyboardShouldPersistTaps="handled"
                  testID="transcript.scroll">
                  <View style={styles.content}>
                    {mode === 'words' ? (
                      <>
                        <ThemedText type="footnote" themeColor="textSecondary">
                          Drag across words to select a passage. Start on highlighted text to
                          deselect. Swipe the margins to scroll. Range also works with two taps.
                        </ThemedText>
                        {scoped.map((source) => (
                          <View
                            key={source.segment.id}
                            style={styles.group}
                            onLayout={(event) => drag.groupLayout(source.segment.id, event)}>
                            <ThemedText type="headline">{source.label}</ThemedText>
                            <View
                              style={styles.words}
                              onLayout={(event) => drag.paragraphLayout(source.segment.id, event)}>
                              {words
                                .filter((entry) => entry.source.segment.id === source.segment.id)
                                .map((entry) => (
                                  <Pressable
                                    key={entry.id}
                                    disabled={busy}
                                    onPress={() => {
                                      if (!drag.consumePress()) toggleWord(entry);
                                    }}
                                    onLayout={(event) => drag.wordLayout(entry.id, event)}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{
                                      checked: selectedWords.has(entry.id),
                                      disabled: busy,
                                    }}
                                    accessibilityLabel={`${source.label}, word ${entry.index + 1}: ${entry.word.text}`}
                                    testID={`transcript.word.${entry.id}`}
                                    style={[
                                      styles.word,
                                      {
                                        backgroundColor: selectedWords.has(entry.id)
                                          ? theme.accent
                                          : theme.card,
                                        borderColor:
                                          entry.id === rangeAnchor ? theme.accent : 'transparent',
                                      },
                                    ]}>
                                    <ThemedText
                                      type="subheadline"
                                      style={{
                                        color: selectedWords.has(entry.id)
                                          ? theme.onAccent
                                          : theme.text,
                                      }}>
                                      {entry.word.text}
                                    </ThemedText>
                                  </Pressable>
                                ))}
                            </View>
                            {!words.some(
                              (entry) => entry.source.segment.id === source.segment.id,
                            ) && (
                              <ThemedText type="footnote" themeColor="textSecondary">
                                No timed transcript yet. Use Captions in the editor to create one.
                                Quiet-pause cleanup works without a transcript.
                              </ThemedText>
                            )}
                          </View>
                        ))}
                      </>
                    ) : (
                      <>
                        <ThemedText type="footnote" themeColor="textSecondary">
                          Review detected fillers and measured quiet pauses before applying. Models
                          may omit ums; very quiet speech can resemble silence. Muted and no-audio
                          beats are skipped. Pauses use playback time, with 120 ms of breathing
                          space kept at each side.
                        </ThemedText>
                        <ThemedText type="footnote" themeColor="textSecondary">
                          Filler words: {DEFAULT_FILLER_WORDS.join(', ')}. Separate narration stays
                          at its existing timeline position.
                        </ThemedText>
                        {analysis && (
                          <View style={styles.progress}>
                            <ActivityIndicator />
                            <ThemedText type="subheadline">
                              Analyzing beat {Math.min(analysis.done + 1, analysis.total)} of{' '}
                              {analysis.total}…
                            </ThemedText>
                          </View>
                        )}
                        {candidates.map((candidate) => (
                          <View
                            key={candidate.id}
                            style={[styles.candidate, { backgroundColor: theme.card }]}>
                            <Pressable
                              style={styles.candidateChoice}
                              disabled={busy}
                              onPress={() => toggleCandidate(candidate.id)}
                              accessibilityRole="checkbox"
                              accessibilityState={{
                                checked: selectedCandidates.has(candidate.id),
                                disabled: busy,
                              }}
                              accessibilityLabel={`${candidate.source.label}: ${candidate.label}, ${seconds((candidate.endMs - candidate.startMs) / clipRender(candidate.source.segment).speed)}${candidate.reviewOnly ? ', review quiet beat' : ''}`}>
                              <Icon
                                name={
                                  selectedCandidates.has(candidate.id)
                                    ? 'checkmark.circle.fill'
                                    : 'circle'
                                }
                                size={22}
                                tintColor={
                                  selectedCandidates.has(candidate.id)
                                    ? theme.accent
                                    : theme.textSecondary
                                }
                              />
                              <View style={styles.candidateText}>
                                <ThemedText type="subheadlineEmphasized">
                                  {candidate.label}
                                </ThemedText>
                                <ThemedText type="caption1" themeColor="textSecondary">
                                  {candidate.source.label} ·{' '}
                                  {seconds(
                                    (candidate.endMs - candidate.startMs) /
                                      clipRender(candidate.source.segment).speed,
                                  )}
                                  {candidate.reviewOnly ? ' · Review quiet beat' : ''}
                                </ThemedText>
                              </View>
                            </Pressable>
                            <CommandButton
                              icon="play.fill"
                              label={`Listen to ${candidate.label} in ${candidate.source.label}`}
                              disabled={busy}
                              onPress={() =>
                                preview(candidate.source, candidate.startMs, candidate.endMs)
                              }
                            />
                          </View>
                        ))}
                        {!busy && !candidates.length && (
                          <ThemedText type="footnote" themeColor="textSecondary">
                            {analyzed
                              ? 'No matching fillers or quiet pauses found.'
                              : 'Tap Analyze to find matching words and quiet pauses.'}
                          </ThemedText>
                        )}
                      </>
                    )}
                  </View>
                </Animated.ScrollView>
              </GestureDetector>
            </View>
          </GestureDetector>
          <View
            style={[
              styles.footer,
              { borderColor: theme.border, paddingBottom: Math.max(insets.bottom, 12) },
            ]}>
            {error && (
              <ThemedText
                type="footnote"
                style={{ color: theme.warning }}
                accessibilityLiveRegion="polite">
                {error}
              </ThemedText>
            )}
            {prepareError && (
              <Pressable
                onPress={() => {
                  setPrepareError(null);
                  setRetry((n) => n + 1);
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Retry reading video frame rates">
                <ThemedText type="footnote" style={{ color: theme.warning }}>
                  {prepareError} Tap to retry.
                </ThemedText>
              </Pressable>
            )}
            <ThemedText
              type="footnote"
              style={styles.summary}
              accessibilityLiveRegion="polite"
              testID="transcript.summary">
              {missingRate
                ? 'Reading source video…'
                : `${cutCount} ${cutCount === 1 ? 'cut' : 'cuts'} · ${seconds(removedMs)} shorter`}
            </ThemedText>
            <View style={styles.row}>
              <Choice
                label={'This beat'}
                selected={scope === 'beat'}
                onPress={() => changeScope('beat')}
                disabled={controlsBusy || !currentId}
              />
              <Choice
                label={'Whole Pulse'}
                selected={scope === 'pulse'}
                onPress={() => changeScope('pulse')}
                disabled={controlsBusy}
              />
              <Choice
                label={'Words'}
                selected={mode === 'words'}
                onPress={() => {
                  onStopPreview();
                  setMode('words');
                  setCursor(0);
                }}
                disabled={controlsBusy}
              />
              <Choice
                label={'Clean up'}
                selected={mode === 'cleanup'}
                onPress={() => {
                  onStopPreview();
                  setMode('cleanup');
                  setCursor(0);
                }}
                disabled={controlsBusy}
              />
            </View>
            {mode === 'words' ? (
              <View style={styles.row}>
                <Choice
                  label={rangeAnchor ? 'Choose last word' : 'Range'}
                  selected={rangeMode}
                  onPress={() => {
                    setRangeMode(!rangeMode);
                    setDraggedSelection(false);
                    setRangeAnchor(null);
                    setSelectedWords(new Set());
                  }}
                  disabled={controlsBusy}
                />
                <Choice
                  label={'Select all words'}
                  selected={false}
                  onPress={() => {
                    setRangeMode(false);
                    setDraggedSelection(false);
                    setRangeAnchor(null);
                    setSelectedWords(new Set(words.map((word) => word.id)));
                  }}
                  disabled={controlsBusy}
                />
                <Choice
                  label={'Clear'}
                  selected={false}
                  onPress={() => {
                    setSelectedWords(new Set());
                    setDraggedSelection(false);
                    setRangeAnchor(null);
                  }}
                  disabled={controlsBusy}
                />
              </View>
            ) : (
              <View style={styles.row}>
                <Choice
                  label={'Fillers'}
                  selected={fillers}
                  onPress={() => {
                    invalidateAnalysis();
                    setFillers(!fillers);
                  }}
                  disabled={busy}
                />
                <Choice
                  label={`Pauses ≥${seconds(pauseMs)}`}
                  selected={quiet}
                  onPress={() => {
                    invalidateAnalysis();
                    setQuiet(!quiet);
                  }}
                  disabled={busy}
                />
                <Choice
                  label={`Pause length: ${seconds(pauseMs)}`}
                  selected={false}
                  onPress={() => {
                    invalidateAnalysis();
                    setPauseMs(
                      PAUSE_OPTIONS_MS[
                        (PAUSE_OPTIONS_MS.indexOf(pauseMs) + 1) % PAUSE_OPTIONS_MS.length
                      ],
                    );
                  }}
                  disabled={busy}
                />
                <Choice
                  label={'Analyze'}
                  selected={false}
                  onPress={() => void analyze()}
                  disabled={busy || (!fillers && !quiet)}
                />
              </View>
            )}
            <View style={styles.row}>
              <CommandButton
                icon="chevron.left"
                label="Previous transcript item"
                disabled={controlsBusy || cursor <= 0 || count === 0}
                onPress={() => setCursor((n) => Math.max(0, n - 1))}
              />
              <Pressable
                style={styles.cursor}
                disabled={controlsBusy || count === 0}
                accessibilityRole="checkbox"
                accessibilityState={{
                  checked: currentSelected,
                  disabled: controlsBusy || count === 0,
                }}
                accessibilityLabel={`${currentLabel}${rangeAnchor ? ', choose the last word of the range' : ''}`}
                onPress={() => {
                  if (activeWord) toggleWord(activeWord);
                  else if (activeCandidate) toggleCandidate(activeCandidate.id);
                }}>
                <ThemedText type="footnote" numberOfLines={2} style={styles.summary}>
                  {count > 0 ? `${Math.min(cursor + 1, count)} of ${count}: ` : ''}
                  {currentLabel}
                  {currentSelected ? ' ✓' : ''}
                </ThemedText>
              </Pressable>
              <CommandButton
                icon="play.fill"
                label="Listen to current transcript item"
                disabled={controlsBusy || count === 0}
                onPress={() => {
                  if (activeWord)
                    preview(activeWord.source, activeWord.word.t0 * 10, activeWord.word.t1 * 10);
                  else if (activeCandidate)
                    preview(activeCandidate.source, activeCandidate.startMs, activeCandidate.endMs);
                }}
              />
              <CommandButton
                icon="chevron.right"
                label="Next transcript item"
                disabled={controlsBusy || cursor >= count - 1 || count === 0}
                onPress={() => setCursor((n) => Math.min(count - 1, n + 1))}
              />
            </View>
            <View style={styles.row}>
              <PrimaryButton
                label="Cancel"
                variant="card"
                disabled={applying}
                onPress={close}
                style={styles.flex}
              />
              <PrimaryButton
                label={applying ? 'Applying cuts…' : 'Apply cuts'}
                busy={applying}
                disabled={
                  controlsBusy ||
                  !requests.length ||
                  missingRate ||
                  (rangeMode && rangeAnchor !== null && mode === 'words')
                }
                onPress={() => void apply()}
                style={styles.flex}
                testID="transcript.apply"
              />
            </View>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
function Choice({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      style={[styles.choice, { backgroundColor: selected ? theme.text : theme.card }]}>
      <ThemedText
        type="footnote"
        style={{ color: selected ? theme.background : theme.text, textAlign: 'center' }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  title: { padding: 16, textAlign: 'center' },
  content: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },
  group: { gap: 8 },
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  word: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 2,
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
  choice: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 6,
    justifyContent: 'center',
  },
  summary: { textAlign: 'center' },
  cursor: { flex: 1, minHeight: 44, justifyContent: 'center' },
  candidate: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 8 },
  candidateChoice: {
    flex: 1,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  candidateText: { flex: 1 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
