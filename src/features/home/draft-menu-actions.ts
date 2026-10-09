import type { MenuAction } from '@/components/action-menu';
import { watchUpload } from '@/features/upload/link-actions';
import { uploads } from '@/features/upload/upload-manager';
import { useWatchLink } from '@/features/upload/use-uploads';

export type DraftMenuProps = {
  draftId: string;
  /** An uploading draft is LOCKED (see `assertNotUploading`): Cancel is its only action. */
  uploading: boolean;
  onRename: () => void;
  onDelete: () => void;
  /** Sits right after the card's link pill: a narrower left hit area keeps taps off the pill. */
  besidePill?: boolean;
};

/** The draft card's ⋯ actions, shared by the iOS system menu and the Android popover. */
export function useDraftMenuActions({
  draftId,
  uploading,
  onRename,
  onDelete,
}: DraftMenuProps): MenuAction[] {
  // An uploaded draft whose card offers Share (a link safe to share) also gets Watch here; one
  // carrying the upload token is Watch on the card already. Only while the link still opens.
  const watchLink = useWatchLink(draftId);
  if (uploading) {
    return [
      {
        key: 'cancel-upload',
        label: 'Cancel upload',
        icon: 'xmark',
        onPress: () => void uploads.cancel(draftId),
      },
    ];
  }
  return [
    ...(watchLink?.shareable
      ? [
          {
            key: 'watch',
            label: 'Watch',
            icon: 'play.fill',
            onPress: () => void watchUpload(watchLink.url),
          } satisfies MenuAction,
        ]
      : []),
    { key: 'rename', label: 'Rename', icon: 'pencil', onPress: onRename },
    { key: 'delete', label: 'Delete', icon: 'trash', destructive: true, onPress: onDelete },
  ];
}
