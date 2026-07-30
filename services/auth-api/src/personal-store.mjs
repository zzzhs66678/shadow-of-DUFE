import { createHash } from "node:crypto";

function canonicalPayloadHash(payload) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function readPersonalState(database, userId) {
  const revisionResult = await database.query(
    `SELECT current_revision
     FROM user_sync_states
     WHERE user_id = $1`,
    [userId],
  );
  const revision = Number(revisionResult.rows[0]?.current_revision ?? 0);

  const profileResult = await database.query(
    `SELECT
       entrance_year,
       college,
       major_id,
       class_name,
       onboarding_skipped
     FROM user_profiles
     WHERE user_id = $1`,
    [userId],
  );
  const profileRow = profileResult.rows[0];
  const profile =
    profileRow?.entrance_year === null || profileRow === undefined
      ? null
      : {
          entranceYear: Number(profileRow.entrance_year),
          college: profileRow.college ?? "",
          majorId: profileRow.major_id ?? "",
          className: profileRow.class_name ?? "",
        };

  const plansResult = await database.query(
    `SELECT
       plans.id,
       plans.client_id,
       plans.name,
       plans.position,
       schedules.schedule_id
     FROM timetable_plans AS plans
     LEFT JOIN timetable_plan_schedules AS schedules
       ON schedules.plan_id = plans.id
      AND schedules.deleted_at IS NULL
     WHERE plans.user_id = $1
       AND plans.deleted_at IS NULL
     ORDER BY plans.position, plans.created_at, schedules.created_at`,
    [userId],
  );
  const planMap = new Map();
  for (const row of plansResult.rows) {
    if (!planMap.has(row.client_id)) {
      planMap.set(row.client_id, {
        id: row.client_id,
        name: row.name,
        scheduleIds: [],
      });
    }
    if (row.schedule_id) {
      planMap.get(row.client_id).scheduleIds.push(row.schedule_id);
    }
  }
  const plans = [...planMap.values()];

  const activitiesResult = await database.query(
    `SELECT client_id, title, weekday, block, location, notes, color
     FROM personal_activities
     WHERE user_id = $1
       AND deleted_at IS NULL
     ORDER BY created_at, id`,
    [userId],
  );

  const assignmentsResult = await database.query(
    `SELECT
       client_id,
       course_id,
       title,
       due_date::text,
       notes,
       completed
     FROM user_assignments
     WHERE user_id = $1
       AND deleted_at IS NULL
     ORDER BY due_date, created_at, id`,
    [userId],
  );

  const settingsResult = await database.query(
    `SELECT
       active_plan_client_id,
       preferred_term,
       theme,
       favorite_rooms,
       recent_rooms
     FROM user_settings
     WHERE user_id = $1`,
    [userId],
  );
  const settings = settingsResult.rows[0];
  const fallbackPlanId = plans[0]?.id ?? "";
  const activePlanId = plans.some(
    (plan) => plan.id === settings?.active_plan_client_id,
  )
    ? settings.active_plan_client_id
    : fallbackPlanId;

  return {
    revision,
    state: {
      profile,
      skipped: profileRow?.onboarding_skipped ?? false,
      plans,
      activePlanId,
      activities: activitiesResult.rows.map((row) => ({
        id: row.client_id,
        title: row.title,
        weekday: Number(row.weekday),
        block: Number(row.block),
        location: row.location,
        notes: row.notes,
        color: row.color,
      })),
      assignments: assignmentsResult.rows.map((row) => ({
        id: row.client_id,
        courseId: row.course_id,
        title: row.title,
        dueDate: row.due_date,
        notes: row.notes,
        completed: row.completed,
      })),
      favoriteRooms: settings?.favorite_rooms ?? [],
      recentRooms: settings?.recent_rooms ?? [],
      preferredTerm: settings?.preferred_term ?? "fall",
      theme: settings?.theme ?? "system",
    },
  };
}

