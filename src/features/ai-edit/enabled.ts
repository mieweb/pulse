import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { aiEditingEnabled, type DeveloperFeatures } from './feature-flag';

export function isAiEditingEnabled(): boolean {
  return (
    Platform.OS === 'ios' &&
    aiEditingEnabled(__DEV__, Constants.expoConfig?.extra?.developerFeatures as DeveloperFeatures)
  );
}
