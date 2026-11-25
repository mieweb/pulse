import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type AiEditorAvailability = {
  available: boolean;
  reason:
    | 'available'
    | 'ios_version'
    | 'simulator'
    | 'unsupported_platform'
    | 'device_not_eligible'
    | 'apple_intelligence_disabled'
    | 'model_not_ready'
    | 'native_module_missing'
    | 'unavailable';
  message: string;
};

export type AiEditorPassage = {
  id: string;
  text: string;
  durationMs: number;
};

export type AiEditorSelection = {
  selectedIds: string[];
};

type NativeAiEditor = {
  availability(): Promise<AiEditorAvailability>;
  selectPassages(
    passages: AiEditorPassage[],
    targetDurationMs: number,
  ): Promise<AiEditorSelection>;
  cancel(): Promise<void>;
};

// This module is deliberately optional: the existing app and unsupported platforms
// remain usable before a native rebuild or without Apple Intelligence.
const native =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeAiEditor>('AiEditor')
    : null;

const unavailable: AiEditorAvailability =
  Platform.OS === 'ios'
    ? {
        available: false,
        reason: 'native_module_missing',
        message: 'Rebuild the iOS app to include the on-device AI editor.',
      }
    : {
        available: false,
        reason: 'unsupported_platform',
        message: 'The on-device AI editor requires an eligible iPhone with iOS 26 or later.',
      };

const aiEditor: NativeAiEditor = {
  async availability() {
    return native ? native.availability() : unavailable;
  },
  async selectPassages(passages, targetDurationMs) {
    if (!native) {
      throw Object.assign(new Error(unavailable.message), {
        code: 'ERR_AI_UNAVAILABLE',
      });
    }
    return native.selectPassages(passages, targetDurationMs);
  },
  async cancel() {
    await native?.cancel();
  },
};

export default aiEditor;
