/**
 * Converts a subset of ISO 8601 duration strings into a compact human-readable
 * label, e.g. `"PT8H"` -> `"8h"`, `"P1DT30M"` -> `"1d 30m"`.
 *
 * Only days (D), hours (H), and minutes (M) components are supported. If the
 * string does not match the expected pattern it is returned unchanged.
 * @param iso - ISO 8601 duration string (e.g. `"PT8H"`, `"P1DT30M"`).
 * @returns A compact label like `"8h"` or `"1d 30m"`, or the original string on parse failure.
 */
export function formatDuration(iso: string): string {
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return iso;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  return parts.join(' ') || iso;
}

/**
 * Converts an ISO 8601 duration string to a total number of minutes.
 * @param iso - ISO 8601 duration string (e.g. `"PT8H"`, `"P1DT30M"`).
 * @returns Total minutes, or `0` for unrecognized patterns.
 */
export function toMinutes(iso: string): number {
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Converts a total number of minutes back to an ISO 8601 duration string.
 * Caps at 1 day (`P1D`). Used to build the `duration` field in `ActivationParams`.
 * @param mins - Duration in minutes (capped at 1440 = 1 day).
 * @returns ISO 8601 duration string (e.g. `"PT8H"`, `"PT1H30M"`, `"P1D"`).
 */
export function minutesToIso(mins: number): string {
  if (mins >= 1440) return 'P1D';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `PT${h}H${m}M`;
  if (h > 0) return `PT${h}H`;
  return `PT${m}M`;
}

/**
 * Formats a total number of minutes as a human-readable label.
 * @param mins - Duration in minutes (e.g. `90`).
 * @returns A label like `"1 h 30 min"`, `"8 h"`, `"30 min"`, or `"1 day"`.
 */
export function formatMinutes(mins: number): string {
  if (mins >= 1440) return '1 day';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} h ${m} min`;
  if (h > 0) return `${h} h`;
  return `${m} min`;
}

/**
 * Formats a remaining-time span in milliseconds as a compact countdown label:
 * `"2h 5m"`, `"4m 32s"`, or `"18s"`.
 * @param ms - Remaining milliseconds (negative values clamp to `"0s"`).
 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
