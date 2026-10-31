import { nextOccurrence } from "../jobs/schedule";
import type { Cadence, Preferences } from "./types";
export function localMinute(timezone: string, date: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export function inQuietHours(p: Preferences, at: Date) {
  if (!p.quietHours.enabled) return false;
  const t = localMinute(p.timezone, at),
    start = minutes(p.quietHours.start),
    end = minutes(p.quietHours.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}
/** Scan UTC minutes so DST gaps end at the first real permitted minute, and
 * repeated wall minutes are checked independently instead of guessed offsets. */
export function afterQuietHours(p: Preferences, at: Date): Date {
  if (!inQuietHours(p, at)) return at;
  for (let i = 1; i <= 2880; i++) {
    const next = new Date(Math.floor(+at / 60000) * 60000 + i * 60000);
    if (!inQuietHours(p, next)) return next;
  }
  throw Error("QUIET_HOURS_UNRESOLVED");
}
export function nextDigest(p: Preferences, cadence: Cadence, after: Date) {
  return afterQuietHours(
    p,
    nextOccurrence(
      {
        cadence,
        time: cadence === "daily" ? p.dailyAt : p.weeklyAt,
        timezone: p.timezone,
        weekday: p.weeklyDay,
        holidays: [],
      },
      after,
    ),
  );
}
