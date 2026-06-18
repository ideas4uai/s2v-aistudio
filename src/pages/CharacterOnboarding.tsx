import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, ChevronRight, ChevronLeft, CheckCircle, XCircle, RefreshCw, Sparkles, User, Image, Loader2 } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import type { AssetResult, AssetPackResult } from '../types/character';

type Step = 1 | 2 | 3 | 4 | 5;

// Defined outside to give React a stable component reference across re-renders
function StepDot({ n, label, step }: { n: number; label: string; step: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors
        ${step === n ? 'bg-indigo-600 text-white' : step > n ? 'bg-green-500 text-white' : 'bg-gray-700 text-gray-400'}`}>
        {step > n ? '✓' : n}
      </div>
      <span className={`text-xs ${step === n ? 'text-white' : 'text-gray-500'}`}>{label}</span>
    </div>
  );
}

const ASSET_GROUPS: Record<string, string[]> = {
  'Body Poses': ['body_neutral', 'body_talking', 'body_thinking', 'body_surprised'],
  'Mouth / Lip Sync': ['mouth_closed', 'mouth_open_a', 'mouth_open_e', 'mouth_open_o', 'mouth_smile', 'mouth_smile_open'],
  'Eye States': ['eyes_open', 'eyes_half', 'eyes_closed', 'eyes_wide'],
  'Brow States': ['brow_neutral', 'brow_raised', 'brow_furrowed'],
  'Walk Cycle': ['walk_01', 'walk_02', 'walk_03', 'walk_04', 'walk_05', 'walk_06', 'walk_07', 'walk_08'],
};

const STYLE_OPTIONS = [
  { value: 'flat_colour_anime', label: 'Flat Colour Anime', desc: 'South Asian graphic novel, bold outlines' },
  { value: 'cartoon', label: 'Cartoon', desc: 'Western cartoon style, expressive' },
  { value: 'semi_realistic', label: 'Semi-Realistic', desc: 'Painterly, detailed shading' },
];

export function CharacterOnboarding() {
  const navigate = useNavigate();

  // Step state
  const [step, setStep] = useState<Step>(1);

  // Step 1: Reference images
  const [refImages, setRefImages] = useState<Array<{ dataUrl: string; file: File }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2: Details
  const [universes, setUniverses] = useState<any[]>([]);
  const [selectedUniverseId, setSelectedUniverseId] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [characterDescription, setCharacterDescription] = useState('');
  const [style, setStyle] = useState('flat_colour_anime');

  // Step 3: Generation
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // Step 4: Results
  const [assetResult, setAssetResult] = useState<AssetPackResult | null>(null);
  const [createdCharacter, setCreatedCharacter] = useState<any>(null);
  const [createdUniverseId, setCreatedUniverseId] = useState('');

  // Regenerating individual assets
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());

  useEffect(() => {
    authenticatedFetch('/api/universes')
      .then(r => r.json())
      .then((data: any[]) => {
        setUniverses(data || []);
        if (data?.length === 1) setSelectedUniverseId(data[0].id);
      })
      .catch(() => {});
  }, []);

  // ── Step 1 handlers ────────────────────────────────────────────────────────
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 4 - refImages.length;
    files.slice(0, remaining).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        setRefImages(prev => [...prev, { dataUrl: ev.target!.result as string, file }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeRefImage = (idx: number) => {
    setRefImages(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Step 3: Generate ──────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!selectedUniverseId) { setGenerateError('Select a universe first.'); return; }
    if (!characterName.trim()) { setGenerateError('Character name is required.'); return; }
    if (!characterDescription.trim()) { setGenerateError('Character description is required.'); return; }
    if (!refImages.length) { setGenerateError('Upload at least one reference image.'); return; }

    setGenerating(true);
    setGenerateError('');
    setStep(3);

    try {
      const res = await authenticatedFetch(
        `/api/universes/${selectedUniverseId}/characters/new-with-assets`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: characterName.trim(),
            description: characterDescription.trim(),
            referenceImagesBase64: refImages.map(r => r.dataUrl),
            style,
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setAssetResult(data.assetPack as AssetPackResult);
      setCreatedCharacter(data.character);
      setCreatedUniverseId(data.universeId);
      setStep(4);
    } catch (e: any) {
      setGenerateError(e.message || 'Generation failed');
      setStep(2);
    } finally {
      setGenerating(false);
    }
  };

  // ── Regenerate single asset ────────────────────────────────────────────────
  const handleRegenerateAsset = async (assetName: string) => {
    if (!createdCharacter || !createdUniverseId) return;
    setRegenerating(prev => new Set(prev).add(assetName));

    try {
      const res = await authenticatedFetch(
        `/api/universes/${createdUniverseId}/characters/${createdCharacter.id}/regenerate-asset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assetName,
            referenceImageUrls: createdCharacter.referenceImageUrl ? [createdCharacter.referenceImageUrl] : [],
          }),
        }
      );
      const data: AssetResult = await res.json();
      if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);

      setAssetResult(prev => {
        if (!prev) return prev;
        const results = prev.results.map(r => r.assetName === assetName ? data : r);
        const succeeded = results.filter(r => r.status === 'success').length;
        return { ...prev, results, succeeded, failed: results.length - succeeded };
      });
    } catch (e: any) {
      console.error('Regenerate failed:', e.message);
    } finally {
      setRegenerating(prev => { const s = new Set(prev); s.delete(assetName); return s; });
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  console.log('[CharacterOnboarding] mounted, step:', step);

  return (
    <div className="min-h-screen bg-gray-950 text-white px-4 py-8">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-indigo-400" />
            New Character
          </h1>
          <p className="text-gray-400 mt-1">Upload reference images → generate a full 25-asset animation pack</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          <StepDot n={1} label="Images" step={step} />
          <div className="flex-1 h-px bg-gray-700" />
          <StepDot n={2} label="Details" step={step} />
          <div className="flex-1 h-px bg-gray-700" />
          <StepDot n={3} label="Generate" step={step} />
          <div className="flex-1 h-px bg-gray-700" />
          <StepDot n={4} label="Review" step={step} />
          <div className="flex-1 h-px bg-gray-700" />
          <StepDot n={5} label="Done" step={step} />
        </div>

        {/* ── Step 1: Upload images ─────────────────────────────────────── */}
        {step === 1 && (
          <div className="bg-gray-900 rounded-2xl p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Upload Reference Images</h2>
              <p className="text-gray-400 text-sm mt-1">1–4 images of the character. More images = better consistency.</p>
            </div>

            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                const remaining = 4 - refImages.length;
                files.slice(0, remaining).forEach(file => {
                  const reader = new FileReader();
                  reader.onload = ev => setRefImages(prev => [...prev, { dataUrl: ev.target!.result as string, file }]);
                  reader.readAsDataURL(file);
                });
              }}
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors
                ${refImages.length < 4 ? 'border-gray-600 hover:border-indigo-500' : 'border-gray-700 opacity-50 pointer-events-none'}`}
            >
              <Upload className="w-10 h-10 text-gray-500 mx-auto mb-3" />
              <p className="text-gray-400">Drag & drop or click to upload</p>
              <p className="text-gray-600 text-sm mt-1">{refImages.length}/4 images · PNG, JPG · any resolution</p>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFilePick} />
            </div>

            {/* Preview grid */}
            {refImages.length > 0 && (
              <div className="grid grid-cols-4 gap-3">
                {refImages.map((img, i) => (
                  <div key={i} className="relative group aspect-square rounded-xl overflow-hidden bg-gray-800">
                    <img src={img.dataUrl} alt={`ref ${i + 1}`} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <button onClick={() => removeRefImage(i)} className="text-red-400 text-xs font-medium px-2 py-1 rounded bg-black/40">Remove</button>
                    </div>
                    {i === 0 && (
                      <div className="absolute top-1 left-1 bg-indigo-600 text-white text-xs px-1.5 py-0.5 rounded">Primary</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                disabled={refImages.length === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none font-medium transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Character details ─────────────────────────────────── */}
        {step === 2 && (
          <div className="bg-gray-900 rounded-2xl p-6 space-y-5">
            <h2 className="text-lg font-semibold">Character Details</h2>

            {/* Universe picker */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Universe *</label>
              <select
                value={selectedUniverseId}
                onChange={e => setSelectedUniverseId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">Select universe…</option>
                {universes.map(u => (
                  <option key={u.id} value={u.id}>{u.title || u.name || u.id}</option>
                ))}
              </select>
              {universes.length === 0 && (
                <p className="text-yellow-500 text-xs mt-1">No universes found. Create one first from the Dashboard.</p>
              )}
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Character Name *</label>
              <input
                type="text"
                value={characterName}
                onChange={e => setCharacterName(e.target.value)}
                placeholder="e.g. VEER"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Character Description *</label>
              <textarea
                value={characterDescription}
                onChange={e => setCharacterDescription(e.target.value)}
                placeholder="Describe physical appearance: skin tone, hair, eyes, outfit, distinguishing features.&#10;Example: Indian teenage boy, 17 years old, dark brown skin, short black hair, brown eyes, wearing a blue hoodie and jeans, slim build."
                rows={5}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <p className="text-gray-600 text-xs mt-1">Be specific — this text is injected into every generation prompt.</p>
            </div>

            {/* Style */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Art Style</label>
              <div className="grid grid-cols-3 gap-3">
                {STYLE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setStyle(opt.value)}
                    className={`p-3 rounded-xl border text-left transition-colors ${style === opt.value ? 'border-indigo-500 bg-indigo-500/10' : 'border-gray-700 hover:border-gray-500'}`}
                  >
                    <div className="font-medium text-sm">{opt.label}</div>
                    <div className="text-gray-500 text-xs mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {generateError && (
              <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm">{generateError}</div>
            )}

            <div className="flex gap-3 justify-between">
              <button onClick={() => setStep(1)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 font-medium transition-colors">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleGenerate}
                disabled={!selectedUniverseId || !characterName.trim() || !characterDescription.trim() || generating}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none font-medium transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Generate 25 Assets
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Generating ────────────────────────────────────────── */}
        {step === 3 && (
          <div className="bg-gray-900 rounded-2xl p-8 text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Generating Asset Pack…</h2>
              <p className="text-gray-400 mt-2">Creating 25 character images in parallel via Gemini 3.1 Flash Image.</p>
              <p className="text-gray-500 text-sm mt-1">This takes ~30–60 seconds depending on API latency.</p>
            </div>

            <div className="bg-gray-800 rounded-xl p-4 text-left space-y-1 text-sm text-gray-400">
              {Object.entries(ASSET_GROUPS).map(([group, assets]) => (
                <div key={group} className="flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-indigo-400 shrink-0" />
                  <span>{group} ({assets.length} images)</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 4: Review results ────────────────────────────────────── */}
        {step === 4 && assetResult && (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="bg-gray-900 rounded-2xl p-5 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{createdCharacter?.name} — Asset Pack</h2>
                <p className="text-gray-400 text-sm mt-0.5">
                  <span className="text-green-400 font-medium">{assetResult.succeeded}</span> / {assetResult.total} generated
                  {assetResult.failed > 0 && <span className="text-red-400 ml-2">· {assetResult.failed} failed</span>}
                  <span className="text-gray-500 ml-2">· {Math.round(assetResult.timeTakenMs / 1000)}s</span>
                </p>
              </div>
              {assetResult.succeeded === assetResult.total ? (
                <CheckCircle className="w-8 h-8 text-green-500" />
              ) : (
                <XCircle className="w-8 h-8 text-yellow-500" />
              )}
            </div>

            {/* Asset groups */}
            {Object.entries(ASSET_GROUPS).map(([group, assetNames]) => (
              <div key={group} className="bg-gray-900 rounded-2xl p-5 space-y-3">
                <h3 className="font-medium text-gray-300">{group}</h3>
                <div className="grid grid-cols-4 gap-3">
                  {assetNames.map(assetName => {
                    const result = assetResult.results.find(r => r.assetName === assetName);
                    const isRegen = regenerating.has(assetName);
                    const success = result?.status === 'success';

                    return (
                      <div key={assetName} className="relative group">
                        <div className={`aspect-square rounded-xl overflow-hidden border ${success ? 'border-gray-700 bg-gray-800' : 'border-red-800 bg-red-900/20'}`}>
                          {success && result.supabaseUrl ? (
                            <img src={result.supabaseUrl} alt={assetName} className="w-full h-full object-contain" />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-2">
                              <XCircle className="w-6 h-6 text-red-500" />
                              <span className="text-red-400 text-xs text-center leading-tight">{result?.error?.slice(0, 40) || 'Failed'}</span>
                            </div>
                          )}

                          {/* Overlay with name + regen button */}
                          <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex flex-col items-center justify-end pb-2 gap-1">
                            <span className="text-white text-xs font-medium">{assetName}</span>
                            <button
                              onClick={() => handleRegenerateAsset(assetName)}
                              disabled={isRegen}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs transition-colors"
                            >
                              {isRegen ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                              Regen
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="flex gap-3 justify-between">
              <button onClick={() => setStep(2)} className="px-5 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 font-medium transition-colors text-sm">
                ← Back to Details
              </button>
              <button
                onClick={() => setStep(5)}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 font-medium transition-colors"
              >
                <CheckCircle className="w-4 h-4" /> Approve & Finish
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Done ──────────────────────────────────────────────── */}
        {step === 5 && createdCharacter && (
          <div className="bg-gray-900 rounded-2xl p-8 text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-green-600/20 border border-green-500/30 flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-green-400" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">{createdCharacter.name} is ready!</h2>
              <p className="text-gray-400 mt-2">
                {assetResult?.succeeded || 0} assets generated and saved to{' '}
                <code className="text-indigo-400 bg-indigo-900/30 px-1.5 py-0.5 rounded text-sm">
                  assets/characters/{createdCharacter.id}/
                </code>
              </p>
              <p className="text-gray-500 text-sm mt-2">
                This character is now available in the scene editor for projects in the selected universe.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => navigate(`/universes/${createdUniverseId}`)}
                className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-medium transition-colors"
              >
                <User className="w-4 h-4" /> View in Universe
              </button>
              <button
                onClick={() => {
                  setStep(1); setRefImages([]); setCharacterName(''); setCharacterDescription('');
                  setAssetResult(null); setCreatedCharacter(null);
                }}
                className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 font-medium transition-colors"
              >
                <Image className="w-4 h-4" /> Create Another
              </button>
              <button onClick={() => navigate('/')} className="px-6 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 font-medium transition-colors">
                Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
