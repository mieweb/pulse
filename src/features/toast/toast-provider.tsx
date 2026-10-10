import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { Toast, type ToastContent, type ToastKind } from '@/components/toast';
import { haptics } from '@/utils/haptics';

/**
 * How long a toast stays up, from how much there is to read: a base plus reading time per
 * character, kept within bounds. Errors get a beat longer (they're re-read), and a toast with an
 * action long enough to reach it. "Saved to Photos" ≈ 2.3 s; a title with a detail line ≈ 4–5 s.
 */
const BASE_MS = 1500;
const PER_CHAR_MS = 50;
const MIN_MS = 2000;
const MAX_MS = 6000;
const ERROR_EXTRA_MS = 1000;
const ACTION_MIN_MS = 4000;
/** After a finger lets go of a toast it didn't swipe away. */
const AFTER_HOLD_MS = 2000;

function durationFor({ kind, title, message, action }: ToastContent): number {
  const chars = title.length + (message?.length ?? 0);
  let ms = Math.min(MAX_MS, Math.max(MIN_MS, BASE_MS + chars * PER_CHAR_MS));
  if (kind === 'error') ms += ERROR_EXTRA_MS;
  if (action) ms = Math.max(ms, ACTION_MIN_MS);
  return ms;
}

/** The outcome kinds have a notification haptic; `info` is quiet. */
const HAPTICS: Record<ToastKind, (() => void) | undefined> = {
  success: haptics.success,
  info: undefined,
  warning: haptics.warning,
  error: haptics.error,
};

export type ToastOptions = Omit<ToastContent, 'kind'> & {
  kind?: ToastKind;
  /** Overrides the reading-time default (`durationFor`). */
  duration?: number;
};

/**
 * `showToast(options)`, or the short form `showToast('Title — detail', kind)`: a title, then
 * optionally " — " and the detail, which becomes the second line (so callers that build one
 * string, like the upload manager, still get the two-line layout).
 */
type ShowToast = {
  (options: ToastOptions): void;
  (text: string, kind?: ToastKind): void;
};

type ToastContextValue = { showToast: ShowToast };

const ToastContext = createContext<ToastContextValue | null>(null);

function toOptions(input: ToastOptions | string, kind?: ToastKind): ToastOptions {
  if (typeof input !== 'string') return input;
  const split = input.indexOf(' — ');
  if (split < 0) return { kind, title: input };
  const detail = input.slice(split + 3).trim();
  return {
    kind,
    title: input.slice(0, split),
    message: detail.charAt(0).toUpperCase() + detail.slice(1),
  };
}

/**
 * On iOS the toast renders inside `FullWindowOverlay`: screens presented as `fullScreenModal`
 * (recorder, export) are real UIKit modal presentations layered above the entire RN root view, so
 * a root-level sibling — any zIndex — paints behind them. The overlay is its own UIWindow above
 * every presentation, which is what lets e.g. export's "Link copied" show over the modal.
 * Android's modals stay in the same native hierarchy, so the plain sibling suffices.
 */
function ToastSurface(props: React.ComponentProps<typeof Toast>) {
  const toast = <Toast {...props} />;
  if (Platform.OS === 'ios') {
    return <FullWindowOverlay>{toast}</FullWindowOverlay>;
  }
  return toast;
}

/**
 * Mounts the single global toast surface, matching `UploadDeepLinkProvider`'s pattern — a
 * provider near the root so any screen (or a provider above all screens, like the deep-link
 * handler) can fire a transient banner without needing its own mount point. Only one toast is
 * shown at a time; a new call replaces whatever's currently up rather than queuing (the banner
 * stays and its content changes). Tapping a toast or swiping it up dismisses it early; holding it
 * keeps it up. A toast unmounts once `Toast` reports its exit finished.
 *
 * With a screen reader on, a toast with an action stays until it's used, dismissed or
 * replaced: a few seconds isn't long enough to find and reach the button by swiping through the
 * screen. That's what Android's own Snackbar does with TalkBack on. Without an action there's
 * nothing to reach, and the announcement has already read it out.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ id: number; content: ToastContent } | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The same, for callbacks: a toast on its way out can't be held, released or dismissed again.
  const leavingRef = useRef(false);
  // The up toast waits for the person rather than a timer (see above).
  const persistent = useRef(false);
  // How many touches are holding the up toast (see `hold`).
  const holds = useRef(0);
  const screenReader = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextId = useRef(0);
  // The toast that's up. A toast's own callbacks (tap, swipe, hold, action) name it, so one that
  // has just been replaced can't dismiss or shorten its replacement.
  const currentId = useRef(0);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      if (id !== currentId.current || leavingRef.current) return;
      clearTimers();
      leavingRef.current = true;
      setLeaving(true);
    },
    [clearTimers],
  );

  // The exit has played (or the swipe threw it off screen): unmount, unless a newer toast has
  // taken the surface over in the meantime.
  const exited = useCallback((id: number) => {
    if (id === currentId.current) setToast(null);
  }, []);

  // A finger on the toast holds it; letting go (not swiping it away) gives a little more. The
  // press and the swipe can both be holding it (a drag cancels the press it began as, in either
  // order), so it's released when the last one lets go. Not once it's leaving: holding an exit
  // would only cancel its unmount, not bring it back.
  const hold = useCallback(
    (id: number) => {
      if (id !== currentId.current || leavingRef.current) return;
      holds.current += 1;
      clearTimers();
    },
    [clearTimers],
  );
  const release = useCallback(
    (id: number) => {
      if (id !== currentId.current || leavingRef.current || holds.current === 0) return;
      holds.current -= 1;
      if (holds.current > 0 || persistent.current) return;
      timers.current.push(setTimeout(() => dismiss(id), AFTER_HOLD_MS));
    },
    [dismiss],
  );

  const showToast = useCallback<ShowToast>(
    (input: ToastOptions | string, kind?: ToastKind) => {
      const { kind: k = 'success', duration, ...rest } = toOptions(input, kind);
      const content = { ...rest, kind: k };
      const id = ++nextId.current;
      currentId.current = id;
      clearTimers();
      leavingRef.current = false;
      // A replacement starts unheld: a finger still on the banner was holding the old toast.
      holds.current = 0;
      setLeaving(false);
      setToast({ id, content });
      HAPTICS[content.kind]?.();
      persistent.current = !!content.action && screenReader.current;
      if (!persistent.current) {
        timers.current.push(setTimeout(() => dismiss(id), duration ?? durationFor(content)));
      }
    },
    [clearTimers, dismiss],
  );

  // Cached so `showToast` can decide synchronously; kept current as it's switched on and off.
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (live) screenReader.current = on;
    });
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => {
      screenReader.current = on;
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        // Not keyed by id: a replacement reuses the banner that's up (or on its way out), so
        // "Retry" → "Retrying…" changes in place instead of blanking and dropping in again.
        <ToastSurface
          id={toast.id}
          content={toast.content}
          leaving={leaving}
          onDismiss={dismiss}
          onHold={hold}
          onRelease={release}
          onExited={exited}
        />
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
