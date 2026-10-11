export type CatalogKind = 'courses' | 'materials';
export type CatalogRow = Record<string, string>;
export interface CatalogImportIssue { row: number; field: string; message: string }
export interface CatalogChange { id: string; label: string; action: 'added' | 'updated' | 'removed'; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface CatalogImportResult<T> { payload: T; summary: { added: number; updated: number; removed: number; unchanged: number }; changes: CatalogChange[]; errors: CatalogImportIssue[]; warnings: string[] }
export const CATALOG_COLUMNS: Readonly<Record<CatalogKind, readonly string[]>>;
export class CatalogImportError extends Error { errors: CatalogImportIssue[]; constructor(errors: CatalogImportIssue[]) }
export function parseCatalogCsv(text: string): CatalogRow[];
export function writeCatalogCsv(rows: readonly CatalogRow[], columns: readonly string[]): string;
export function exportCatalogRows(kind: CatalogKind, payload: unknown): CatalogRow[];
export function applyCatalogImport<T>(kind: CatalogKind, rows: readonly CatalogRow[], base: T, courseCatalog?: unknown): CatalogImportResult<T>;
export function isSafeMaterialUrl(value: string): boolean;
