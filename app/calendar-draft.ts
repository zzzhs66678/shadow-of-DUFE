/** Compare only the editor's fields, not saved records/defaults that may refresh behind it. */
export function calendarDraftChanged(
  initial: Readonly<Record<string, string | number>>,
  current: Readonly<Record<string, string | number>>,
): boolean {
  const clean = (value: string | number | undefined) => typeof value === "string" ? value.trim() : value;
  return [...new Set([...Object.keys(initial), ...Object.keys(current)])]
    .some((key) => clean(initial[key]) !== clean(current[key]));
}
