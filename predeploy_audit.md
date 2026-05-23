# Pre-Deploy Audit Report
**Project:** s2v-aistudio  
**Date:** 2026-05-24  
**Audited by:** Claude Code automated audit  
**Total files flagged:** 58–60 files across 8 categories

---

## 1. DEAD FILES (Zero Imports Pointing To Them)

### ORM Schema Reference
| File | Reason | Action |
|------|--------|--------|
| `drizzle.config.ts` | References `src/server/db/schema.ts` (line 4) which does not exist. Drizzle ORM was abandoned — project now uses Firestore + Supabase. No other file imports drizzle.config.ts. | **DELETE** |

> **Note:** All other .ts/.tsx files in src/ are properly imported and referenced. The import paths use `.js` extensions (TypeScript ESM pattern) which resolve correctly to `.ts` source files at runtime.

---

## 2. LEFTOVER / STALE FILES

### ORM Config
| File | Reason | Action |
|------|--------|--------|
| `drizzle.config.ts` | Drizzle ORM config with no schema. Database layer is Firestore/Supabase. | **DELETE** |

### Test & Debug Scripts (45 files at project root)
All are loose, ad-hoc test/debug scripts that accumulated during development. None are part of the application or a proper test suite.

**Database / env checks:**
| File | Action |
|------|--------|
| `check_custom_key.ts` | DELETE |
| `check_db_constraints.ts` | DELETE |
| `check_db_full.ts` | DELETE |
| `check_env.js` | DELETE |
| `check_env_keys.ts` | DELETE |
| `check-columns.ts` | DELETE |
| `check-logs.ts` | DELETE |
| `compare_keys.ts` | DELETE |
| `get_project_id.ts` | DELETE |
| `inspect_genai.ts` | DELETE |

**Route / API tests:**
| File | Action |
|------|--------|
| `test_admin.ts` | DELETE |
| `test_admin2.ts` | DELETE |
| `test_admin3.ts` | DELETE |
| `test_admin4.ts` | DELETE |
| `test_db.ts` | DELETE |
| `test_health.js` | DELETE |
| `test_rest.ts` | DELETE |
| `test_server.ts` | DELETE |
| `test_server2.ts` | DELETE |
| `test_server3.ts` | DELETE |
| `test_server4.ts` | DELETE |

**Full-flow integration tests:**
| File | Action |
|------|--------|
| `test_full_flow.js` | DELETE |
| `test_frontend.js` | DELETE |
| `test_create_project.js` | DELETE |
| `test_fetch.js` | DELETE |
| `test_browser_full.js` | DELETE |
| `test_html_full.js` | DELETE |
| `test_pipeline.ts` | DELETE |

**Component / service tests:**
| File | Action |
|------|--------|
| `test_cli.ts` | DELETE |
| `test_client.ts` | DELETE |
| `test_img.ts` | DELETE |
| `test_keys.ts` | DELETE |
| `test_render.js` | DELETE |
| `test_screenshot.js` | DELETE |
| `test_scriptwriter.ts` | DELETE |
| `test_zoompan.ts` | DELETE |
| `test-api.ts` | DELETE |
| `test-api-create.ts` | DELETE |

**Utility / setup:**
| File | Action |
|------|--------|
| `make_dummy.js` | DELETE |
| `test_body_text.js` | DELETE |
| `test_env.js` | DELETE |
| `test_text_models.ts` | DELETE |

---

## 3. TEMP / BUILD ARTIFACTS IN SOURCE CONTROL

### Directories
| Path | Status | Contents | Issue | Action |
|------|--------|----------|-------|--------|
| `cache/` | EXISTS & POPULATED | ~115 JPG image files | Rendering cache — build artifact, not source | Already in .gitignore. **Verify not committed.** Clear stale images. |
| `temp/` | EXISTS & POPULATED | 100+ JPG image files | Working directory for image generation | Already in .gitignore. **Verify not committed.** Clear stale artifacts. |
| `piper/` | EXISTS & POPULATED | 63 MB ONNX models + DLLs | TTS binary + voice model files — intentional but too large for git | Already in .gitignore (correct). Contains leftover test artifacts (see below). |
| `dist/` | DOES NOT EXIST | — | Build output dir — correctly absent from source | No action needed. |

