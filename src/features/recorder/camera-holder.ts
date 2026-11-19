/**
 * Which recorder's <Camera> bound the camera last. On Android every VisionCamera session shares
 * CameraX's one process-wide provider, and a session's configure (and its teardown) starts with
 * `unbindAll()`: a recorder opened over another one (the editor's Add clips) unbinds the camera of
 * the recorder underneath. Back on top, that recorder only restarts a session with nothing bound to
 * it, and the camera never opens. So a recorder that no longer holds the camera when it comes back
 * mounts a new <Camera>, which binds again. (iOS gives each session its own capture session.)
 */
let holder: object | null = null;

/** `owner`'s camera has just mounted: it holds the camera now. */
export function takeCamera(owner: object): void {
  holder = owner;
}

/** `owner` unmounts. Whatever it bound is unbound with it, so nobody holds the camera. */
export function releaseCamera(owner: object): void {
  if (holder === owner) holder = null;
}

/** Whether nobody took the camera since `owner` did. Reading it changes nothing. */
export function holdsCamera(owner: object): boolean {
  return holder === owner;
}
