import type { ConfigureOptions, PulseErrorInfo } from '@mieweb/pulse-embed';
import {
  Component,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Alert, BackHandler, StyleSheet, View } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import { EditorScreen } from '@/features/editor/editor-screen';
import type { ExportPolicy, ExportPrimaryAction } from '@/features/export/contract';
import { ExportScreen } from '@/features/export/export-screen';
import type { RecorderCloseResult, RecorderNewDraft } from '@/features/recorder/contract';
import { RecorderScreen } from '@/features/recorder/recorder-screen';
import { OnDeviceAiSheet } from '@/features/transcription/on-device-ai-sheet';
import { tallSheetFits } from '@/utils/sheet-fit';

import type { FlowController } from './flow-controller';
import type { FlowStore, StackItem } from './flow-store';
import type { UiSender } from './messaging';
import { EmbedStatusBar } from './status-bar';

/**
 * The embed's screens (N3, AD1): a react-native-screens ScreenStack driven by the flow reducer,
 * with no navigator and no router. The reducer's stack is the truth; each item stays mounted while
 * it is in the stack (the recorder keeps its draft under the editor) and only the top one is
 * focused, through the same focus port the standalone routes feed. Screens appear at once, with
 * no animation and no swipe-back: Pulse is one full-screen task, and every exit goes through the
 * reducer. The captions-model sheet is the one item the reducer doesn't know: a form sheet over
 * the editor, as in the app.
 */
const NEW_DRAFT: RecorderNewDraft = { name: null, context: null };

/** Final copy is the P0.3 mock's (Q23); these are its working words. */
const COPY = {
  useVideo: 'Use this video',
  exitTitle: 'Keep this video?',
  keep: 'Keep draft',
  discard: 'Discard video',
  cancel: 'Cancel',
};

export function FlowStack({
  store,
  controller,
  config,
  ui,
  onMissingDraft,
  draftId: openedDraftId,
}: {
  store: FlowStore;
  controller: FlowController;
  config: ConfigureOptions;
  ui: UiSender;
  /** The draft the entry names isn't in the library: the request ends before any screen. */
  onMissingDraft: () => void;
  /** The draft the entry opens (edit, export, record continue). */
  draftId: string | null;
}) {
  // Before the first read of the store: the opened draft's clips count from the first frame.
  const [found] = useState(() => controller.attach(openedDraftId));
  const { state, items } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [modelSheet, setModelSheet] = useState(false);

  useEffect(() => {
    if (!found) onMissingDraft();
  }, [found, onMissingDraft]);

  // The first screen drew; from now on the library's changes to the draft reach the reducer.
  useEffect(() => {
    if (!found) return;
    store.dispatch({ type: 'mounted' });
    return controller.watch();
  }, [found, store, controller]);

  // A take would be lost if the flow ended now: the container turns swipe-to-dismiss off, and
  // ends the flow `closed` itself if Pulse can't (native-bridge.md, pulse.ui).
  const hasTake = state.end === null && state.draftId !== null && state.clipCount > 0;
  useEffect(() => ui({ hasTake }), [ui, hasTake]);

  // The keep/discard sheet: X with a take on a draft this flow made.
  useEffect(() => {
    if (state.sheet !== 'exit') return;
    Alert.alert(
      COPY.exitTitle,
      undefined,
      [
        { text: COPY.keep, onPress: () => store.dispatch({ type: 'keep' }) },
        {
          text: COPY.discard,
          style: 'destructive',
          onPress: () => store.dispatch({ type: 'discard' }),
        },
        {
          text: COPY.cancel,
          style: 'cancel',
          onPress: () => store.dispatch({ type: 'dismissSheet' }),
        },
      ],
      { cancelable: true, onDismiss: () => store.dispatch({ type: 'dismissSheet' }) },
    );
  }, [state.sheet, store]);

  // Android back: closes the model sheet, else one screen down, X at the root. Always handled:
  // the host is under Pulse, and leaving goes through the flow's result.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (modelSheet) setModelSheet(false);
      else void controller.back();
      return true;
    });
    return () => sub.remove();
  }, [modelSheet, controller]);

  // The VoiceOver escape (two-finger Z) means X; over a sheet it closes the sheet.
  const onEscape = useCallback(() => {
    if (modelSheet) setModelSheet(false);
    else if (store.state().sheet) store.dispatch({ type: 'dismissSheet' });
    else void controller.close();
  }, [modelSheet, store, controller]);

  const openModelSheet = useCallback(() => setModelSheet(true), []);
  const closeModelSheet = useCallback(() => setModelSheet(false), []);

  if (!found) return null;
  const top = items.length - 1;
  return (
    <View style={styles.fill} onAccessibilityEscape={onEscape}>
      <EmbedStatusBar ui={ui} />
      <FlowErrorBoundary onError={controller.fail}>
        <ScreenStack style={styles.fill}>
          {items.map((item, i) => (
            <ScreenStackItem
              key={item.key}
              screenId={item.key}
              activityState={2}
              style={StyleSheet.absoluteFill}
              stackPresentation="push"
              stackAnimation="none"
              gestureEnabled={false}
              nativeBackButtonDismissalEnabled={false}
              headerConfig={{ hidden: true }}
              // Gestures are off, but UIKit can still pop a screen on its own: fold it back into
              // the reducer (as spike S2 does) so the stack and the flow never disagree.
              onDismissed={() => void controller.nativePopped(item.key)}>
              <ScreenFocusProvider focused={i === top && !modelSheet}>
                <FlowScreen
                  item={item}
                  draftId={state.draftId}
                  store={store}
                  controller={controller}
                  config={config}
                  onOpenModelSheet={openModelSheet}
                />
              </ScreenFocusProvider>
            </ScreenStackItem>
          ))}
          {modelSheet ? (
            <ScreenStackItem
              key="captions-model"
              screenId="captions-model"
              activityState={2}
              style={StyleSheet.absoluteFill}
              stackPresentation="formSheet"
              // Sized to its content, or full height and scrolling at large text sizes.
              sheetAllowedDetents={tallSheetFits() ? 'fitToContents' : [1]}
              sheetGrabberVisible
              headerConfig={{ hidden: true }}
              onDismissed={closeModelSheet}>
              <OnDeviceAiSheet onDismiss={closeModelSheet} />
            </ScreenStackItem>
          ) : null}
        </ScreenStack>
      </FlowErrorBoundary>
    </View>
  );
}