async function upsertPlans(client, userId, revision, clientUpdatedAt, plans) {
  await client.query(
    `INSERT INTO timetable_plans (
       user_id,
       client_id,
       name,
       position,
       revision,
       client_updated_at
     )
     SELECT
       $1,
       incoming.client_id,
       incoming.name,
       incoming.position,
       $2,
       $3
     FROM jsonb_to_recordset($4::jsonb)
       AS incoming(client_id text, name text, position smallint)
     ON CONFLICT (user_id, client_id) DO UPDATE
     SET
       name = EXCLUDED.name,
       position = EXCLUDED.position,
       revision = EXCLUDED.revision,
       client_updated_at = EXCLUDED.client_updated_at,
       updated_at = now(),
       deleted_at = NULL`,
    [
      userId,
      revision,
      clientUpdatedAt,
      JSON.stringify(
        plans.map((plan, position) => ({
          client_id: plan.id,
          name: plan.name,
          position,
        })),
      ),
    ],
  );

  await client.query(
    `UPDATE timetable_plans
     SET
       revision = $2,
       client_updated_at = $3,
       updated_at = now(),
       deleted_at = COALESCE(deleted_at, now())
     WHERE user_id = $1
       AND NOT (client_id = ANY($4::text[]))
       AND deleted_at IS NULL`,
    [userId, revision, clientUpdatedAt, plans.map((plan) => plan.id)],
  );

  const planRows = await client.query(
    `SELECT id, client_id
     FROM timetable_plans
     WHERE user_id = $1
       AND deleted_at IS NULL`,
    [userId],
  );
  const planIds = new Map(
    planRows.rows.map((row) => [row.client_id, row.id]),
  );
  const schedules = plans.flatMap((plan) =>
    plan.scheduleIds.map((scheduleId) => ({
      plan_id: planIds.get(plan.id),
      schedule_id: scheduleId,
    })),
  );

  await client.query(
    `INSERT INTO timetable_plan_schedules (
       user_id,
       plan_id,
       schedule_id,
       source,
       revision,
       client_updated_at
     )
     SELECT
       $1,
       incoming.plan_id,
       incoming.schedule_id,
       'manual',
       $2,
       $3
     FROM jsonb_to_recordset($4::jsonb)
       AS incoming(plan_id uuid, schedule_id text)
     ON CONFLICT (plan_id, schedule_id) DO UPDATE
     SET
       revision = EXCLUDED.revision,
       client_updated_at = EXCLUDED.client_updated_at,
       updated_at = now(),
       deleted_at = NULL`,
    [userId, revision, clientUpdatedAt, JSON.stringify(schedules)],
  );

  await client.query(
    `UPDATE timetable_plan_schedules AS saved
     SET
       revision = $2,
       client_updated_at = $3,
       updated_at = now(),
       deleted_at = COALESCE(saved.deleted_at, now())
     WHERE saved.user_id = $1
       AND saved.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_to_recordset($4::jsonb)
           AS incoming(plan_id uuid, schedule_id text)
         WHERE incoming.plan_id = saved.plan_id
           AND incoming.schedule_id = saved.schedule_id
       )`,
    [userId, revision, clientUpdatedAt, JSON.stringify(schedules)],
  );
}

async function upsertActivities(
  client,
  userId,
  revision,
  clientUpdatedAt,
  activities,
) {
  await client.query(
    `INSERT INTO personal_activities (
       user_id,
       client_id,
       title,
       weekday,
       block,
       location,
       notes,
       color,
       revision,
       client_updated_at
     )
     SELECT
       $1,
       incoming.client_id,
       incoming.title,
       incoming.weekday,
       incoming.block,
       incoming.location,
       incoming.notes,
       incoming.color,
       $2,
       $3
     FROM jsonb_to_recordset($4::jsonb) AS incoming(
       client_id text,
       title text,
       weekday smallint,
       block smallint,
       location text,
       notes text,
       color text
     )
     ON CONFLICT (user_id, client_id) DO UPDATE
     SET
       title = EXCLUDED.title,
       weekday = EXCLUDED.weekday,
       block = EXCLUDED.block,
       location = EXCLUDED.location,
       notes = EXCLUDED.notes,
       color = EXCLUDED.color,
       revision = EXCLUDED.revision,
       client_updated_at = EXCLUDED.client_updated_at,
       updated_at = now(),
       deleted_at = NULL`,
    [
      userId,
      revision,
      clientUpdatedAt,
      JSON.stringify(
        activities.map((item) => ({
          client_id: item.id,
          title: item.title,
          weekday: item.weekday,
          block: item.block,
          location: item.location,
          notes: item.notes,
          color: item.color,
        })),
      ),
    ],
  );

  await client.query(
    `UPDATE personal_activities
     SET
       revision = $2,
       client_updated_at = $3,
       updated_at = now(),
       deleted_at = COALESCE(deleted_at, now())
     WHERE user_id = $1
       AND NOT (client_id = ANY($4::text[]))
       AND deleted_at IS NULL`,
    [userId, revision, clientUpdatedAt, activities.map((item) => item.id)],
  );
}

async function upsertAssignments(
  client,
  userId,
  revision,
  clientUpdatedAt,
  assignments,
) {
  await client.query(
    `INSERT INTO user_assignments (
       user_id,
       client_id,
       course_id,
       title,
       due_date,
       notes,
       completed,
       revision,
       client_updated_at
     )
     SELECT
       $1,
       incoming.client_id,
       incoming.course_id,
       incoming.title,
       incoming.due_date,
       incoming.notes,
       incoming.completed,
       $2,
       $3
     FROM jsonb_to_recordset($4::jsonb) AS incoming(
       client_id text,
       course_id text,
       title text,
       due_date date,
       notes text,
       completed boolean
     )
     ON CONFLICT (user_id, client_id) DO UPDATE
     SET
       course_id = EXCLUDED.course_id,
       title = EXCLUDED.title,
       due_date = EXCLUDED.due_date,
       notes = EXCLUDED.notes,
       completed = EXCLUDED.completed,
       revision = EXCLUDED.revision,
       client_updated_at = EXCLUDED.client_updated_at,
       updated_at = now(),
       deleted_at = NULL`,
    [
      userId,
      revision,
      clientUpdatedAt,
      JSON.stringify(
        assignments.map((item) => ({
          client_id: item.id,
          course_id: item.courseId,
          title: item.title,
          due_date: item.dueDate,
          notes: item.notes,
          completed: item.completed,
        })),
      ),
    ],
  );

  await client.query(
    `UPDATE user_assignments
     SET
       revision = $2,
       client_updated_at = $3,
       updated_at = now(),
       deleted_at = COALESCE(deleted_at, now())
     WHERE user_id = $1
       AND NOT (client_id = ANY($4::text[]))
       AND deleted_at IS NULL`,
    [userId, revision, clientUpdatedAt, assignments.map((item) => item.id)],
  );
}

