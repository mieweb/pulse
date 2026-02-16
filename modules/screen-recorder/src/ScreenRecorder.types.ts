export type RecordingState = 'idle' | 'recording' | 'processing';

export interface ScreenRecorderResult {
  success: boolean;
  filePath?: string;
  error?: string;
}
