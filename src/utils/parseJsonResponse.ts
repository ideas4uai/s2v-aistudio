/**
 * Parse JSON out of an LLM response, tolerating the prose or ```json fences
 * models wrap it in. Same recovery the pipeline agents do inline; extracted so
 * the studio agents don't add a seventh copy.
 */
export function parseJsonResponse<T = any>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Fall through to brace/bracket extraction.
  }
  const text = raw.trim();
  // Take the widest span so nested objects survive; an array response is valid too.
  const start = [text.indexOf('{'), text.indexOf('[')].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === undefined || end === -1 || end < start) {
    throw new Error(`No JSON found in model response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}
