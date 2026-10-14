/**
 * Select source slide HTML files for a PDF export. Page numbers are one-based
 * user-facing deck positions; omitting them retains the complete deck.
 */
export function selectPdfSlideHtmlPaths(
  htmlPaths: string[],
  pageNumbers: number[] | undefined,
): string[] {
  if (pageNumbers === undefined) return htmlPaths;

  const selected = [...new Set(pageNumbers)].sort((left, right) => left - right);
  if (
    selected.length === 0 ||
    selected.some((pageNumber) => !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > htmlPaths.length)
  ) {
    throw new Error('"page_numbers" must contain valid one-based pages from this deck');
  }

  return selected.map((pageNumber) => htmlPaths[pageNumber - 1]!);
}
