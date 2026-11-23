import { router, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';

import { anchorFromRouteParam } from '@/core/clip-anchor';
import { ScreenFocusProvider } from '@/core/navigation/focus';
import { peekRecorderPlace, takeRecorderPlace } from '@/features/recorder/link-place';
import { RecorderScreen } from '@/features/recorder/recorder-screen';
import { screenCapturePort } from '@/features/screen-capture/screen-capture';
import { usePlaceLabels } from '@/features/upload/pairing/use-destinations';
import { closeToHome } from '@/shell/standalone/navigation';

/** The stack as this route sees it: enough to tell which screen is under this one. */
type StackState = { index: number; routes: readonly { name: string; params?: object }[] };

/** Whether the screen right under the one on top is an editor for `draftId`. */
function editorBelow(state: StackState | undefined, draftId: string): boolean {
  const below = state?.routes[state.index - 1];
  return (
    below?.name === 'editor' &&
    (below.params as { draftId?: string } | undefined)?.draftId === draftId
  );
}

/**
 * The recorder route: params in, the editor and Export pushed over it, ✕ back to the screen
 * under it. Opened from an editor's Add clips (`returnTo=editor`), its Edit goes back to that
 * editor rather than pushing another one. `anchor` (`anchorToRouteParam`) is where its clips go in
 * the draft at first.
 */
export default function RecorderRoute() {
  const focused = useIsFocused();
  const navigation = useNavigation();
  const placeLabels = usePlaceLabels();
  // A link for a place opens the recorder for that place: a draft made here is recorded for it,
  // and named with the link's `name`, if it has one. The place comes from memory, never from the
  // route (see `link-place.ts`): `forLink` only says this recorder was opened for a link. A
  // recorder opened for a new draft takes a place still on offer too — the one a link paired
  // during the welcome screen left for the first recording.
  const { draftId, forLink, returnTo, anchor } = useLocalSearchParams<{
    draftId?: string;
    forLink?: string;
    returnTo?: string;
    anchor?: string;
  }>();
  const [insertAnchor] = useState(() => anchorFromRouteParam(anchor));
  const [linkPlace] = useState(() => (forLink || !draftId ? peekRecorderPlace() : null));
  useEffect(() => {
    if (linkPlace) takeRecorderPlace(linkPlace);
  }, [linkPlace]);
  const [newDraft] = useState(() => ({
    name: linkPlace?.name ?? null,
    context: linkPlace?.context ?? null,
  }));
  return (
    <ScreenFocusProvider focused={focused}>
      <RecorderScreen
        draftId={draftId}
        newDraft={newDraft}
        onEdit={(id, clipId) =>
          // Back to the editor underneath, as it was (it shows the new clips; a tapped clip isn't
          // passed back). Without that editor right under it (a restored stack, or a link that
          // says returnTo=editor over Home), a new editor.
          returnTo === 'editor' && editorBelow(navigation.getState(), id)
            ? router.back()
            : router.push({
                pathname: '/editor',
                params: clipId ? { draftId: id, clipId } : { draftId: id },
              })
        }
        onExport={(id) => router.push({ pathname: '/export', params: { draftId: id } })}
        // Back to the screen underneath: the editor when it opened this recorder (the flow carries
        // on there, with the new clips), else Home.
        onClose={closeToHome}
        // Screen recording is the Pulse app's: the embed's recorder has no Record screen.
        screenCapture={screenCapturePort}
        insertAnchor={insertAnchor}
        placeLabels={placeLabels}
      />
    </ScreenFocusProvider>
  );
}
