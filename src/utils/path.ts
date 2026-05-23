import path from 'path';

export function toUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  
  const root = process.cwd();
  let normalized = filePath.replace(/\\/g, '/');
  
  // If it's an absolute path starting with the root
  if (normalized.startsWith(root.replace(/\\/g, '/'))) {
    normalized = normalized.substring(root.length);
  }
  
  // If it's still an absolute path (on unix) but not starting with root,
  // we check if it contains one of our known folders
  const folders = ['outputs', 'uploads', 'cache', 'temp'];
  for (const folder of folders) {
    const searchStr = `/${folder}/`;
    const idx = normalized.indexOf(searchStr);
    if (idx !== -1) {
      return normalized.substring(idx);
    }
    // Check if it starts with the folder if it's already relative-ish
    if (normalized.startsWith(`${folder}/`)) {
      return '/' + normalized;
    }
  }
  
  // Ensure it starts with / if it's relative to root
  if (!normalized.startsWith('/') && !normalized.includes('://')) {
    return '/' + normalized;
  }
  
  return normalized;
}
