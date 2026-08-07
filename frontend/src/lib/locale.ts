/**
 * UI language key (O4): the language key of template labels, not a BCP-47 tag.
 * English is the only copy (index.html lang="en"); change this when adding
 * languages later.
 * A function rather than an exported constant so tests can vi.mock it.
 */
export function uiLocale(): string {
  return "en";
}
