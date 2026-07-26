let current;
export function setAccessToken(token, expiresAt) { current = { token, expiresAt }; }
export function getAccessToken(now = Date.now()) { if (!current || current.expiresAt <= now) { current = undefined; return undefined; } return current.token; }
export function clearSession() { current = undefined; }
