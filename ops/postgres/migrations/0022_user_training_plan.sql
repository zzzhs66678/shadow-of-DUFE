ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS training_plan jsonb
        CHECK (
            training_plan IS NULL
            OR (
                jsonb_typeof(training_plan) = 'object'
                AND octet_length(training_plan::text) <= 1048576
            )
        );

COMMENT ON COLUMN user_settings.training_plan IS
    '用户主动从正式教务导入的个人培养方案；仅保存规范化课程与学分要求，不保存教务凭据或会话。';
