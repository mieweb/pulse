import type { MenuAction } from '@/components/action-menu';
import { watchUpload } from '@/features/upload/link-actions';
import { uploads, type WatchLink } from '@/features/upload/upload-manager';

export type DraftMenuProps = {
  draftId: string;
  /** An uploading draft is LOCKED (see `assertNotUploading`): Cancel is its only action. */
  uploading: boolean;
  /** The draft's live watch link, from the card (`null` if it has none). */
  watchLink: WatchLink | null;
  onRename: () => void;
  onDelete: () => void;
  /** Sits right after the card's link button: a narrower left hit area keeps taps off it. */
  besidePill?: boolean;
};

/** The draft card's ⋯ actions, shared by the iOS system menu and the Android popover. */
export function draftMenuActions({
  draftId,
  uploading,
  watchLink,
  onRename,
  onDelete,
}: DraftMenuProps): MenuAction[] {
  // An uploaded draft whose card offers Share (a link safe to share) also gets Watch here; one
  // carrying the upload token is Watch on the card already. Only while the link still opens.
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
