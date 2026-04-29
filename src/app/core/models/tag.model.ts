export interface TagCatalogItem {
  /**
   * Display label preserved as the user typed (trimmed, single-spaced).
   * Uniqueness is enforced at the service layer using a normalized form.
   */
  name: string;

  /** Hex color (e.g. `#1168d9`). */
  color: string;
}

export const TAG_PALETTE = [
  '#1168d9',
  '#0f9f78',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#4d7c0f',
  '#be185d'
];

export function normalizeTagName(value: string): string {
  return (value ?? '').trim().toLocaleLowerCase('pt-BR');
}

export function normalizeTagLabel(value: string): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

export function pickTagColor(existing: ReadonlyArray<TagCatalogItem>): string {
  const used = new Set(existing.map((tag) => (tag.color || '').toLowerCase()));
  const available = TAG_PALETTE.find((color) => !used.has(color.toLowerCase()));
  return available ?? TAG_PALETTE[existing.length % TAG_PALETTE.length];
}
