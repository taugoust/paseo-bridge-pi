/** Calendar dates describe explicit records, never a worker heartbeat. */
export function goalRecordTime(at: number, now = Date.now(), locale?: string): string {
  const date = new Date(at), today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }),
    hour: "numeric", minute: "2-digit",
  }).format(date);
}
