import { Router } from 'express';
import {
  listKeys, addKey, updateKey, removeKey, publicView,
  KEY_CATEGORIES, CATEGORY_INFO, isKeyCategory,
} from '../services/apiKeyStore.js';
import { getPoolStatus } from '../../utils/geminiAuth.js';
import { logEvent } from '../../services/logService.js';

/**
 * Managing the AI Studio key pool.
 *
 * A stored key is never returned in full by any route here. The UI shows the last four
 * characters, which is enough to tell two keys apart and no use to anyone who reads
 * them — the same reason a payment form shows •••• 4242. There is deliberately no
 * "reveal" endpoint: a key that has to be recovered is a key that should be replaced
 * at the source, which takes seconds at aistudio.google.com/apikey.
 */
export const apiKeysRouter = Router();

/** The category vocabulary, so the UI does not restate a list the server owns. */
apiKeysRouter.get('/categories', (_req, res) => {
  res.json(KEY_CATEGORIES.map((id) => ({ id, ...CATEGORY_INFO[id] })));
});

/** Every key, masked, with pool health per category. */
apiKeysRouter.get('/', (_req, res) => {
  try {
    res.json({
      keys: listKeys().map(publicView),
      pools: Object.fromEntries(
        KEY_CATEGORIES.map((c) => [c, getPoolStatus(c === 'image' ? 'image' : 'script')]),
      ),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not read the key store' });
  }
});

apiKeysRouter.post('/', (req, res) => {
  const { key, label, category } = req.body ?? {};
  if (!isKeyCategory(category)) {
    return res.status(400).json({ error: `category must be one of: ${KEY_CATEGORIES.join(', ')}` });
  }
  try {
    const rec = addKey({ key: String(key ?? ''), label, category });
    // The key itself is never logged, only that one was added and which pool it joined.
    logEvent('api_key_added', undefined, { category, id: rec.id });
    res.status(201).json(publicView(rec));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Could not save that key' });
  }
});

/** Enable/disable, relabel, or move between pools. The secret itself is not editable. */
apiKeysRouter.patch('/:id', (req, res) => {
  const { enabled, label, category } = req.body ?? {};
  if (category !== undefined && !isKeyCategory(category)) {
    return res.status(400).json({ error: `category must be one of: ${KEY_CATEGORIES.join(', ')}` });
  }
  const rec = updateKey(req.params.id, (k) => {
    if (typeof enabled === 'boolean') k.enabled = enabled;
    if (typeof label === 'string') k.label = label.trim() || undefined;
    if (isKeyCategory(category)) k.category = category;
  });
  if (!rec) return res.status(404).json({ error: 'No such key' });
  res.json(publicView(rec));
});

apiKeysRouter.delete('/:id', (req, res) => {
  if (!removeKey(req.params.id)) return res.status(404).json({ error: 'No such key' });
  logEvent('api_key_removed', undefined, { id: req.params.id });
  res.json({ ok: true });
});