/** One stack item's screen, its exits mapped to reducer events. */
function FlowScreen({
  item,
  draftId,
  store,
  controller,
  config,
  onOpenModelSheet,
}: {
  item: StackItem;
  draftId: string | null;
  store: FlowStore;
  controller: FlowController;
  config: ConfigureOptions;
  onOpenModelSheet: () => void;
}) {
  // The recorder's exits come after its take is saved and its pending writes are stored, so the
  // library is current: read the draft it names, then move.
  const recorderEdit = useCallback(
    (id: string, clipId?: string) => {
      controller.observe(id);
      store.dispatch({ type: 'edit' }, { clipId });
    },
    [controller, store],
  );
  // Export goes through the editor (recorder ⇄ editor → export), which stays under it.
  const recorderExport = useCallback(
    (id: string) => {
      controller.observe(id);
      store.dispatch({ type: 'edit' });
      store.dispatch({ type: 'export' });
    },
    [controller, store],
  );
  const recorderClose = useCallback(
    ({ draftId: id }: RecorderCloseResult) => {
      controller.observe(id);
      store.dispatch({ type: 'back' });
    },
    [controller, store],
  );
  const editorClose = useCallback(() => void controller.back(), [controller]);
  const editorExport = useCallback(() => {
    controller.observe();
    store.dispatch({ type: 'export' });
  }, [controller, store]);
  const editorAddClips = useCallback(() => store.dispatch({ type: 'addClips' }), [store]);
  const exportClose = useCallback(() => store.dispatch({ type: 'back' }), [store]);
  const [primaryAction] = useState<ExportPrimaryAction>(() => ({
    kind: 'use-video',
    label: COPY.useVideo,
    onUse: (video) => void controller.useVideo(video),
  }));
  const [policy] = useState<ExportPolicy>(() => ({
    allowShare: config.policy?.allowShare !== false,
    allowSaveToPhotos: config.policy?.allowSaveToPhotos !== false,
  }));

  switch (item.screen) {
    case 'recorder':
      return (
        <RecorderScreen
          // Read once, as it mounts: a new recording has none until its first take.
          draftId={draftId ?? undefined}
          newDraft={NEW_DRAFT}
          onEdit={recorderEdit}
          onExport={recorderExport}
          onClose={recorderClose}
        />
      );
    case 'editor':
      return draftId ? (
        <EditorScreen
          draftId={draftId}
          clipId={item.clipId}
          onClose={editorClose}
          onExport={editorExport}
          onAddClips={editorAddClips}
          onOpenModelSheet={onOpenModelSheet}
        />
      ) : null;
    case 'export':
      return draftId ? (
        <ExportScreen
          draftId={draftId}
          primaryAction={primaryAction}
          policy={policy}
          onClose={exportClose}
        />
      ) : null;
  }
}

/**
 * A JS error in a screen ends the flow `failed{runtime.error}`, with the draft kept when it has a
 * clip, instead of taking the runtime down: the host keeps running and the next open is fresh.
 * `onError` (the controller's `fail`) lets a take in flight finish saving first, for a few seconds
 * at most. Whether a recorder the boundary has just unmounted still finishes its take is a device
 * check (PR1-L nativeCheck "debug throw isolated", while recording).
 */
class FlowErrorBoundary extends Component<
  {
    onError: (error: Omit<PulseErrorInfo, 'callId' | 'recoverable'>) => Promise<void>;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[embed] a screen failed', error);
    void this.props.onError({
      code: 'runtime.error',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
