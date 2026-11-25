import { router } from 'expo-router';

import { NewProjectScreen } from '@/features/project-summary/new-project-screen';
import { closeToHome } from '@/shell/standalone/navigation';

const startBlank = () => router.replace('/recorder');
const openProject = (draftId: string) =>
  router.replace({ pathname: '/recorder', params: { draftId } });
const reviewSummary = (draftId: string) =>
  router.push({ pathname: '/editor', params: { draftId } });

export default function NewProjectRoute() {
  return (
    <NewProjectScreen
      onClose={closeToHome}
      onBlankProject={startBlank}
      onCreated={openProject}
      onOpenSummary={reviewSummary}
    />
  );
}
