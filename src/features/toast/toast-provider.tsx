import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { Toast, type ToastContent, type ToastKind } from '@/components/toast';

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
/** The exit animation's length; the toast unmounts after it. */
const EXIT_MS = 220;

/**
 * Why a toast went away: its `action` was tapped, it timed out, the person dismissed it (tap,
 * swipe, VoiceOver escape), or another toast replaced it.
 */
export type ToastCloseReason = 'action' | 'timeout' | 'dismissed' | 'replaced';

export type ToastOptions = Omit<ToastContent, 'kind'> & {
  kind?: ToastKind;
  /** Overrides the reading-time default (`durationFor`). */
  duration?: number;
  /** Called exactly once when this toast goes away, with why. */
  onClose?: (reason: ToastCloseReason) => void;
};

/**
 * An optimistic action with an Undo: the caller has already applied it on screen. `onUndo` puts
 * it back if Undo is tapped; `onCommit` makes it permanent once the toast goes any other way
 * (times out, is dismissed, or is replaced by another toast).
 */
export type UndoToastOptions = {
  title: string;
  message?: string;
  onUndo: () => void;
  onCommit: () => void;
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

type ToastContextValue = {
  showToast: ShowToast;
  showUndoToast: (options: UndoToastOptions) => void;
};

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
 * shown at a time; a new call replaces whatever's currently up rather than queuing. Tapping a
 * toast or swiping it up dismisses it early; holding it keeps it up.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ id: number; content: ToastContent } | null>(null);
  // The up toast's `onClose`, called once (then cleared) whichever way it goes.
  const onCloseRef = useRef<ToastOptions['onClose']>(undefined);
  const close = useCallback((reason: ToastCloseReason) => {
    const onClose = onCloseRef.current;
    onCloseRef.current = undefined;
    onClose?.(reason);
  }, []);
  const [leaving, setLeaving] = useState(false);
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
    (id: number, reason: ToastCloseReason = 'dismissed') => {
      if (id !== currentId.current) return;
      close(reason);
      clearTimers();
      setLeaving(true);
      timers.current.push(setTimeout(() => setToast(null), EXIT_MS));
    },
    [clearTimers, close],
  );

  // A finger on the toast holds it; letting go (not swiping it away) gives a little more.
  const hold = useCallback(
    (id: number) => {
      if (id === currentId.current) clearTimers();
    },
    [clearTimers],
  );
  const release = useCallback(
    (id: number) => {
      if (id === currentId.current)
        timers.current.push(setTimeout(() => dismiss(id), AFTER_HOLD_MS));
    },
    [dismiss],
  );

  const showToast = useCallback<ShowToast>(
    (input: ToastOptions | string, kind?: ToastKind) => {
      const { kind: k = 'success', duration, onClose, ...rest } = toOptions(input, kind);
      const content = { ...rest, kind: k };
      close('replaced');
      onCloseRef.current = onClose;
      const id = ++nextId.current;
      currentId.current = id;
      clearTimers();
      setLeaving(false);
      setToast({ id, content });
      timers.current.push(
        setTimeout(() => dismiss(id, 'timeout'), duration ?? durationFor(content)),
      );
    },
    [clearTimers, close, dismiss],
  );

  const showUndoToast = useCallback(
    ({ title, message, onUndo, onCommit }: UndoToastOptions) =>
      showToast({
        kind: 'info',
        title,
        message,
        action: { label: 'Undo', onPress: onUndo },
        onClose: (reason) => {
          if (reason !== 'action') onCommit();
        },
      }),
    [showToast],
  );

  // Leaving the app's root (a reload) commits whatever is pending rather than dropping it.
  useEffect(
    () => () => {
      clearTimers();
      close('replaced');
    },
    [clearTimers, close],
  );

  return (
    <ToastContext.Provider value={{ showToast, showUndoToast }}>
      {children}
      {toast && (
        // Keyed by id: a replacing toast animates in fresh instead of reusing the old one.
        <ToastSurface
          key={toast.id}
          id={toast.id}
          content={toast.content}
          leaving={leaving}
          onDismiss={dismiss}
          onHold={hold}
          onRelease={release}
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
