import { createHash } from "node:crypto";
import sharp from "sharp";

const ACCEPTED_FORMATS = new Map([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 4_096;
const OUTPUT_SIZE = 512;
const MAX_OUTPUT_BYTES = 524_288;

function avatarError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createAvatarProcessor({ maxInputBytes = 5_242_880 } = {}) {
  return {
    acceptedContentTypes: new Set(ACCEPTED_FORMATS.keys()),
    maxInputBytes,

    async process(input, contentType) {
      if (!Buffer.isBuffer(input) || input.length === 0) {
        throw avatarError("AVATAR_EMPTY");
      }
      if (input.length > maxInputBytes) {
        throw avatarError("AVATAR_TOO_LARGE");
      }
      const expectedFormat = ACCEPTED_FORMATS.get(contentType);
      if (!expectedFormat) throw avatarError("AVATAR_TYPE_UNSUPPORTED");

      let metadata;
      try {
        metadata = await sharp(input, {
          animated: false,
          failOn: "error",
          limitInputPixels: MAX_PIXELS,
        }).metadata();
      } catch {
        throw avatarError("AVATAR_INVALID_IMAGE");
      }
      if (
        metadata.format !== expectedFormat ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > MAX_DIMENSION ||
        metadata.height > MAX_DIMENSION ||
        (metadata.pages ?? 1) > 1
      ) {
        throw avatarError("AVATAR_INVALID_IMAGE");
      }

      let processed;
      try {
        processed = await sharp(input, {
          animated: false,
          failOn: "error",
          limitInputPixels: MAX_PIXELS,
        })
          .rotate()
          .resize(OUTPUT_SIZE, OUTPUT_SIZE, {
            fit: "cover",
            position: "attention",
          })
          .webp({ quality: 82, effort: 4 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw avatarError("AVATAR_INVALID_IMAGE");
      }
      if (processed.data.length > MAX_OUTPUT_BYTES) {
        throw avatarError("AVATAR_OUTPUT_TOO_LARGE");
      }

      return {
        bytes: processed.data,
        contentType: "image/webp",
        sha256: createHash("sha256").update(processed.data).digest("hex"),
        width: processed.info.width,
        height: processed.info.height,
        byteSize: processed.data.length,
      };
    },
  };
}
