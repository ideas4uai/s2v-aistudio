import { PacingIntensity, StyleProfile } from './types.js';

export interface Template {
  id: string;
  name: string;
  hookStrategy: string;
  pacingIntensity: PacingIntensity;
  styleProfile: StyleProfile;
  visualStyle: string;
  voiceStyle: string;
  createdAt: Date;
}
