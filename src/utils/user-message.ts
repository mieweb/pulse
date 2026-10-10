/**
 * A short, human error line for a toast, from whatever was thrown. Native and server errors
 * ("The operation couldn't be completed. (OSStatus error -12780.)", a MediaCodec stack) are
 * logged in full for Debug logs and replaced with `fallback`; a plain, short message passes
 * through.
 */
export function userMessage(error: unknown, fallback: string, context = 'error'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Debug logs capture console output, so the full error (with its stack) stays available there.
  console.warn(`[${context}]`, error);
  const looksTechnical =
    !raw ||
    raw.length > 120 ||
    /error\s*-?\d|OSStatus|Exception|errno|code\s*=|\bat\s+\S+\.\w+\(|\n/i.test(raw);
  return looksTechnical ? fallback : raw;
}
