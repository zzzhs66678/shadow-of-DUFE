/** Room labels already exclude the building name. Do not infer a floor from arbitrary digits. */
export function roomFloor(room: string): string {
  const label = room.normalize("NFKC").trim().toUpperCase();
  // 102 → 1F, 1014 → 10F; E/W denote wings, not a different floor scheme.
  const numbered = label.match(/^[EW]?([1-9]\d{2,3})$/);
  if (numbered) return String(Number(numbered[1].slice(0, -2)));
  // The catalog also uses labels such as 播慧楼 J4-3.
  const separated = label.match(/^J([1-9]\d?)-(\d{1,2})$/);
  return separated ? String(Number(separated[1])) : "?";
}

export function groupRoomsByFloor(rooms: readonly string[]): [string, string[]][] {
  const floors = new Map<string, string[]>();
  for (const room of new Set(rooms)) {
    const floor = roomFloor(room);
    const group = floors.get(floor) ?? [];
    group.push(room);
    floors.set(floor, group);
  }
  return [...floors.entries()]
    .map(([floor, group]): [string, string[]] => [floor, group.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))])
    .sort(([a], [b]) => a === "?" ? 1 : b === "?" ? -1 : Number(b) - Number(a));
}
