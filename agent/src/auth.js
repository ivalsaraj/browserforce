export function verifyBearer(req, expectedToken) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  return token === expectedToken;
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol === 'chrome-extension:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