### Leftover Test Artifacts Inside piper/
| File | Size | Issue | Action |
|------|------|-------|--------|
| `piper/test.txt` | tiny | Leftover input file from manual Piper TTS testing | **DELETE** |
| `piper/test.wav` | 66 KB | Leftover audio output from manual testing | **DELETE** |
| `piper/test_output.wav` | 67 KB | Leftover audio output from manual testing | **DELETE** |

### Loose Files at Project Root
| File | Size | Issue | Action |
|------|------|-------|--------|
| `dummy.mp3` | 23 KB | Test fixture / stub audio file, not referenced by app | **DELETE** |
| `test.jpg` | 82 bytes | Leftover test image artifact | **DELETE** |
| `server.log` | 423 bytes | Runtime log artifact — should never be committed | **DELETE** + add `*.log` to .gitignore |
| `screenshot.png` | 48 KB | Project screenshot — keep only if referenced in README | Move to `docs/` or **DELETE** if unused |
| `metadata.json` | 275 bytes | Unclear purpose, not referenced anywhere in code | Investigate then **DELETE** if unused |

---

## 4. DUPLICATE / REDUNDANT CODE

### Dead TTS Service
| File | Status | Issue | Action |
|------|--------|-------|--------|
| `src/server/services/piperTtsService.ts` | **IMPORTED NOWHERE** | Superseded by `src/server/services/ttsService.ts`. Has fewer features: basic model selection, no multi-language support, hardcoded model path. | **DELETE** |
| `src/server/services/ttsService.ts` | ✅ Active — imported by `voiceService.ts` | Current implementation: Piper TTS with English/Hindi/Telugu, 60s timeout, FFmpeg silence fallback. | Keep |

### Stub / No-Op Service Files
| File | Issue | Action |
|------|-------|--------|
| `src/services/motionService.ts` | Exports empty/no-op `applyMotion` function. Motion logic is applied directly in `renderService.ts` (zoompan filter). This file adds no behavior. | **DELETE or implement** |
| `src/services/suggestionService.ts` | Exports stub functions returning empty arrays. Suggestions are not wired into any pipeline step. | **DELETE or implement** |

### Full src/services/ Inventory (for reference)
| File | Status | Purpose |
|------|--------|---------|
| `aiService.ts` | ✅ Active | Gemini text + Imagen 3 / Gemini image generation, quota rotation |
| `assetService.ts` | ✅ Active | Image asset generation with Pollinations/Unsplash/color fallbacks |
| `cacheService.ts` | ✅ Active | Local file caching keyed by asset hash |
| `captionService.ts` | ✅ Active | Word-timestamped captions + SRT chunk generation |
| `logService.ts` | ✅ Active (minimal) | User event logging stub |
| `motionService.ts` | ⚠️ STUB | `applyMotion()` — does nothing |
| `qualityService.ts` | ✅ Active | Project quality score calculation |
| `renderService.ts` | ✅ Active | FFmpeg video rendering: Ken Burns, segment assembly, captions, stitch |
| `suggestionService.ts` | ⚠️ STUB | `generateSuggestions()` — returns empty arrays |
| `voiceService.ts` | ✅ Active | Voice synthesis wrapper — caches audio, delegates to ttsService |

---

## 5. PACKAGE.JSON SCRIPTS AUDIT

| Script | Command | Target Exists? | Status |
|--------|---------|----------------|--------|
| `dev` | `tsx server.ts` | ✅ `server.ts` exists at root | ✅ Valid |
| `build` | Vite + esbuild bundling of `server.ts` | ✅ Both tools configured | ✅ Valid |
| `lint` | ESLint on `.ts/.tsx` with rules | ✅ `eslint.config.js` exists | ✅ Valid |
| `start` | `node dist/server.cjs` | ⚠️ `dist/` only exists post-build | ✅ Valid (run after `build`) |
| `preview` | `vite preview` | ✅ Vite configured | ✅ Valid |

**All scripts are valid.** No orphaned build targets or missing entry points.

---

## 6. .GITIGNORE COVERAGE ANALYSIS

### Currently Covered ✅
```
.env
node_modules/
dist/
firebase-applet-config.json   ← Wait: see note below
firebase-blueprint.json
temp/
piper/
cache/
uploads/
renders/
exports/
*.mp4
*.wav
```

