import { fail, record } from "./errors.js";
export const DEFAULT_SETTINGS = Object.freeze({
  theme: "system",
  largeText: false,
  sidebarCollapsed: false,
  concurrency: 2,
  timeoutSeconds: 30,
});
export function validateSettings(input) {
  record(input);
  const s = {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    ),
  };
  if (
    !["system", "light", "dark"].includes(s.theme) ||
    typeof s.largeText !== "boolean" ||
    typeof s.sidebarCollapsed !== "boolean" ||
    !Number.isInteger(s.concurrency) ||
    s.concurrency < 1 ||
    s.concurrency > 4 ||
    !Number.isInteger(s.timeoutSeconds) ||
    s.timeoutSeconds < 5 ||
    s.timeoutSeconds > 120
  )
    fail("INVALID_INPUT", "设置值超出允许范围。");
  return s;
}
