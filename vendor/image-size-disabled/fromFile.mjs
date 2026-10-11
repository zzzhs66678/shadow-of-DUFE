const disabledMessage =
  "Build-time image probing is disabled; use a public URL with explicit dimensions";

export function setConcurrency() {
  // No work queue exists because file probing is disabled.
}

export async function imageSizeFromFile() {
  throw new TypeError(disabledMessage);
}
