import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { Toast, type ToastKind } from '@/components/toast';

const TOAST_DURATION_MS = 3500;

/** `error` for failures — without it a failure would carry the success checkmark. */
type ToastContextValue = { showToast: (message: string, kind?: ToastKind) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Mounts the single global toast surface, matching `UploadDeepLinkProvider`'s
 * pattern — a provider near the root so any screen (or a provider above all
 * screens, like the deep-link handler) can fire a transient banner without
 * needing its own mount point. Only one toast is shown at a time; a new call
 * replaces whatever's currently up rather than queuing.
 *
 * On iOS the toast renders inside `FullWindowOverlay`: screens presented as
 * `fullScreenModal` (recorder, export) are real UIKit modal presentations
 * layered above the entire RN root view, so a root-level sibling — any zIndex —
 * paints behind them. The overlay is its own UIWindow above every presentation,
 * which is what lets e.g. export's "Link copied" show over the modal. Android's
 * modals stay in the same native hierarchy, so the plain sibling suffices.
 */
function ToastSurface({ message, kind }: { message: string; kind: ToastKind }) {
  const toast = <Toast key={message} message={message} kind={kind} />;
  if (Platform.OS === 'ios') {
    return <FullWindowOverlay>{toast}</FullWindowOverlay>;
  }
  return toast;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, kind: ToastKind = 'success') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, kind });
    timerRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && <ToastSurface message={toast.message} kind={toast.kind} />}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
