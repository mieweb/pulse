// The status bar's style as a stack: each screen that wants a style pushes an entry, the newest
// entry wins, and popping one hands the bar back to the one before it. With nothing pushed, the
// implementation shows its own default (the theme's). Pure, so the rule is tested without React.

/** The styles a screen can ask for: light or dark content (text and icons). */
export type StatusBarStyle = 'light' | 'dark';

export type StatusBarEntry = { readonly style: StatusBarStyle };

export function createStatusBarStack() {
  let entries: readonly StatusBarEntry[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());

  return {
    /** Puts a style on top; pop the returned entry to remove it. */
    push(style: StatusBarStyle): StatusBarEntry {
      const entry = { style };
      entries = [...entries, entry];
      changed();
      return entry;
    },
    /** Removes an entry wherever it is in the stack; popping it again does nothing. */
    pop(entry: StatusBarEntry) {
      if (!entries.includes(entry)) return;
      entries = entries.filter((e) => e !== entry);
      changed();
    },
    /** The style on top, or null when nothing is pushed. */
    top(): StatusBarStyle | null {
      return entries[entries.length - 1]?.style ?? null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type StatusBarStack = ReturnType<typeof createStatusBarStack>;
