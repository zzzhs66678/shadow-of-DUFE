import manifest from "../../public/data/resource-manifest.json" with { type: "json" };
import { matchesMaterialFilters, scoreMaterialSearch } from "./materials-search.ts";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

function cleanFilter(value, maxLength = 80) {
  return String(value ?? "").trim().slice(0, maxLength);
}

const materials = Object.freeze(
  manifest.materials.map((material) =>
    Object.freeze({
      ...material,
      teachers: Object.freeze([...(material.teachers ?? [])]),
      colleges: Object.freeze([...(material.colleges ?? [])]),
      terms: Object.freeze([...(material.terms ?? [])]),
      years: Object.freeze([...(material.years ?? [])]),
      tags: Object.freeze([...(material.tags ?? [])]),
    }),
  ),
);

const materialsById = new Map(materials.map((material) => [material.id, material]));

function publicMaterial(material) {
  if (!material) return null;
  return Object.fromEntries(
    Object.entries(material).filter(([key]) => key !== "searchText"),
  );
}

export function getMaterialById(materialId) {
  return publicMaterial(materialsById.get(cleanFilter(materialId, 64)));
}

export function getMaterialPaths() {
  return [...materialsById.keys()].map((id) => `/materials/${encodeURIComponent(id)}`);
}

export function getMaterialFilters() {
  const unique = (values) =>
    [...new Set(values.filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), "zh-CN"),
    );
  return {
    courses: unique(materials.map((item) => item.courseTitle)),
    teachers: unique(materials.flatMap((item) => item.teachers)),
    types: unique(materials.map((item) => item.kind)),
    tags: unique(materials.flatMap((item) => item.tags)),
    terms: unique(materials.flatMap((item) => item.terms)),
    years: unique(materials.flatMap((item) => item.years)),
  };
}

export function searchMaterials(input = {}) {
  const query = cleanFilter(input.query);
  const course = cleanFilter(input.course);
  const teacher = cleanFilter(input.teacher);
  const type = cleanFilter(input.type);
  const tag = cleanFilter(input.tag);
  const term = cleanFilter(input.term, 16);
  const year = Number.parseInt(cleanFilter(input.year, 4), 10);
  const requestedLimit = Number.parseInt(cleanFilter(input.limit, 3), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const requestedOffset = Number.parseInt(cleanFilter(input.offset, 8), 10);
  const offset = Number.isFinite(requestedOffset)
    ? Math.max(requestedOffset, 0)
    : 0;
  const matches = materials
    .filter((material) => matchesMaterialFilters(material, { query, course, teacher, type, tag, term, year }))
    .map((material) => ({ material, score: scoreMaterialSearch(material, query) }))
    .sort((a, b) => {
      return (
        b.score - a.score ||
        a.material.courseTitle.localeCompare(b.material.courseTitle, "zh-CN") ||
        a.material.name.localeCompare(b.material.name, "zh-CN") ||
        a.material.id.localeCompare(b.material.id)
      );
    }).map(({ material }) => material);

  return {
    items: matches.slice(offset, offset + limit).map(publicMaterial),
    total: matches.length,
    offset,
    limit,
    hasMore: offset + limit < matches.length,
  };
}

export const materialCatalogMeta = Object.freeze({
  schemaVersion: manifest.schemaVersion ?? 1,
  generatedAt: manifest.generatedAt,
  total: materials.length,
});
