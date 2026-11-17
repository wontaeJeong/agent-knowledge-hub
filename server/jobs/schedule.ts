import type { ScheduleSpec } from "./types";

export function localDate(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
/** Wall-clock daily/weekly/monthly schedule. Nonexistent DST minutes are skipped. During
 * a fold only the FIRST matching minute is eligible; durable local-date keys
 * also protect against timezone edits and duplicate scheduler processes. */
export function nextOccurrence(spec: ScheduleSpec, after: Date): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time) || !Number.isFinite(+after))
    throw Error("INVALID_SCHEDULE");
  if (
    spec.cadence === "weekly" &&
    (!Number.isInteger(spec.weekday) || spec.weekday! < 0 || spec.weekday! > 6)
  )
    throw Error("INVALID_SCHEDULE");
  if (
    !["daily", "weekly", "monthly"].includes(spec.cadence) ||
    (spec.cadence === "monthly" &&
      (!Number.isInteger(spec.dayOfMonth) ||
        spec.dayOfMonth! < 1 ||
        spec.dayOfMonth! > 31 ||
        !["clamp", "skip"].includes(spec.invalidDay!)))
  )
    throw Error("INVALID_SCHEDULE");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: spec.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = (d: Date) =>
    Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const initial = parts(after),
    initialDate = `${initial.year}-${initial.month}-${initial.day}`;
  const initialTime = `${initial.hour}:${initial.minute}`;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (spec.cadence === "monthly") {
    // Search at most fourteen calendar dates, rather than scanning several years
    // minute by minute during catchup. Match local wall time to preserve DST.
    for (let offset = 0; offset < 14; offset++) {
      const month = new Date(
        Date.UTC(Number(initial.year), Number(initial.month) - 1 + offset, 1),
      );
      const last = new Date(
        Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const day =
        spec.invalidDay === "clamp"
          ? Math.min(spec.dayOfMonth!, last)
          : spec.dayOfMonth!;
      if (day > last) continue;
      const date = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (spec.holidays.includes(date)) continue;
      const rough = Date.parse(date + "T" + spec.time + ":00Z");
      for (
        let t = rough - 18 * 3600000;
        t <= rough + 18 * 3600000;
        t += 60000
      ) {
        const p = parts(new Date(t));
        if (
          `${p.year}-${p.month}-${p.day}` === date &&
          `${p.hour}:${p.minute}` === spec.time
        ) {
          // First matching minute only, including when after falls within a fold.
          if (t > +after && t <= +after + 370 * 86400000) return new Date(t);
          break;
        }
      }
    }
    throw Error("SCHEDULE_HORIZON_EXCEEDED");
  }
  // 370 days supports a bounded holiday calendar without unbounded CPU work.
  for (
    let t = Math.floor(+after / 60000) * 60000 + 60000;
    t <= +after + 370 * 86400000;
    t += 60000
  ) {
    const p = parts(new Date(t));
    if (`${p.hour}:${p.minute}` !== spec.time) continue;
    const date = `${p.year}-${p.month}-${p.day}`;
    if (date === initialDate && initialTime >= spec.time) continue;
    if (
      spec.holidays.includes(date) ||
      (spec.cadence === "weekly" &&
        weekdays.indexOf(p.weekday) !== spec.weekday)
    )
      continue;
    // Reject second occurrence even when 'after' falls between fold minutes.
    let duplicate = false;
    for (let back = 1; back <= 180; back++) {
      const q = parts(new Date(t - back * 60000));
      if (
        `${q.year}-${q.month}-${q.day}` === date &&
        `${q.hour}:${q.minute}` === spec.time
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) return new Date(t);
  }
  throw Error("SCHEDULE_HORIZON_EXCEEDED");
}
