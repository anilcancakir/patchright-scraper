/**
 * Wire shape of a per-session launch profile: the identity fields a
 * caller can pin so the browser's declared self stays coherent with the
 * address it leaves from.
 */
export interface StealthProfile {
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number };
  extraHTTPHeaders?: Record<string, string>;
  geolocation?: { longitude: number; latitude: number; accuracy?: number };
}
