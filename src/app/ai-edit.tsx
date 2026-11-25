import { Redirect, router, useIsFocused, useLocalSearchParams } from 'expo-router';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import { setEditorView } from '@/db/settings';
import { AiEditScreen } from '@/features/ai-edit/ai-edit-screen';
import { isAiEditingEnabled } from '@/features/ai-edit/enabled';

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
const openModels = () => router.push('/on-device-ai');
const openResult = (draftId: string) => {
  void setEditorView('timeline')
    .catch(() => {})
    .finally(() => router.replace({ pathname: '/editor', params: { draftId, view: 'timeline' } }));
};

export default function AiEditRoute() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const focused = useIsFocused();
  if (!isAiEditingEnabled() || !draftId) return <Redirect href="/" />;
  return (
    <ScreenFocusProvider focused={focused}>
      <AiEditScreen
        draftId={draftId}
        onClose={close}
        onResult={openResult}
        onOpenModels={openModels}
      />
    </ScreenFocusProvider>
  );
}
