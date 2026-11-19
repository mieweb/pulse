import { router, useIsFocused } from 'expo-router';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import { DraftsScreen } from '@/features/drafts/drafts-screen';
import { useOnboardingRedirect } from '@/features/onboarding/use-onboarding-redirect';

const record = () => router.push('/recorder');
const openDraft = (draftId: string) => router.push({ pathname: '/recorder', params: { draftId } });
const openAbout = () => router.push('/about');

/**
 * Home's route: the drafts screen with its exits mapped to router pushes, told whether it is the
 * one on top. First run pushes the welcome over it (onboarding is standalone only).
 */
export default function HomeRoute() {
  useOnboardingRedirect();
  const focused = useIsFocused();
  return (
    <ScreenFocusProvider focused={focused}>
      <DraftsScreen onRecord={record} onOpenDraft={openDraft} onAbout={openAbout} />
    </ScreenFocusProvider>
  );
}
