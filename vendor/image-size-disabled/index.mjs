const disabledMessage =
  "Build-time image probing is disabled; use a public URL with explicit dimensions";

export const types = Object.freeze([]);

export function disableTypes() {
  // Parsing is disabled for every type, so there is no mutable type registry.
}

export function imageSize() {
  throw new TypeError(disabledMessage);
}

export default imageSize;
