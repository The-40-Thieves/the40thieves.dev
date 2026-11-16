/**
 * URL-safe, stable slug for a repository name: lower case, runs of anything outside
 * `[a-z0-9]` collapse to one hyphen, no leading or trailing hyphen.
 * `Suavecitos-Soundboost.AI-Toolkit` becomes `suavecitos-soundboost-ai-toolkit`.
 */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
