export function extractHostHeader(
  value: string | string[] | undefined,
): string | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] || '' : value;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    return trimmed.slice(0, end + 1);
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
}

export function isAllowedLoopbackHost(
  hostHeader: string | string[] | undefined,
  additionalHosts: string[] = [],
): boolean {
  const host = extractHostHeader(hostHeader);
  if (!host) return false;
  const allowed = new Set(
    ['127.0.0.1', 'localhost', '::1', '[::1]', ...additionalHosts]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(host);
}
