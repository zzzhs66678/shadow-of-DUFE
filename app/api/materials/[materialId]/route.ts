import { getMaterialById } from "../../../materials/materials-catalog.mjs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ materialId: string }> },
) {
  const { materialId } = await context.params;
  const material = getMaterialById(materialId);
  if (!material) {
    return Response.json(
      { error: "material_not_found", message: "这份资料不存在或已撤下。" },
      {
        status: 404,
        headers: { "Cache-Control": "public, max-age=60" },
      },
    );
  }
  return Response.json(
    { material },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    },
  );
}
