import { getMaterialById } from "../../../materials/materials-catalog.mjs";

// Public catalog lookup only; never reads bookmarks, cookies or protected files.
// POST keeps the user's private collection out of query strings and shared caches.
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store, private" };
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return Response.json({ error: "invalid_material_ids" }, { status: 400, headers });
  }
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "invalid_material_ids" }, { status: 400, headers });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24_000) {
        await reader.cancel();
        return Response.json({ error: "material_ids_too_large" }, { status: 413, headers });
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Object.keys(body).join() !== "ids" || !Array.isArray(body.ids) || body.ids.length > 1000 ||
        body.ids.some((id: unknown) => typeof id !== "string" || !/^[0-9a-f]{20}$/.test(id))) throw new Error("invalid_ids");
    const ids = [...new Set<string>(body.ids)];
    return Response.json({ items: ids.map((materialId) => ({ materialId, material: getMaterialById(materialId) })) }, { headers });
  } catch {
    return Response.json({ error: "invalid_material_ids" }, { status: 400, headers });
  } finally { reader.releaseLock(); }
}
