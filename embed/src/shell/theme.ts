import type { ConfigureOptions, OpenRequest, ThemeBridge } from '@mieweb/pulse-embed';

import type { ThemeOverrides } from '@/hooks/use-theme';

/**
 * The theme bridge (F6, AD26) onto PulseCore's theme: the host's appearance, accent, destructive
 * colour and button radius. The request's theme replaces the configured one whole, as the facade
 * does for the container view controller, so both sides draw the same theme. The request's theme
 * was checked with the request (validate.ts); the configured one wasn't, so a field it gets wrong
 * is left out rather than failing the flow.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function themeOf(request: OpenRequest, config: ConfigureOptions): ThemeBridge | undefined {
  return request.theme ?? config.theme ?? undefined;
}

/** PulseCore's theme for `bridge`. Without an appearance the embed follows the OS. */
export function themeOverrides(bridge: ThemeBridge | undefined): ThemeOverrides {
  const b: Partial<Record<keyof ThemeBridge, unknown>> =
    typeof bridge === 'object' && bridge !== null ? bridge : {};
  const color = (v: unknown) => (typeof v === 'string' && HEX_COLOR.test(v) ? v : undefined);
  const mode = b.appearance === 'light' || b.appearance === 'dark' ? b.appearance : 'system';
  const radius =
    typeof b.buttonRadius === 'number' && Number.isFinite(b.buttonRadius) && b.buttonRadius >= 0
      ? b.buttonRadius
      : undefined;
  return {
    mode,
    ...(color(b.accent) ? { accent: color(b.accent) } : null),
    ...(color(b.destructive) ? { destructive: color(b.destructive) } : null),
    ...(radius !== undefined ? { buttonRadius: radius } : null),
  };
}
