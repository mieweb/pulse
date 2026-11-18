import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import { peekRecorderPlace, takeRecorderPlace } from '@/features/recorder/link-place';
import { RecorderScreen } from '@/features/recorder/recorder-screen';
import { closeToHome } from '@/shell/standalone/navigation';

/**
 * The recorder route: params in, the editor and Export pushed over it, ✕ back home. Opened from an
 * editor's Add clips (`returnTo=editor`), its Edit goes back to that editor rather than pushing
 * another one.
 */
export default function RecorderRoute() {
  const focused = useIsFocused();
  // A link for a place opens the recorder for that place: a draft made here is recorded for it,
  // and named with the link's `name`, if it has one. The place comes from memory, never from the
  // route (see `link-place.ts`): `forLink` only says this recorder was opened for a link. A
  // recorder opened for a new draft takes a place still on offer too — the one a link paired
  // during the welcome screen left for the first recording.
  const { draftId, forLink, returnTo } = useLocalSearchParams<{
    draftId?: string;
    forLink?: string;
    returnTo?: string;
  }>();
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
          // passed back). Without one under it (a restored stack), a new editor.
          returnTo === 'editor' && router.canGoBack()
            ? router.back()
            : router.push({
                pathname: '/editor',
                params: clipId ? { draftId: id, clipId } : { draftId: id },
              })
        }
        onExport={(id) => router.push({ pathname: '/export', params: { draftId: id } })}
        onClose={closeToHome}
      />
    </ScreenFocusProvider>
  );
}
