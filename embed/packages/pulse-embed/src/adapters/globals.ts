import type { PulseAdapter } from '../types';

/**
 * The page globals the adapters read. Everything is optional and untrusted: a web build of a host
 * may alias @capacitor/core to stubs, so any of these can be missing, return nonsense, or throw.
 */
export interface PageGlobals {
  __PULSE_ADAPTER__?: PulseAdapter;
  Capacitor?: unknown;
  cordova?: unknown;
  PulseKit?: unknown;
  WkWebView?: unknown;
  WebAppLocalServer?: unknown;
  document?: unknown;
}

/** `window` in a browser or WebView, else `globalThis` (jest, SSR). */
export function pageGlobals(): PageGlobals {
  return (typeof window !== 'undefined' ? window : globalThis) as unknown as PageGlobals;
}

/** Reads `obj[key]` where a getter (or a Proxy) may throw; undefined then. */
export function read(obj: unknown, key: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Calls `obj[key](...args)` where anything may throw; `fallback` then, or when it isn't a function. */
export function invoke<T>(obj: unknown, key: string, args: unknown[], fallback: T): unknown {
  const fn = read(obj, key);
  if (typeof fn !== 'function') return fallback;
  try {
    return (fn as (...a: unknown[]) => unknown).apply(obj, args);
  } catch {
    return fallback;
  }
}

/** `file://` + an absolute path, unless it already is a URL. */
export function fileUrl(path: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `file://${path}`;
}
