import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadImageAsBase64 } from '../src/utils/imageRef.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageref-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('loadImageAsBase64', () => {
  it('reads a local file path (anchor fallback when Supabase upload fails)', async () => {
    const file = path.join(dir, 'anchor.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(file, bytes);
    const result = await loadImageAsBase64(file);
    expect(result).not.toBeNull();
    expect(result!.data).toBe(bytes.toString('base64'));
    expect(result!.mimeType).toBe('image/png');
  });

  it('returns null (not throw) for a missing local file', async () => {
    const result = await loadImageAsBase64(path.join(dir, 'missing.png'));
    expect(result).toBeNull();
  });

  it('fetches http(s) URLs and infers jpeg mime for non-png refs', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadImageAsBase64('https://supabase.example/anchors/veer.jpg');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result!.data).toBe(bytes.toString('base64'));
    expect(result!.mimeType).toBe('image/jpeg');
  });

  it('returns null when the http fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const result = await loadImageAsBase64('https://supabase.example/gone.png');
    expect(result).toBeNull();
  });
});
