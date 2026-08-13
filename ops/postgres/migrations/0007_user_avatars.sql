CREATE TABLE IF NOT EXISTS user_avatars (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    content_type text NOT NULL CHECK (content_type = 'image/webp'),
    image_bytes bytea NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    width integer NOT NULL CHECK (width = 512),
    height integer NOT NULL CHECK (height = 512),
    byte_size integer NOT NULL CHECK (
        byte_size BETWEEN 1 AND 524288
        AND byte_size = octet_length(image_bytes)
    ),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_avatars IS
    '用户头像的规范化 WebP；原图不落库，上传后剥离 EXIF 并限制尺寸。';
