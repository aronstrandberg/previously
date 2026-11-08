const RELATIVE = /^(\d+)\s*(m|h|d|w)$/i
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const

/** Parses `7d`, `12h`, `2w`, `30m` (ago from now) or anything `Date` accepts, into epoch milliseconds. */
export function parseTime(value: string, now = Date.now()): number {
  const relative = RELATIVE.exec(value.trim())
  if (relative) {
    const unit = relative[2]!.toLowerCase() as keyof typeof UNIT_MS
    return now - Number(relative[1]) * UNIT_MS[unit]
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`Cannot parse time "${value}". Use an ISO date like 2026-11-01 or a duration like 7d.`)
  return parsed
}

export function timeFormatter(timeZone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })
  return (ms) => format.format(new Date(ms))
}
