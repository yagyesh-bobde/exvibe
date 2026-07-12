/**
 * Port of pipeline.py `extract_json` — pull a JSON object out of a claude
 * stdout blob: strip code fences, take the outermost {...}, JSON.parse.
 */

export function extractJson(blob: string): Record<string, unknown> | null {
  let s = blob.trim();
  // strip code fences if claude wraps despite instruction
  s = s.replace(/^```(?:json)?\s*/, '');
  s = s.replace(/\s*```$/, '');
  // find outermost {...}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(s.slice(start, end + 1));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (e) {
    console.error(`[pipeline] JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
