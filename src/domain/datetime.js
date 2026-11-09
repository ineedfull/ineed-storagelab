export function formatDateTime(value) {
  if (value === null || value === undefined || value === "") return "--";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "--";
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
