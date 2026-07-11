import * as fs from 'fs';

// Loads a reference image as base64 from either an http(s) URL or a local
// file path. Character anchors fall back to local temp paths when the
// Supabase upload fails, so consumers must handle both forms.
export async function loadImageAsBase64(ref: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    let buf: Buffer;
    if (/^https?:\/\//i.test(ref)) {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      buf = fs.readFileSync(ref);
    }
    const mimeType = ref.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
    return { data: buf.toString('base64'), mimeType };
  } catch (e: any) {
    console.warn('[ImageRef] Could not load reference image:', ref.slice(-60), '—', e?.message);
    return null;
  }
}
