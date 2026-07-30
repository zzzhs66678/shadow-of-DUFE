\set ON_ERROR_STOP on

DO $$
DECLARE
    test_user_id uuid;
    other_user_id uuid;
    test_plan_id uuid;
    next_revision bigint;
    remaining_rows bigint;
BEGIN
    INSERT INTO app_users (display_name)
    VALUES ('personal-data-smoke')
    RETURNING id INTO test_user_id;

    INSERT INTO app_users (display_name)
    VALUES ('personal-data-smoke-other')
    RETURNING id INTO other_user_id;

    next_revision := next_user_revision(test_user_id);
    IF next_revision <> 1 THEN
        RAISE EXCEPTION 'first user revision should be 1, got %', next_revision;
    END IF;

    INSERT INTO user_profiles (
        user_id,
        entrance_year,
        college,
        major_id,
        class_name,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        2025,
        '会计学院',
        'accounting',
        '审计2501',
        next_revision,
        now()
    );

    next_revision := next_user_revision(test_user_id);
    INSERT INTO timetable_plans (
        user_id,
        client_id,
        name,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        'default',
        '默认课表',
        next_revision,
        now()
    )
    RETURNING id INTO test_plan_id;

    next_revision := next_user_revision(test_user_id);
    INSERT INTO timetable_plan_schedules (
        user_id,
        plan_id,
        schedule_id,
        source,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        test_plan_id,
        'fall-section-a-meeting-1',
        'class_import',
        next_revision,
        now()
    );

    next_revision := next_user_revision(test_user_id);
    INSERT INTO timetable_plan_schedules (
        user_id,
        plan_id,
        schedule_id,
        source,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        test_plan_id,
        'fall-section-a-meeting-2',
        'class_import',
        next_revision,
        now()
    );

    next_revision := next_user_revision(test_user_id);
    INSERT INTO personal_activities (
        user_id,
        client_id,
        title,
        weekday,
        block,
        location,
        color,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        'activity-smoke',
        '小组讨论',
        3,
        2,
        '之远楼',
        'blue',
        next_revision,
        now()
    );

    next_revision := next_user_revision(test_user_id);
    INSERT INTO user_assignments (
        user_id,
        client_id,
        course_id,
        title,
        due_date,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        'assignment-smoke',
        'course-smoke',
        '第三章作业',
        current_date + 7,
        next_revision,
        now()
    );

    next_revision := next_user_revision(test_user_id);
    INSERT INTO user_settings (
        user_id,
        active_plan_client_id,
        favorite_rooms,
        recent_rooms,
        revision,
        client_updated_at
    )
    VALUES (
        test_user_id,
        'default',
        ARRAY['之远楼401'],
        ARRAY['之远楼401', '笃行楼302'],
        next_revision,
        now()
    );

    IF next_revision <> 7 THEN
        RAISE EXCEPTION 'seventh user revision should be 7, got %', next_revision;
    END IF;

    SELECT count(*)
    INTO remaining_rows
    FROM timetable_plan_schedules
    WHERE user_id = test_user_id
      AND deleted_at IS NULL;

    IF remaining_rows <> 2 THEN
        RAISE EXCEPTION 'distinct teaching meetings were collapsed';
    END IF;

    BEGIN
        INSERT INTO timetable_plan_schedules (
            user_id,
            plan_id,
            schedule_id,
            revision,
            client_updated_at
        )
        VALUES (
            other_user_id,
            test_plan_id,
            'invalid-cross-user-meeting',
            1,
            now()
        );
        RAISE EXCEPTION 'cross-user plan relationship was accepted';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;

    DELETE FROM app_users WHERE id IN (test_user_id, other_user_id);

    SELECT
        (SELECT count(*) FROM user_sync_states WHERE user_id = test_user_id)
        + (SELECT count(*) FROM user_profiles WHERE user_id = test_user_id)
        + (SELECT count(*) FROM timetable_plans WHERE user_id = test_user_id)
        + (SELECT count(*) FROM timetable_plan_schedules WHERE user_id = test_user_id)
        + (SELECT count(*) FROM personal_activities WHERE user_id = test_user_id)
        + (SELECT count(*) FROM user_assignments WHERE user_id = test_user_id)
        + (SELECT count(*) FROM user_settings WHERE user_id = test_user_id)
    INTO remaining_rows;

    IF remaining_rows <> 0 THEN
        RAISE EXCEPTION 'personal data did not cascade on account deletion';
    END IF;
END;
$$;

SELECT 'personal cloud data smoke passed' AS result;
