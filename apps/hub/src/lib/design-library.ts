import {
  DESIGN_USES,
  designLibrarySchema,
  type DesignCategory,
  type DesignItem,
  type DesignLibrary,
  type DesignUse,
} from '@the40thieves/schemas';

import raw from '../../../../data/design-library.json' with { type: 'json' };

/**
 * `data/design-library.json`, validated once at build time. The `/design/library/` page, its
 * Markdown twin and the JSON route all read this one value, so they never disagree.
 */
export const designLibrary: DesignLibrary = designLibrarySchema.parse(raw);

/** The label and one-line meaning of each use status, in schema order. */
export const USE_NOTES: Record<DesignUse, { label: string; note: string }> = {
  clear: {
    label: 'Clear',
    note: 'an open licence, or terms that allow commercial use without a notable condition',
  },
  conditions: {
    label: 'Conditions',
    note: 'commercial use is allowed with a condition to know first: a paid tier, a size cap, copyleft, a Commons Clause or attribution',
  },
  study: { label: 'Study', note: 'reference or inspiration only; no reuse rights are granted' },
};

/** `205 resources: 61 clear, 19 conditions, 125 study.` */
export function useSummary(file: DesignLibrary): string {
  const parts = DESIGN_USES.map(
    (use) => `${String(file.items.filter((item) => item.use === use).length)} ${use}`,
  );
  return `${String(file.items.length)} resources: ${parts.join(', ')}.`;
}

/** Items grouped by category, in the file's category order; empty categories are left out. */
export function byCategory(
  file: DesignLibrary,
): Array<{ category: DesignCategory; items: DesignItem[] }> {
  return file.categories
    .map((category) => ({
      category,
      items: file.items.filter((item) => item.category === category.id),
    }))
    .filter((group) => group.items.length > 0);
}

/** `example.com` for `https://www.example.com/path`. */
export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}
