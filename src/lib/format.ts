/** Convert a slug-style value to title-case display text.
 *  "sweet_treat" → "Sweet Treat"
 *  "nuts-seeds"  → "Nuts Seeds"
 */
export function toDisplayLabel(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Split a possibly comma-separated multi-value field into individual trimmed values. */
export function splitValues(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

/** Parse one method step for a bold label.
 *  Handles two stored formats:
 *    **Label** rest of step    (markdown bold from migration)
 *    Label: rest of step       (plain-text label with colon, for new recipes)
 *  Returns { label, body } where label may be null.
 */
export function parseStepLabel(step: string): { label: string | null; body: string } {
  // Markdown bold: **Label** body
  const md = step.match(/^\*\*([^*]+)\*\*\s*([\s\S]*)/);
  if (md) return { label: md[1].replace(/:$/, ''), body: md[2] };

  // Plain colon label: up to 40 chars before the first colon
  const colon = step.match(/^([^:]{1,40}):\s+([\s\S]+)/);
  if (colon) return { label: colon[1], body: colon[2] };

  return { label: null, body: step };
}

/** Strip leading "- " or "* " bullet from a text line. */
export function stripBullet(line: string): string {
  return line.replace(/^[-*]\s+/, '').trim();
}
