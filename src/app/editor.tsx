import { router, useIsFocused, useLocalSearchParams } from 'expo-router';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import type { EditorView } from '@/db/settings';
import { EditorScreen } from '@/features/editor/editor-screen';

/** Back to the recorder (or Home, when the editor was opened by a link). */
const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
const openExport = (draftId: string) => router.push({ pathname: '/export', params: { draftId } });
const openModelSheet = () => router.push('/on-device-ai');

const asView = (v: string | undefined): EditorView | undefined =>
  v === 'clips' || v === 'timeline' ? v : undefined;

/**
 * The editor route: reads the params, maps the screen's exits to router pushes (stable, so a
 * re-render never hands the screen new callbacks) and tells it whether it is the one on top.
 */
export default function EditorRoute() {
  const { draftId, clipId, view } = useLocalSearchParams<{
    draftId: string;
    clipId?: string;
    view?: string;
  }>();
  const focused = useIsFocused();
  return (
    <ScreenFocusProvider focused={focused}>
      <EditorScreen
        draftId={draftId}
        clipId={clipId}
        view={asView(view)}
        onClose={close}
        onExport={openExport}
        onOpenModelSheet={openModelSheet}
      />
    </ScreenFocusProvider>
  );
}
