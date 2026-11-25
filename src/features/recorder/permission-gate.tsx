import { Icon } from '@/components/icon';
import { StyleSheet, View } from 'react-native';
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
    <ThemedView
      style={[
        styles.container,
        { paddingTop: insets.top, paddingBottom: insets.bottom + Spacing.three },
      ]}>
      <View style={styles.message}>
        <Icon name="camera.fill" size={48} tintColor={theme.accent} scalesWithText />
        <ThemedText type="title3" style={styles.title}>
          Camera access needed
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.body}>
          Pulse records video with your camera and microphone.
        </ThemedText>
      </View>
      <View style={styles.footer}>
        <CloseButton label="Close recorder" testID="permission.close" />
        <PrimaryButton
          label={blocked ? 'Open Settings' : 'Allow access'}
          onPress={onRequest}
          style={styles.button}
          testID="permission.request"
        />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three },
  footer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  // Same heading as the home empty state.
  title: { fontWeight: '600' },
  body: { textAlign: 'center' },
  // Full width, like the app's other primary actions (export, captions, About).
  button: { flex: 1 },
});
