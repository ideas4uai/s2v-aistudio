import { describe, it, expect } from 'vitest';
import {
  VERIFIED_IMAGEN_MODELS,
  DEFAULT_IMAGEN_MODEL,
  resolveImagenModel,
  isVerifiedImagenModel,
} from '../src/services/aiService.js';

// Guards the Google image provider against silently routing to a model string that
// does not exist. `gemini-3.1-flash-image` was hardcoded here and 404'd on every
// request; the pipeline swallowed it and shipped Picsum stock photos instead.
describe('Google image provider uses a verified Imagen model', () => {
  it('the configured VERTEX_IMAGEN_MODEL is a verified Imagen model string', () => {
    const model = resolveImagenModel();
    expect(
      isVerifiedImagenModel(model),
      `VERTEX_IMAGEN_MODEL="${model}" is not verified. Probe it against Vertex before shipping; ` +
      `verified: ${VERIFIED_IMAGEN_MODELS.join(', ')}`,
    ).toBe(true);
  });

  it('every verified model is a real Imagen id, never a Gemini chat model', () => {
    for (const model of VERIFIED_IMAGEN_MODELS) {
      expect(model, `${model} must be an imagen-* id`).toMatch(/^imagen-\d/);
      expect(model, `${model} is a Gemini model, not an image model`).not.toMatch(/gemini/i);
    }
  });

  it('the default falls back to a verified model when the env var is unset', () => {
    expect(resolveImagenModel({} as NodeJS.ProcessEnv)).toBe(DEFAULT_IMAGEN_MODEL);
    expect(isVerifiedImagenModel(DEFAULT_IMAGEN_MODEL)).toBe(true);
  });

  it('rejects the model strings that 404 against this project', () => {
    expect(isVerifiedImagenModel('gemini-3.1-flash-image')).toBe(false);
    expect(isVerifiedImagenModel('imagen-4.0-fast')).toBe(false);
    expect(isVerifiedImagenModel('')).toBe(false);
  });
});
