import type { ReactNode } from 'react';

import { ThemedView } from '@/components/themed-view';

const centered = { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 } as const;

/** The full screen every launch-time state of the library uses (loading, notices, recovery). */
export function RecoveryScreen({ children }: { children: ReactNode }) {
  return <ThemedView style={centered}>{children}</ThemedView>;
}
