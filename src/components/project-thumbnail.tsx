import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useThumbnail } from '@/hooks/use-thumbnail';

import { Icon } from './icon';

export const PROJECT_THUMB_RADIUS = Radius.card - Spacing.two;

/** The source project's cover, shared by Home and the summary picker. */
export function ProjectThumbnail({
  filename,
  thumbnail,
  editState,
  children,
}: {
  filename?: string | null;
  thumbnail?: string | null;
  editState?: string | null;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const image = useThumbnail(thumbnail, filename, editState);
  return (
    <View
      style={[
        styles.cover,
        { backgroundColor: theme.backgroundSelected, borderColor: theme.border },
      ]}>
      {image ? (
        <Image source={image} style={styles.image} contentFit="cover" accessible={false} />
      ) : (
        <Icon name="video.fill" size={18} tintColor={theme.textSecondary} />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    width: 44,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    // Children round their own corners so the cover's shadow isn't clipped.
    borderRadius: PROJECT_THUMB_RADIUS,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
  },
  image: {
    width: '100%',
    height: '100%',
    borderRadius: PROJECT_THUMB_RADIUS,
    borderCurve: 'continuous',
  },
});
