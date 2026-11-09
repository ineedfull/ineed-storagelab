const units = ["B", "KB", "MB", "GB", "TB", "PB"];
const numberFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

const validSize = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// Desktop file sizes use 1024 bytes per unit; exact bytes remain available.
export function formatFileSize(value) {
  if (!validSize(value)) return "--";
  let size = value;
  let unit = 0;
  while (Math.round(size * 100) / 100 >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${numberFormat.format(size)} ${units[unit]}`;
}

export function formatExactBytes(value) {
  return validSize(value) ? `${value.toLocaleString("zh-CN")} B` : "--";
}
