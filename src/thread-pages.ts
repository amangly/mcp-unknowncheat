export const DEFAULT_RECENT_PAGES = 3;

export function recentPageNumbers(totalPages: number, count = DEFAULT_RECENT_PAGES): number[] {
  const last = Math.max(1, Math.floor(totalPages));
  const first = Math.max(1, last - Math.max(0, Math.floor(count)) + 1);
  return count > 0 ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : [];
}

export function bulkPageNumbers(totalPages: number, latestPages = DEFAULT_RECENT_PAGES, fetchAll = false, maxAllPages = 10): number[] {
  if (fetchAll) {
    return Array.from({ length: Math.min(Math.max(1, Math.floor(totalPages)), maxAllPages) }, (_, index) => index + 1);
  }
  return [1, ...recentPageNumbers(totalPages, latestPages).filter((page) => page > 1)];
}