### Missing Entries ❌
| Pattern | Files Currently Present | Recommendation |
|---------|------------------------|----------------|
| `*.png` | `screenshot.png` at root | Add `*.png` (or exclude selectively) |
| `*.jpg` / `*.jpeg` | `test.jpg` at root | Add `*.jpg`, `*.jpeg` |
| `*.log` | `server.log` at root | Add `*.log` |
| `*.mp3` | `dummy.mp3` at root | Add `*.mp3` |

### ⚠️ Firebase Config Note
`firebase-applet-config.json` is currently in .gitignore, but this file contains **only public client-side keys** (apiKey, authDomain, projectId, etc.) — it is safe and normal to commit. The dangerous file would be a Firebase service account JSON (e.g. `*-serviceAccount.json` or `firebase-adminsdk-*.json`) — confirm those patterns are excluded.

### Recommended .gitignore Additions
```gitignore
# Generated/runtime files
*.log
*.png
*.jpg
*.jpeg
*.mp3

# OS artifacts
.DS_Store
Thumbs.db
```

---

## 7. ENV FILE HYGIENE

### .env.example ✅
File exists and documents all required variables. Good practice maintained.

### .env (local, not committed) ✅
Present locally, correctly excluded by .gitignore. Contains:
- Multiple `GEMINI_API_KEY_*` pool keys
- `SUPABASE_URL` (public endpoint — low risk)
- `SUPABASE_SERVICE_KEY` (JWT token — **SECRET, must never be committed**)
- `GOOGLE_CLOUD_TTS_API_KEY` (legacy, may be removable after TTS cleanup)

### Hardcoded Secrets in Source ✅ None Found
No API keys or tokens found hardcoded in any `src/` file. All secrets are accessed via `process.env`.

---

## 8. FIREBASE CONFIG IN SOURCE CONTROL

| File | Contains | Safe to Commit? |
|------|----------|-----------------|
| `firebase-applet-config.json` | Public client config: apiKey (public), authDomain, projectId, storageBucket, messagingSenderId, appId | ✅ YES — standard Firebase web config, read-only, not a credential |
| Any `*serviceAccount*.json` | Private key, client_email, private_key_id | ❌ NEVER — confirm none exist in repo |

---

## MASTER CLEANUP CHECKLIST

### 🔴 Critical (delete immediately)
- [ ] `drizzle.config.ts` — dead ORM config
- [ ] `src/server/services/piperTtsService.ts` — dead duplicate TTS service

### 🟠 High Priority (45+ test files at root)
- [ ] All `check_*.ts` / `check_*.js` files (10 files)
- [ ] All `test_*.ts` / `test_*.js` / `test-*.ts` files (35 files)
- [ ] `make_dummy.js`, `get_project_id.ts`, `inspect_genai.ts`, `compare_keys.ts`

### 🟠 High Priority (stub services)
- [ ] `src/services/motionService.ts` — no-op stub
- [ ] `src/services/suggestionService.ts` — no-op stub

### 🟠 High Priority (piper test artifacts)
- [ ] `piper/test.txt`
- [ ] `piper/test.wav`
- [ ] `piper/test_output.wav`

### 🟡 Medium Priority (root artifacts)
- [ ] `dummy.mp3`
- [ ] `test.jpg`
- [ ] `server.log`
- [ ] `metadata.json` (verify unused first)
- [ ] `screenshot.png` (move to `docs/` or delete if not in README)

### 🟡 Medium Priority (.gitignore update)
- [ ] Add `*.png`, `*.jpg`, `*.jpeg`, `*.log`, `*.mp3` to `.gitignore`

### 🟢 Low Priority (housekeeping)
- [ ] Move `PRD.md` → `docs/PRD.md`
- [ ] Move `storage.rules` → `firestore/storage.rules`
- [ ] Verify `cache/` and `temp/` are not already tracked in git (`git ls-files cache/ temp/`)
- [ ] Confirm no Firebase service account JSON files exist anywhere in repo

---

## TOTALS BY CATEGORY

| Category | Files to Remove |
|----------|-----------------|
| Dead ORM config | 1 |
| Root test/debug scripts | ~45 |
| Stub service files | 2 |
| Dead TTS service | 1 |
| Piper test artifacts | 3 |
| Root loose artifacts | 4–5 |
| .gitignore additions | 0 deletions, 5 pattern adds |
| **TOTAL** | **~57–58 deletions** |
