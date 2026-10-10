import { Icon } from '@/components/icon';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CloseButton } from './close-button';

export function PermissionGate({
  blocked,
  onRequest,
}: {
  blocked: boolean;
  onRequest: () => void;
}) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
      <CloseButton
        // Same spot as the recorder's ✕ (insets.top + two, three in), so it doesn't hop when
        // access is granted and the camera takes over.
        style={{ position: 'absolute', top: insets.top + Spacing.two, left: Spacing.three }}
      />
      <Icon name="camera.fill" size={48} tintColor={theme.accent} />
      <ThemedText type="title3" style={styles.title}>
        Camera access needed
      </ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.body}>
        Pulse records video with your camera and microphone.
      </ThemedText>
      <PrimaryButton
        label={blocked ? 'Open Settings' : 'Allow access'}
        onPress={onRequest}
        style={styles.button}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
  },
  // Same heading as the home empty state.
  title: { fontWeight: '600' },
  body: { textAlign: 'center' },
  // Full width, like the app's other primary actions (export, captions, About).
  button: { marginTop: Spacing.two, alignSelf: 'stretch' },
});
