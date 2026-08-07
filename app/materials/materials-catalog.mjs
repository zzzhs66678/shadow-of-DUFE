import manifest from "../../public/data/resource-manifest.json" with { type: "json" };

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·._()（）【】\[\]《》<>/\\-]+/g, "");
}

function cleanFilter(value, maxLength = 80) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function includesNormalized(values, expected) {
  if (!expected) return true;
  const needle = normalize(expected);
  return values.some((value) => normalize(value) === needle);
}

function materialSearchText(material) {
  return normalize(
    [
      material.name,
      material.courseTitle,
      ...(material.courseIds ?? []),
      ...(material.teachers ?? []),
      ...(material.tags ?? []),
      material.category,
      material.kind,
      material.extension,
      material.description,
      ...(material.terms ?? []),
      ...(material.years ?? []),
    ].join(" "),
  );
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
      searchText: materialSearchText(material),
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
  const needle = normalize(query);

  const matches = materials
    .filter((material) => !needle || material.searchText.includes(needle))
    .filter(
      (material) =>
        !course ||
        normalize(material.courseTitle) === normalize(course) ||
        material.courseIds.some((courseId) => normalize(courseId) === normalize(course)),
    )
    .filter((material) => includesNormalized(material.teachers, teacher))
    .filter((material) => !type || normalize(material.kind) === normalize(type))
    .filter((material) => includesNormalized(material.tags, tag))
    .filter((material) => includesNormalized(material.terms, term))
    .filter(
      (material) => !Number.isFinite(year) || material.years.includes(year),
    )
    .sort((a, b) => {
      if (needle) {
        const aName = normalize(a.name);
        const bName = normalize(b.name);
        const aCourse = normalize(a.courseTitle);
        const bCourse = normalize(b.courseTitle);
        const aScore = aName === needle ? 0 : aName.includes(needle) ? 1 : aCourse === needle ? 2 : 3;
        const bScore = bName === needle ? 0 : bName.includes(needle) ? 1 : bCourse === needle ? 2 : 3;
        if (aScore !== bScore) return aScore - bScore;
      }
      return (
        a.courseTitle.localeCompare(b.courseTitle, "zh-CN") ||
        a.name.localeCompare(b.name, "zh-CN")
      );
    });

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
