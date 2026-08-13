import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';

/**
 * Publishing metadata: the title, description and tags the video goes up with.
 *
 * This prompt used to be copy-pasted into two controller endpoints and reachable
 * from neither the render pipeline nor the scheduler — so anything rendered
 * without a human clicking "generate script" reached YouTube with no seo_metadata
 * at all and published as "Untitled" with an empty description and no tags. That
 * is precisely the unattended path daily publishing runs on.
 *
 * Never throws. Metadata is worth having, not worth failing a finished render for.
 */

export interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
  thumbnailText: string;
}

export async function generateSeoMetadata(project: Project): Promise<SeoMetadata | null> {
  const script = (project.script || project.scenes?.map((s: any) => s.narration_text).filter(Boolean).join(' ') || '').slice(0, 4000);

  const prompt = `Given this video about "${project.topic}", generate publishing metadata.

SCRIPT:
${script}

1. YouTube title (60 chars max, includes the main keyword, opens a curiosity gap)
2. Description (about 150 words, keyword-rich, written for a viewer not a crawler)
3. Tags (15 tags as separate array entries, mix of broad and specific)
4. Thumbnail text overlay (5 words max, bold claim)

Do NOT put chapter timestamps in the description. Nothing here knows where the
scene boundaries land in the finished video, so any timestamp would be invented
and would point at the wrong moment.

Return ONLY JSON: {"title": "...", "description": "...", "tags": ["one", "two"], "thumbnailText": "..."}`;

  try {
    const raw = await AIService.generateText(prompt, { task: 'seo' });
    const text = raw.replace(/```json\n?|```/g, '').trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('no JSON object in response');
    const parsed = JSON.parse(text.substring(first, last + 1));
    if (!parsed?.title) throw new Error('no title in response');

    return {
      title: String(parsed.title),
      description: String(parsed.description || ''),
      // The model has returned all fifteen tags as one comma-separated string
      // before now, which YouTube stores as a single absurd tag. Split them back.
      tags: (Array.isArray(parsed.tags) ? parsed.tags : String(parsed.tags || '').split(','))
        .flatMap((t: unknown) => String(t).split(/[,\n]/))
        .map((t: string) => t.trim().replace(/^#/, ''))
        .filter(Boolean),
      thumbnailText: String(parsed.thumbnailText || parsed.title || ''),
    };
  } catch (err: any) {
    console.warn('[SeoAgent] Could not generate publishing metadata (non-fatal):', err?.message || err);
    return null;
  }
}
