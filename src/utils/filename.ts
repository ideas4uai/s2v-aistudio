// Human-readable names for rendered videos.
//
// Output files used to be named `{project-uuid}.mp4`, which is unusable once there
// are more than a couple of them in a folder. Names are now `{title-slug}-{uuid8}.mp4`:
// the slug is what a human reads, the 8-char uuid prefix keeps two projects with the
// same title from overwriting each other and keeps the file traceable to its record.

const MAX_SLUG_LENGTH = 60;

/**
 * ASCII slug for a project title.
 *
 * Deliberately ASCII-only. Filenames here end up in URLs (`/outputs/<file>`), ffmpeg
 * command strings and Supabase object keys, and non-ASCII survives that trip
 * inconsistently across Windows codepages and URL encoders. A title with no ASCII
 * letters or digits (Hindi, Telugu, emoji-only) yields '' and the caller falls back
 * to a generic stem — the uuid still identifies the file. Transliteration would be
 * nicer but needs a dependency per script; see the report.
 */
export function slugifyTitle(title?: string | null): string {
  return (title || '')
    .normalize('NFKD')                 // "café" -> "cafe" + combining accent
    .replace(/[̀-ͯ]/g, '')  // drop the accents themselves
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')       // anything else is a separator
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');              // truncation must not leave a trailing dash
}

/** First uuid group — short enough to read, wide enough to not collide in practice. */
export function shortId(projectId?: string | null): string {
  const compact = String(projectId || '').replace(/[^a-zA-Z0-9]/g, '');
  return compact.slice(0, 8) || 'unknown';
}

/**
 * Filename for a project's rendered video, e.g. `what-is-a-rest-api-04fa8d80.mp4`.
 * `suffix` covers variants like '_preview'.
 */
export function projectVideoFileName(title: string | null | undefined, projectId: string, suffix = ''): string {
  return `${slugifyTitle(title) || 'video'}-${shortId(projectId)}${suffix}.mp4`;
}
