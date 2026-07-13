export interface ZonedTimestamp {
  display: string;
  year: string;
  month: string;
  day: string;
  monthKey: string;
  dayKey: string;
  yearKey: string;
  monthTitle: string;
}

function partMap(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
}

export function getZonedTimestamp(date: Date, timezone: string): ZonedTimestamp {
  const parts = partMap(date, timezone);
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;
  const display = `${year}-${month}-${day} ${hour}:${minute}`;

  return {
    display,
    year,
    month,
    day,
    monthKey: `${year}-${month}`,
    dayKey: `${year}-${month}-${day}`,
    yearKey: year,
    monthTitle: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "long",
      year: "numeric"
    }).format(date)
  };
}

export function getCurrentTimePayload(timezone: string, date = new Date()) {
  const zoned = getZonedTimestamp(date, timezone);
  return {
    timestamp: zoned.display,
    timezone,
    month: zoned.monthKey,
    iso: date.toISOString()
  };
}
