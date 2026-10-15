import { installJsi } from 'whisper.rn';

let installing: Promise<void> | null = null;

/**
 * whisper.rn's JSI functions, installed once for the app; awaited before any whisper.rn context is
 * created (speech model and VAD alike).
 *
 * whisper.rn installs them on the first `init*` call, and two first calls at once can fail: each
 * awaits the native install, then the first takes the functions off `global` and the second finds
 * them gone ("[RNWhisper] Missing JSI bindings: …", every name missing; seen on a cold launch).
 * One install shared by every caller rules that out, and the error is retried once anyway — a
 * second `installJsi` installs them natively again when they're gone (whisper.rn's index.ts), and
 * returns at once if another call bound them meanwhile. A failure clears the shared install, so
 * the next caller tries again rather than inheriting it.
 */
export function whisperJsiReady(): Promise<void> {
  installing ??= installWithRetry().catch((e: unknown) => {
    installing = null;
    throw e;
  });
  return installing;
}

async function installWithRetry(): Promise<void> {
  try {
    await installJsi();
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('Missing JSI bindings'))) throw e;
    await installJsi();
  }
}
