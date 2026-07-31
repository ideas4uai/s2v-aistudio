/**
 * AI Content Studio's stable domain contract.
 *
 * The production package is intentionally renderer-agnostic. Script2Video can
 * consume its render-ready fields, while future renderers can read the same
 * package without asking individual agents for data.
 */

export const PRODUCTION_PACKAGE_SCHEMA_VERSION = '1.0.0' as const;

export type StudioEpisodeStatus =
  | 'draft'
  | 'generating'
  | 'review'
  | 'approved'
  | 'rendering'
  | 'published'
  | 'archived'
  | 'failed';

/**
 * Four stages, not nine. `story` folds in review scoring, and `package`
 * delegates scene/dialogue/image-prompt work to the existing pipeline agents
 * (Director → Scriptwriter → Storyboard) rather than re-prompting for output
 * Script2Video already knows how to produce.
 */
export type WorkflowStageName = 'idea' | 'story' | 'package' | 'handoff';

export type WorkflowStageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'awaiting_approval';

export interface ScoreCard {
  overall?: number;
  engagement?: number;
  originality?: number;
  educationalValue?: number;
  visualPotential?: number;
  brandFit?: number;
  clarity?: number;
  shareability?: number;
  notes?: string[];
}

export interface WorkflowStageState {
  stage: WorkflowStageName;
  status: WorkflowStageStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface StoryPlan {
  title: string;
  hook: string;
  hookVariations: Array<{ text: string; score?: number }>;
  conflict?: string;
  escalation?: string;
  twist?: string;
  ending?: string;
  lesson?: string;
  cta?: string;
}

export interface DialogueLine {
  speaker: string;
  text: string;
  tone?: string;
  timingSeconds?: number;
  speechBubble?: boolean;
}

export interface ImagePrompt {
  provider?: string;
  model?: string;
  positive: string;
  negative?: string;
  aspectRatio?: string;
  seed?: number;
}

export interface ProductionScene {
  id: string;
  order: number;
  objective: string;
  durationSeconds?: number;
  camera?: string;
  composition?: string;
  characters?: string[];
  expressions?: Record<string, string>;
  props?: string[];
  environment?: string;
  transition?: string;
  dialogue: DialogueLine[];
  imagePrompt?: ImagePrompt;
}

export interface PublishingCopy {
  instagramCaption?: string;
  linkedInPost?: string;
  youTubeDescription?: string;
  cta?: string;
  hashtags: string[];
  keywords: string[];
}

export interface ProductionPackage {
  id: string;
  schemaVersion: typeof PRODUCTION_PACKAGE_SCHEMA_VERSION;
  episodeId: string;
  ownerId: string;
  status: StudioEpisodeStatus;
  story: StoryPlan;
  scenes: ProductionScene[];
  voice: Record<string, unknown>;
  subtitles: Record<string, unknown>;
  music: Record<string, unknown>;
  thumbnail: Record<string, unknown>;
  captions: PublishingCopy;
  assets: Array<Record<string, unknown>>;
  qualityScores: ScoreCard;
  render: { target?: 'shorts' | 'long'; script2VideoProjectId?: string; sentAt?: string; };
  extension: { animation?: Record<string, unknown>; camera?: Record<string, unknown>; motion?: Record<string, unknown>; lipSync?: Record<string, unknown>; };
  createdAt: string;
  updatedAt: string;
}

export interface StudioEpisode {
  id: string;
  userId: string;
  title: string;
  topic: string;
  characterIds: string[];
  status: StudioEpisodeStatus;
  productionPackageId: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  videoUrl?: string;
  qualityScores?: ScoreCard;
  workflow: WorkflowStageState[];
  /** Set when a run starts, so the UI can resume it after a refresh. */
  workflowRunId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface KnowledgeDocument {
  id: string;
  userId: string;
  title: string;
  category: 'character_bible' | 'production_bible' | 'brand_bible' | 'visual_style' | 'office_guide' | 'episode_history' | 'running_jokes' | 'relationships' | 'lessons_learned' | 'prompt_template' | 'general';
  content: string;
  tags: string[];
  relatedDocumentIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
