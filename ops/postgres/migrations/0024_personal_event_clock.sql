-- Additive: NULL clock fields identify untouched legacy weekly block events.
ALTER TABLE personal_activities
    ADD COLUMN start_time text,
    ADD COLUMN end_time text,
    ADD COLUMN event_date date,
    ADD COLUMN repeat_rule text;

ALTER TABLE personal_activities ADD CONSTRAINT personal_activities_clock_check CHECK (
    (start_time IS NULL AND end_time IS NULL AND event_date IS NULL AND repeat_rule IS NULL)
    OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND repeat_rule IS NOT NULL
     AND start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND end_time > start_time
     AND repeat_rule IN ('none', 'weekly')
     AND (repeat_rule = 'weekly' OR event_date IS NOT NULL)
     AND (event_date IS NULL OR event_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31')
     AND (event_date IS NULL OR extract(isodow FROM event_date) = weekday))
);
COMMENT ON TABLE personal_activities IS
    'Personal same-day clock events (one-off or weekly), with legacy weekly blocks preserved.';