export function createPersonalStore(pool) {
  return {
    async getPersonalState(userId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const snapshot = await readPersonalState(client, userId);
        await client.query("COMMIT");
        return snapshot;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async replacePersonalState(userId, payload) {
      const client = await pool.connect();
      const payloadHash = canonicalPayloadHash(payload);

      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO user_sync_states (user_id)
           VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );

        const syncState = await client.query(
          `SELECT current_revision
           FROM user_sync_states
           WHERE user_id = $1
           FOR UPDATE`,
          [userId],
        );
        const currentRevision = Number(
          syncState.rows[0].current_revision,
        );

        const priorMutation = await client.query(
          `SELECT payload_hash, applied_revision
           FROM user_sync_mutations
           WHERE user_id = $1
             AND mutation_id = $2`,
          [userId, payload.mutationId],
        );
        if (priorMutation.rowCount > 0) {
          if (priorMutation.rows[0].payload_hash !== payloadHash) {
            const error = new Error("mutation ID was reused");
            error.code = "SYNC_MUTATION_REUSED";
            throw error;
          }
          const snapshot = await readPersonalState(client, userId);
          await client.query("COMMIT");
          return { ...snapshot, deduplicated: true, conflict: false };
        }

        if (payload.baseRevision !== currentRevision) {
          const snapshot = await readPersonalState(client, userId);
          await client.query("COMMIT");
          return { ...snapshot, deduplicated: false, conflict: true };
        }

        const revision = currentRevision + 1;
        await client.query(
          `UPDATE user_sync_states
           SET current_revision = $2, updated_at = now()
           WHERE user_id = $1`,
          [userId, revision],
        );

        const state = payload.state;
        await client.query(
          `INSERT INTO user_profiles (
             user_id,
             entrance_year,
             college,
             major_id,
             class_name,
             onboarding_skipped,
             revision,
             client_updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id) DO UPDATE
           SET
             entrance_year = EXCLUDED.entrance_year,
             college = EXCLUDED.college,
             major_id = EXCLUDED.major_id,
             class_name = EXCLUDED.class_name,
             onboarding_skipped = EXCLUDED.onboarding_skipped,
             revision = EXCLUDED.revision,
             client_updated_at = EXCLUDED.client_updated_at,
             updated_at = now()`,
          [
            userId,
            state.profile?.entranceYear ?? null,
            state.profile?.college ?? null,
            state.profile?.majorId ?? null,
            state.profile?.className ?? null,
            state.skipped,
            revision,
            payload.clientUpdatedAt,
          ],
        );

        await upsertPlans(
          client,
          userId,
          revision,
          payload.clientUpdatedAt,
          state.plans,
        );
        await upsertActivities(
          client,
          userId,
          revision,
          payload.clientUpdatedAt,
          state.activities,
        );
        await upsertAssignments(
          client,
          userId,
          revision,
          payload.clientUpdatedAt,
          state.assignments,
        );

        await client.query(
          `INSERT INTO user_settings (
             user_id,
             active_plan_client_id,
             preferred_term,
             theme,
             favorite_rooms,
             recent_rooms,
             revision,
             client_updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id) DO UPDATE
           SET
             active_plan_client_id = EXCLUDED.active_plan_client_id,
             preferred_term = EXCLUDED.preferred_term,
             theme = EXCLUDED.theme,
             favorite_rooms = EXCLUDED.favorite_rooms,
             recent_rooms = EXCLUDED.recent_rooms,
             revision = EXCLUDED.revision,
             client_updated_at = EXCLUDED.client_updated_at,
             updated_at = now()`,
          [
            userId,
            state.activePlanId || null,
            state.preferredTerm,
            state.theme,
            state.favoriteRooms,
            state.recentRooms,
            revision,
            payload.clientUpdatedAt,
          ],
        );

        await client.query(
          `INSERT INTO user_sync_mutations (
             user_id,
             mutation_id,
             payload_hash,
             base_revision,
             applied_revision
           )
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            payload.mutationId,
            payloadHash,
            payload.baseRevision,
            revision,
          ],
        );
        await client.query(
          `DELETE FROM user_sync_mutations
           WHERE (user_id, mutation_id) IN (
             SELECT user_id, mutation_id
             FROM user_sync_mutations
             WHERE created_at < now() - interval '30 days'
             ORDER BY created_at
             LIMIT 200
           )`,
        );

        const snapshot = await readPersonalState(client, userId);
        await client.query("COMMIT");
        return { ...snapshot, deduplicated: false, conflict: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
