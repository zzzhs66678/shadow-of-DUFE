import {
  getMaterialFilters,
  materialCatalogMeta,
  searchMaterials,
} from "../../materials/materials-catalog.mjs";

const cacheHeaders = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
  "Content-Type": "application/json; charset=utf-8",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = searchMaterials({
    query: url.searchParams.get("q"),
    course: url.searchParams.get("course"),
    teacher: url.searchParams.get("teacher"),
    type: url.searchParams.get("type"),
    tag: url.searchParams.get("tag"),
    term: url.searchParams.get("term"),
    year: url.searchParams.get("year"),
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  return new Response(
    JSON.stringify({
      ...result,
      filters: getMaterialFilters(),
      catalog: materialCatalogMeta,
    }),
    { status: 200, headers: cacheHeaders },
  );
}
