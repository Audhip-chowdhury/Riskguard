export function getPagination(query: Record<string, unknown>) {
  const page = Math.max(1, parseInt((query.page as string) || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt((query.limit as string) || '10', 10)));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}
