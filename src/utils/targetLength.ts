// Parses a targetLength setting into seconds. Accepts '30s', '60s', '3m',
// '5m', '10m', bare numbers ('300' or 300 = seconds) — scales linearly for
// any length instead of silently falling back to 60s for unknown values.
export const targetLengthSeconds = (t: unknown): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m)?$/.exec(String(t ?? '').trim());
  return m ? parseFloat(m[1]) * (m[2] === 'm' ? 60 : 1) : 60;
};
