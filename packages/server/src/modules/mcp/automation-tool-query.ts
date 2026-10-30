export function pageQuery(args: Readonly<Record<string, unknown>>) {
  return { ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
    ...(typeof args.limit === 'number' ? { limit: String(args.limit) } : {}) };
}
