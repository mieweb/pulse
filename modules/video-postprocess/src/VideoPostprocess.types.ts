export interface PostprocessProgress {
  progress: number;  // 0-1
  phase: 'analyzing' | 'removing_silence' | 'adjusting_speed' | 'finalizing';
}

export interface VideoPostprocessModuleEvents {
  [key: string]: (params: any) => void;  // Add index signature
  onProgress: (event: PostprocessProgress) => void;
}

export interface PostprocessOptions {
  speedFactor?: number;  // 1.0-2.0, default 1.15
  silenceThreshold?: number;  // dB, default -40
  minSilenceDuration?: number;  // ms, default 500
}
