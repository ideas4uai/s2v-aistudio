import fs from 'fs';
import path from 'path';

export const getFromCache = async (key: string) => {
  const cacheDir = path.resolve('cache');
  if (!fs.existsSync(cacheDir)) return null;
  const files = fs.readdirSync(cacheDir);
  const found = files.find(f => f.startsWith(key));
  if (found) {
    const fullPath = path.resolve('cache', found);
    return fullPath;
  }
  return null;
};

export const saveToCache = async (key: string, data: any) => {
  const cacheDir = path.resolve('cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  
  if (typeof data === 'string' && fs.existsSync(data)) {
    // data is a file path
    const ext = path.extname(data);
    const dest = path.resolve(cacheDir, key + ext);
    fs.copyFileSync(data, dest);
    return dest;
  }
  return data;
};