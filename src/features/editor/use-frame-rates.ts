import { probe } from '@mieweb/pulse-editor';
import { useEffect, useState } from 'react';

/** Each file's frame rate (for frame-snapped trims), probed once per file (30 if the probe fails). */
const frameRates = new Map<string, number>();
export function useFrameRates(uris: readonly string[]) {
  // The rates known to this editor, a new map as each probe answers.
  const [rates, setRates] = useState(() => new Map(frameRates));
  const key = [...new Set(uris)].join('\n');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const uri of key.split('\n')) {
        if (!uri || frameRates.has(uri)) continue;
        try {
          const fps = (await probe(uri)).video?.fps ?? 0;
          frameRates.set(uri, fps > 0 ? fps : 30);
        } catch {
          frameRates.set(uri, 30);
        }
        if (live) setRates(new Map(frameRates));
      }
      // Rates another editor probed meanwhile.
      if (live) setRates((r) => (r.size === frameRates.size ? r : new Map(frameRates)));
    })();
    return () => {
      live = false;
    };
  }, [key]);
  // Unknown until the probe answers (no trim before then: it would snap to a guessed rate).
  return (uri: string) => rates.get(uri) ?? null;
}
