# AI Content Studio — Architecture

AI Content Studio is a planning and memory layer upstream of Script2Video. It does not modify or invoke the renderer. Its only renderer-facing boundary is a versioned Production Package, mapped to a draft `Project` at the final workflow stage.

## Scope: what this adds, and what it deliberately reuses

The studio owns what Script2Video has no answer for today: **persistent knowledge** (character/brand/style bibles that survive across episodes), **cross-episode memory**, **quality scoring**, **publishing copy**, and **multi-provider text generation**.

It does *not* re-implement scene breakdown, image prompting, or scriptwriting. The `package` stage delegates to the existing `DirectorAgent` → `ScriptwriterAgent` → `StoryboardAgent`, which already carry the few-shot prompts, shot-type rotation, character anchors, and LoRA routing that every render depends on. Forking that prompt engineering would mean maintaining two versions of it.

## Workflow: four stages

| Stage | Responsibility | LLM calls |
| --- | --- | --- |
| `idea` | Generate and rank candidate angles on the seed topic. Winner becomes the title; runners-up are kept in `qualityScores.notes`. | 1 |
| `story` | Narrative spine (hook, conflict, escalation, twist, lesson, CTA) **plus self-scored review** in the same call. Gates on human approval. | 1 |
| `package` | Delegates to the pipeline agents for scenes/dialogue/image prompts, then writes publishing copy. | 1 (+ the pipeline's 3) |
| `handoff` | Maps the package to a draft `Project` and persists it via `saveProjectState`. | 0 |

The spec this was built from called for nine stages. Idea/story/scene/dialogue/image-prompt/thumbnail/caption collapsed to four because the middle five duplicated pipeline agents, and `review` was a second round-trip to grade text the model had just written.

## Central contract

`ProductionPackage` (`src/content-studio/domain/types.ts`) is the single cross-agent payload. Agents receive a snapshot, make their scoped update, and return it; the coordinator validates the **output** with `validateProductionPackage` before persisting. Agents never call each other or touch Script2Video project state.

Namespaced `extension` slots (animation, camera, motion, lip-sync) are reserved so later capabilities don't require a destructive migration.

## Persistence

`StudioStore` (`src/content-studio/store.ts`) mirrors the pipeline's local-first pattern from `projectDiskStore.ts`:

- `DISABLE_FIRESTORE=true` → atomic write-then-rename to `outputs/content-studio/{collection}/{id}.json`
- otherwise → `FirestoreService`

This matters because `FirestoreService` returns *without writing* when there is no auth token, and both `npm run dev` (fake `__dev__` token) and `npm run render` (`DISABLE_FIRESTORE=true`) hit that path. Going straight to Firestore made every studio write a silent no-op that still returned 200.

`StudioStore.save` also mirrors `ownerId` into `userId`, because Firestore's `listDocuments` filters server-side on `userId` and production packages key ownership off `ownerId`.

Collections in use: `contentStudioEpisodes`, `contentStudioProductionPackages`, `contentStudioKnowledge`, `contentStudioKnowledgeVersions`, `contentStudioWorkflowRuns`, `contentStudioAgentLogs`. Every document carries `userId`, `createdAt`, `updatedAt`; API reads re-check ownership after fetching so collection layout never becomes the authorization boundary.

## Text providers

`src/services/text/` resolves an ordered chain from `TEXT_PROVIDERS` (default `gemini`):

- `gemini` — wraps the existing `AIService.generateText`, inheriting four-key quota rotation and the 429/503 model fallback
- `openai` / `openrouter` / `local` — one `openAiCompatProvider`, since all three speak `/chat/completions`
- `anthropic` — official SDK; separate because the Messages API shape differs

A circuit breaker opens on 401/402/403 (dead key, no credit) for the process lifetime; 429/5xx never open it. Same rule as the image cascade in `aiService`. The video pipeline is unaffected — it still calls `AIService` directly.

## Knowledge injection

`buildKnowledgeContext(docs, categories)` selects by category, orders most-recently-updated first, and caps total injected characters. Per stage: `idea` reads brand/history/lessons, `story` reads character/jokes/relationships/brand/production, `package` reads brand/visual-style.

## Integration boundary

`packageToProjectPayload` (`src/content-studio/handoff.ts`) is a pure mapper with no pipeline imports. The `handoff` stage calls it, persists via the pipeline's own `saveProjectState`, and writes `render.script2VideoProjectId` + `sentAt` back to the package. Rendering remains a user action from the main dashboard.

## Not built

Trend APIs (Reddit/HN/X/Google Trends), command palette, keyboard shortcuts, API versioning, rate limiting, and the Characters/Assets/PromptTemplates/Analytics collections. All speculative — the package contract reserves room for them, so none needs a migration to add later.
