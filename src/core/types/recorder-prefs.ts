// Recorder preference shapes shared by the database (`src/db/settings.ts`) and the recorder
// feature. They live in core so the database layer never imports a feature module.

/** Video stabilization. 'cinematic' is an iOS-only AVCaptureVideoStabilizationMode; the union keeps
 * it on both platforms so persisted iOS prefs and shared UI maps still typecheck. */
export type StabilizationMode = 'off' | 'standard' | 'cinematic' | 'auto';

/** Which camera the recorder is pointed at. Mirrors VisionCamera's `CameraPosition`,
 * declared locally so the rest of the app doesn't import the camera SDK for a string union. */
export type CameraFacing = 'front' | 'back';
