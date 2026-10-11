CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
    scope text NOT NULL,
    key_digest bytea NOT NULL,
    tokens double precision NOT NULL,
    updated_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    PRIMARY KEY (scope, key_digest),
    CONSTRAINT api_rate_limit_scope_format_chk
        CHECK (scope ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CONSTRAINT api_rate_limit_key_digest_length_chk
        CHECK (octet_length(key_digest) = 32),
    CONSTRAINT api_rate_limit_tokens_nonnegative_chk
        CHECK (tokens >= 0)
);

CREATE INDEX IF NOT EXISTS api_rate_limit_buckets_last_seen_idx
    ON api_rate_limit_buckets (last_seen_at);

CREATE OR REPLACE FUNCTION consume_api_rate_limit(
    p_scope text,
    p_key_digest bytea,
    p_capacity double precision,
    p_refill_per_second double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    observed_at timestamptz := clock_timestamp();
    stored_tokens double precision;
    stored_updated_at timestamptz;
    available_tokens double precision;
    allowed boolean;
BEGIN
    IF p_scope IS NULL
       OR p_scope !~ '^[a-z][a-z0-9._-]{0,63}$'
       OR p_key_digest IS NULL
       OR octet_length(p_key_digest) <> 32
       OR p_capacity IS NULL
       OR p_capacity < 1
       OR p_refill_per_second IS NULL
       OR p_refill_per_second <= 0 THEN
        RAISE EXCEPTION 'invalid API rate limit parameters'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.api_rate_limit_buckets (
        scope,
        key_digest,
        tokens,
        updated_at,
        last_seen_at
    )
    VALUES (
        p_scope,
        p_key_digest,
        p_capacity,
        observed_at,
        observed_at
    )
    ON CONFLICT (scope, key_digest) DO NOTHING;

    SELECT tokens, updated_at
    INTO stored_tokens, stored_updated_at
    FROM public.api_rate_limit_buckets
    WHERE scope = p_scope
      AND key_digest = p_key_digest
    FOR UPDATE;

    available_tokens := LEAST(
        p_capacity,
        stored_tokens + GREATEST(
            0,
            EXTRACT(EPOCH FROM (observed_at - stored_updated_at))
        ) * p_refill_per_second
    );
    allowed := available_tokens >= 1;

    UPDATE public.api_rate_limit_buckets
    SET
        tokens = CASE
            WHEN allowed THEN available_tokens - 1
            ELSE available_tokens
        END,
        updated_at = observed_at,
        last_seen_at = observed_at
    WHERE scope = p_scope
      AND key_digest = p_key_digest;

    RETURN allowed;
END;
$$;

COMMENT ON TABLE api_rate_limit_buckets IS
    'Shared token buckets keyed only by HMAC digests; no raw account or network identifiers.';
COMMENT ON FUNCTION consume_api_rate_limit(text, bytea, double precision, double precision) IS
    'Atomically refills and consumes one token under a row lock.';

REVOKE ALL PRIVILEGES ON api_rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_api_rate_limit(text, bytea, double precision, double precision) FROM PUBLIC;
