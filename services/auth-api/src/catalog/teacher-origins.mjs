function sequence(meeting) {
  if (meeting.courseSequence !== undefined) return String(meeting.courseSequence);
  if (meeting.sequence !== undefined) return String(meeting.sequence);
  const prefix = `${meeting.term}-${meeting.courseId}-`;
  const suffix = `-${meeting.sourceRow}`;
  return meeting.sourceRow && meeting.sectionId?.startsWith(prefix) && meeting.sectionId.endsWith(suffix)
    ? meeting.sectionId.slice(prefix.length, -suffix.length) : "";
}
const identity = (meeting) => JSON.stringify([
  meeting.sectionId, meeting.courseId, meeting.teacher, meeting.classNames,
  sequence(meeting),
]);

// Carry proven source identities forward, never resolve a teacher by display
// name. The original source link remains authoritative, including withdrawal.
export async function reconcileCatalogTeacherOrigins(client, { before, after }) {
  if (before.catalogId === after.catalogId) return 0;
  const previous = new Map(before.schedules.map(meeting => [meeting.id, meeting]));
  const unchanged = after.schedules.filter(meeting => {
    const old = previous.get(meeting.id);
    return old && identity(old) === identity(meeting);
  }).map(meeting => meeting.id);
  if (!unchanged.length) return 0;
  const result = await client.query(`INSERT INTO catalog_schedule_origins
    (catalog_id, schedule_id, origin_catalog_id)
    SELECT $2, schedule_id, origin_catalog_id FROM (
      SELECT schedule_id, catalog_id AS origin_catalog_id
      FROM course_schedule_teachers WHERE catalog_id = $1
        AND schedule_id = ANY($3::text[]) AND record_status = 'current'
      UNION
      SELECT schedule_id, origin_catalog_id FROM catalog_schedule_origins
      WHERE catalog_id = $1 AND schedule_id = ANY($3::text[])
    ) AS proven
    ON CONFLICT DO NOTHING`, [before.catalogId, after.catalogId, unchanged]);
  return result.rowCount;
}
