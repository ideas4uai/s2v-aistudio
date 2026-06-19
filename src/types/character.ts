export interface AssetResult {
  assetName: string;
  status: 'success' | 'failed' | 'needs_review';
  localPath?: string;
  supabaseUrl?: string;
  error?: string;
  deltaE?: number;
}

export interface AssetPackResult {
  characterId: string;
  total: number;
  succeeded: number;
  needsReview: number;
  failed: number;
  results: AssetResult[];
  timeTakenMs: number;
}
