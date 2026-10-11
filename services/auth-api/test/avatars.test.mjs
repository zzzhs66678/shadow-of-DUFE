import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createAvatarProcessor } from "../src/avatars.mjs";

test("avatar processor verifies magic bytes, crops safely, and strips metadata", async () => {
  const source = await sharp({
    create: {
      width: 80,
      height: 120,
      channels: 3,
      background: { r: 181, g: 38, b: 38 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const processor = createAvatarProcessor();
  const avatar = await processor.process(source, "image/jpeg");
  const metadata = await sharp(avatar.bytes).metadata();

  assert.equal(avatar.contentType, "image/webp");
  assert.equal(avatar.width, 512);
  assert.equal(avatar.height, 512);
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.exif, undefined);
  assert.match(avatar.sha256, /^[0-9a-f]{64}$/);

  await assert.rejects(
    () => processor.process(source, "image/png"),
    { code: "AVATAR_INVALID_IMAGE" },
  );
  await assert.rejects(
    () => processor.process(Buffer.from("not an image"), "image/jpeg"),
    { code: "AVATAR_INVALID_IMAGE" },
  );
});

test("avatar processor enforces the input byte limit before decoding", async () => {
  const processor = createAvatarProcessor({ maxInputBytes: 8 });
  await assert.rejects(
    () => processor.process(Buffer.alloc(9), "image/png"),
    { code: "AVATAR_TOO_LARGE" },
  );
});

test("SVG uploads are rejected before image decoding, including a forged raster MIME type", async () => {
  const processor = createAvatarProcessor();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  await assert.rejects(() => processor.process(svg, "image/svg+xml"), { code: "AVATAR_TYPE_UNSUPPORTED" });
  await assert.rejects(() => processor.process(svg, "image/png"), { code: "AVATAR_INVALID_IMAGE" });
});
