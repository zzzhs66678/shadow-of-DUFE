CREATE TABLE IF NOT EXISTS data_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_key uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('course', 'room', 'material')),
    course_id text CHECK (course_id IS NULL OR course_id ~ '^([0-9]{6,12}[A-Za-z]{0,3}|[A-Z]{2,6}[0-9]{3,8})$'),
    meeting_id text CHECK (meeting_id IS NULL OR char_length(meeting_id) BETWEEN 1 AND 96),
    material_id text CHECK (material_id IS NULL OR material_id ~ '^[a-f0-9]{20}$'),
    room text CHECK (room IS NULL OR char_length(room) BETWEEN 1 AND 64),
    path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512 AND path LIKE '/%' AND path NOT LIKE '//%'),
    message text NOT NULL CHECK (char_length(message) BETWEEN 2 AND 500),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, request_key),
    CHECK (
      (type = 'course' AND course_id IS NOT NULL AND material_id IS NULL AND room IS NULL) OR
      (type = 'room' AND room IS NOT NULL AND course_id IS NULL AND meeting_id IS NULL AND material_id IS NULL) OR
      (type = 'material' AND material_id IS NOT NULL AND course_id IS NULL AND meeting_id IS NULL AND room IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS data_feedback_user_queue ON data_feedback (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS data_feedback_admin_queue ON data_feedback (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS data_feedback_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feedback_id uuid NOT NULL REFERENCES data_feedback(id) ON DELETE CASCADE,
    actor_user_id uuid NOT NULL,
    from_status text NOT NULL CHECK (from_status IN ('open', 'resolved')),
    to_status text NOT NULL CHECK (to_status IN ('open', 'resolved')),
    version integer NOT NULL CHECK (version > 1),
    note text NOT NULL CHECK (char_length(note) BETWEEN 2 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (feedback_id, version)
);
COMMENT ON TABLE data_feedback IS '登录用户主动提交的数据问题；仅公开对象上下文，不采集个人课表或学校凭据。账号删除时级联删除。';
COMMENT ON TABLE data_feedback_actions IS '管理员处理记录；只由处理事务追加，与状态变更和不含正文的管理审计同时提交。';
