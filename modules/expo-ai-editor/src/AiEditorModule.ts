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

type AiEditor = {
  availability(): Promise<AiEditorAvailability>;
  selectPassages(
    passages: AiEditorPassage[],
    targetDurationMs: number,
  ): Promise<AiEditorSelection>;
  cancel(): Promise<void>;
};

type NativeAiEditor = {
  availability(): Promise<AiEditorAvailability>;
  selectPassages(
    passages: AiEditorPassage[],
    targetDurationMs: number,
    requestId: string,
  ): Promise<AiEditorSelection>;
  cancel(requestId: string): Promise<void>;
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

const requestPrefix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let requestSequence = 0;
let activeRequest: { id: string; promise: Promise<AiEditorSelection> } | null = null;

const aiEditor: AiEditor = {
  async availability() {
    return native ? native.availability() : unavailable;
  },
  async selectPassages(passages, targetDurationMs) {
    if (!native) {
      throw Object.assign(new Error(unavailable.message), {
        code: 'ERR_AI_UNAVAILABLE',
      });
    }
    if (activeRequest) {
      throw Object.assign(new Error('An on-device selection is already running.'), {
        code: 'ERR_AI_BUSY',
      });
    }
    const id = `${requestPrefix}-${++requestSequence}`;
    // Publish the ID before crossing the bridge. Native actor tasks may register
    // cancellation before selection, so both operations carry the same ID.
    const request = {
      id,
      promise: Promise.resolve().then(() =>
        native.selectPassages(passages, targetDurationMs, id),
      ),
    };
    activeRequest = request;
    try {
      return await request.promise;
    } finally {
      if (activeRequest === request) activeRequest = null;
    }
  },
  async cancel() {
    const request = activeRequest;
    if (!native || !request) return;
    try {
      await native.cancel(request.id);
    } finally {
      // Native may only have recorded a cancellation tombstone so far. Wait for
      // the corresponding selection to observe it before allowing the next call.
      await request.promise.catch(() => {});
    }
  },
};

export default aiEditor;
