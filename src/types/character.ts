export interface AssetResult {
  assetName: string;
  status: 'success' | 'failed';
  localPath?: string;
  supabaseUrl?: string;
  error?: string;
}

export interface AssetPackResult {
  characterId: string;
  total: number;
  succeeded: number;
  failed: number;
  results: AssetResult[];
  timeTakenMs: number;
}
