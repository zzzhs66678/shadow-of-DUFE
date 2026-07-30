CREATE TABLE IF NOT EXISTS user_sync_states (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    current_revision bigint NOT NULL DEFAULT 0
        CHECK (current_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION next_user_revision(target_user_id uuid)
RETURNS bigint
LANGUAGE sql
AS $$
    INSERT INTO user_sync_states (user_id, current_revision, updated_at)
    VALUES (target_user_id, 1, now())
    ON CONFLICT (user_id) DO UPDATE
    SET
        current_revision = user_sync_states.current_revision + 1,
        updated_at = now()
    RETURNING current_revision;
$$;

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    entrance_year smallint
        CHECK (entrance_year BETWEEN 2000 AND 2100),
    college text
        CHECK (college IS NULL OR char_length(college) <= 120),
    major_id text
        CHECK (major_id IS NULL OR char_length(major_id) <= 120),
    class_name text
        CHECK (class_name IS NULL OR char_length(class_name) <= 120),
    onboarding_skipped boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timetable_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    client_id text NOT NULL
        CHECK (char_length(client_id) BETWEEN 1 AND 128),
    name text NOT NULL
        CHECK (char_length(name) BETWEEN 1 AND 80),
    position smallint NOT NULL DEFAULT 0
        CHECK (position BETWEEN 0 AND 999),
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (user_id, client_id),
    UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS timetable_plan_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    schedule_id text NOT NULL
        CHECK (char_length(schedule_id) BETWEEN 1 AND 160),
    source text NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'class_import')),
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (plan_id, schedule_id),
    FOREIGN KEY (plan_id, user_id)
        REFERENCES timetable_plans(id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personal_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    client_id text NOT NULL
        CHECK (char_length(client_id) BETWEEN 1 AND 128),
    title text NOT NULL
        CHECK (char_length(title) BETWEEN 1 AND 120),
    weekday smallint NOT NULL
        CHECK (weekday BETWEEN 1 AND 7),
    block smallint NOT NULL
        CHECK (block BETWEEN 1 AND 4),
    location text NOT NULL DEFAULT ''
        CHECK (char_length(location) <= 200),
    notes text NOT NULL DEFAULT ''
        CHECK (char_length(notes) <= 4000),
    color text NOT NULL DEFAULT 'red'
        CHECK (color IN ('red', 'blue', 'green', 'amber')),
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS user_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    client_id text NOT NULL
        CHECK (char_length(client_id) BETWEEN 1 AND 128),
    course_id text NOT NULL DEFAULT ''
        CHECK (char_length(course_id) <= 160),
    title text NOT NULL
        CHECK (char_length(title) BETWEEN 1 AND 160),
    due_date date NOT NULL,
    notes text NOT NULL DEFAULT ''
        CHECK (char_length(notes) <= 4000),
    completed boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    active_plan_client_id text
        CHECK (
            active_plan_client_id IS NULL
            OR char_length(active_plan_client_id) BETWEEN 1 AND 128
        ),
    preferred_term text NOT NULL DEFAULT 'fall'
        CHECK (preferred_term IN ('fall', 'spring')),
    theme text NOT NULL DEFAULT 'system'
        CHECK (theme IN ('system', 'day', 'night')),
    favorite_rooms text[] NOT NULL DEFAULT ARRAY[]::text[]
        CHECK (COALESCE(array_length(favorite_rooms, 1), 0) <= 100),
    recent_rooms text[] NOT NULL DEFAULT ARRAY[]::text[]
        CHECK (COALESCE(array_length(recent_rooms, 1), 0) <= 50),
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_profiles_revision_idx
    ON user_profiles (user_id, revision);

CREATE INDEX IF NOT EXISTS timetable_plans_revision_idx
    ON timetable_plans (user_id, revision);

CREATE INDEX IF NOT EXISTS timetable_plan_schedules_revision_idx
    ON timetable_plan_schedules (user_id, revision);

CREATE INDEX IF NOT EXISTS personal_activities_revision_idx
    ON personal_activities (user_id, revision);

CREATE INDEX IF NOT EXISTS user_assignments_revision_idx
    ON user_assignments (user_id, revision);

CREATE INDEX IF NOT EXISTS user_settings_revision_idx
    ON user_settings (user_id, revision);

COMMENT ON TABLE user_sync_states IS
    '每位用户独立递增的云同步版本游标；用于增量读取和并发冲突检测。';
COMMENT ON TABLE user_profiles IS
    '用户主动选择的年级、学院、专业和班级；未选择班级时不得推测教学班。';
COMMENT ON TABLE timetable_plans IS
    '用户自定义课表方案；client_id 对应浏览器中既有的稳定方案 ID。';
COMMENT ON TABLE timetable_plan_schedules IS
    '课表方案中的具体教学时段 ID；不按课程名称合并。';
COMMENT ON TABLE personal_activities IS
    '用户添加的每周个人日程。';
COMMENT ON TABLE user_assignments IS
    '用户添加的课程任务及截止日期。';
COMMENT ON TABLE user_settings IS
    '跨设备同步的课表、主题、常用教室和最近教室偏好。';
