import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Loader2, Image as ImageIcon, BookOpen, Users, MapPin, Sliders, Download, Upload, Sparkles } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import { v4 as uuidv4 } from 'uuid';
import type { Universe, StoryCharacter, StoryLocation } from '../models/project';

const STYLE_PRESETS = [
  { label: 'Custom (fill below)', value: '' },
  { label: 'Anime Cinematic', value: 'semi-realistic anime, Trigger Studio quality, flat colour shading, bold clean outlines, Cyberpunk Edgerunners character design language, warm amber and neon teal lighting' },
  { label: 'Photorealistic', value: 'photorealistic, cinematic lighting, sharp focus, 8K quality, professional photography' },
  { label: 'Makoto Shinkai', value: 'Makoto Shinkai anime style, soft atmospheric lighting, painterly backgrounds, warm golden hour, detailed environments' },
  { label: 'Studio Ghibli', value: 'Studio Ghibli style, hand-drawn feel, soft watercolour backgrounds, expressive characters, warm natural lighting' },
  { label: 'Cyberpunk', value: 'cyberpunk aesthetic, neon lighting, dark environments, holographic displays, rain-slicked streets, high contrast' },
  { label: 'Indian Miniature Modern', value: 'modern Indian miniature painting style, vibrant colours, intricate patterns, flat perspective, bold outlines, traditional motifs' },
  { label: 'Webtoon', value: 'webtoon style, clean lines, flat colours, expressive faces, Korean manhwa aesthetic, bright colour palette' },
];

const emptyCharacter = (): StoryCharacter => ({
  id: uuidv4(),
  name: '',
  role: 'supporting',
  concept: '',
  appearance: '',
  personality: '',
  colorPalette: '',
  voiceStyle: 'neutral',
  imagePrompt: '',
});

const emptyLocation = (): StoryLocation => ({
  id: uuidv4(),
  name: '',
  description: '',
  imagePrompt: '',
  mood: '',
  timeOfDay: 'any',
});

const emptyUniverse = (): Omit<Universe, 'projectId'> & { id?: string; userId?: string } => ({
  title: '',
  logline: '',
  world: '',
  artStyle: 'cinematic',
  toneRules: '',
  episodeStructure: '',
  recurringElements: '',
  characters: [],
  locations: [],
});

type Tab = 'overview' | 'cast' | 'locations' | 'rules';

export function UniverseEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const isSaved = id && id !== 'new';

  const [universe, setUniverse] = useState<any>(emptyUniverse());
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedChar, setExpandedChar] = useState<string | null>(null);
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState<string | null>(null);
  const [generatingLocationImage, setGeneratingLocationImage] = useState<string | null>(null);
  const [generatingPoses, setGeneratingPoses] = useState<string | null>(null);
  const [posesExpanded, setPosesExpanded] = useState<Record<string, boolean>>({});
  const [trainingLora, setTrainingLora] = useState<string | null>(null);
  const [checkingLoraStatus, setCheckingLoraStatus] = useState<string | null>(null);
  const [lightboxChar, setLightboxChar] = useState<StoryCharacter | null>(null);
  const [locationLightbox, setLocationLightbox] = useState<StoryLocation | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const togglePosesExpanded = (charId: string) =>
    setPosesExpanded(prev => ({ ...prev, [charId]: !prev[charId] }));

  useEffect(() => {
    if (isNew) {
      // Eagerly create a blank universe so we always have a real ID
      authenticatedFetch('/api/universes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Untitled Universe',
          logline: '',
          world: '',
          artStyle: 'photorealistic',
          toneRules: '',
          episodeStructure: '',
          recurringElements: '',
          characters: [],
          locations: [],
        }),
      })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('Create failed')))
        .then(data => {
          if (data.id) navigate(`/universes/${data.id}`, { replace: true });
        })
        .catch(console.error);
    } else {
      authenticatedFetch(`/api/universes/${id}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setUniverse(data); })
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [id, isNew]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(universe),
      });
      if (!res.ok) throw new Error(await res.text());
      setUniverse(await res.json());
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const generateCharacterPoses = async (char: StoryCharacter) => {
    if (!char.imagePrompt) return;
    setGeneratingPoses(char.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/poses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: char.imagePrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.poses) {
        const charName = char.name.toUpperCase();
        const updatedPoses = { ...(universe.characterPoses || {}), [charName]: data.poses };
        const updated = { ...universe, characterPoses: updatedPoses };
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated),
        });
        setUniverse(updated);
        console.log('[Universe] Character poses generated:', charName, Object.keys(data.poses));
      }
    } catch (e) {
      console.error('Pose generation failed:', e);
    } finally {
      setGeneratingPoses(null);
    }
  };

  // Poll Replicate training status every 30s for characters currently training
  const trainingCharIds = (universe.characters || [])
    .filter((c: any) => c.loraStatus === 'training')
    .map((c: any) => c.id)
    .join(',');
  useEffect(() => {
    if (!trainingCharIds || !id || id === 'new') return;
    const timer = setInterval(async () => {
      for (const char of (universe.characters || []).filter((c: any) => c.loraStatus === 'training')) {
        try {
          const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/lora-status`);
          if (!res.ok) continue;
          const data = await res.json();
          if (data.status === 'ready' || data.status === 'failed') {
            setUniverse((prev: any) => ({
              ...prev,
              characters: (prev.characters || []).map((c: any) =>
                c.id === char.id
                  ? { ...c, loraStatus: data.status, ...(data.loraModelUrl ? { loraModelUrl: data.loraModelUrl } : {}), ...(data.loraTriggerWord ? { loraTriggerWord: data.loraTriggerWord } : {}), ...(data.useLoRA !== undefined ? { useLoRA: data.useLoRA } : {}) }
                  : c
              ),
            }));
          }
        } catch { /* ignore */ }
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [trainingCharIds]);

  const handleCheckLoraStatus = async (char: StoryCharacter) => {
    setCheckingLoraStatus(char.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/lora-status`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUniverse((prev: any) => ({
        ...prev,
        characters: (prev.characters || []).map((c: any) =>
          c.id === char.id
            ? { ...c, loraStatus: data.status, ...(data.loraModelUrl ? { loraModelUrl: data.loraModelUrl } : {}), ...(data.loraTriggerWord ? { loraTriggerWord: data.loraTriggerWord } : {}), ...(data.useLoRA !== undefined ? { useLoRA: data.useLoRA } : {}) }
            : c
        ),
      }));
    } catch (e: any) {
      alert('LoRA status check failed: ' + e.message);
    } finally {
      setCheckingLoraStatus(null);
    }
  };

  const handleTrainLoRA = async (char: StoryCharacter) => {
    setTrainingLora(char.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/train-lora`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUniverse((prev: any) => ({
        ...prev,
        characters: (prev.characters || []).map((c: any) =>
          c.id === char.id
            ? { ...c, loraTrainingId: data.trainingId, loraStatus: 'training', loraTriggerWord: data.triggerWord }
            : c
        ),
      }));
    } catch (e: any) {
      alert('LoRA training failed to start: ' + e.message);
    } finally {
      setTrainingLora(null);
    }
  };

  const toggleUseLoRA = async (char: StoryCharacter) => {
    const updated = {
      ...universe,
      characters: (universe.characters || []).map((c: any) =>
        c.id === char.id ? { ...c, useLoRA: !c.useLoRA } : c
      ),
    };
    setUniverse(updated);
    await authenticatedFetch(`/api/universes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
  };

  const handleRegeneratePose = async (char: StoryCharacter, poseName: string) => {
    setGeneratingPoses(char.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/poses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poseNames: [poseName] }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.poses) {
        const charName = char.name.toUpperCase();
        const existingPoses = universe.characterPoses?.[charName] || {};
        const updatedPoses = { ...(universe.characterPoses || {}), [charName]: { ...existingPoses, ...data.poses } };
        const updated = { ...universe, characterPoses: updatedPoses };
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated),
        });
        setUniverse(updated);
      }
    } catch (e) {
      console.error('Pose regeneration failed:', e);
    } finally {
      setGeneratingPoses(null);
    }
  };

  const handleDeletePoses = async (char: any) => {
    if (!confirm(`Delete all poses for ${char.name}?`)) return;
    const updated = {
      ...universe,
      characterPoses: {
        ...(universe.characterPoses || {}),
        [char.name.toUpperCase()]: {}
      }
    };
    await authenticatedFetch(`/api/universes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    setUniverse(updated);
    setPosesExpanded(prev => ({ ...prev, [char.id]: false }));
    console.log('[Poses] Deleted all poses for:', char.name);
  };

  const handleDeleteSinglePose = async (char: any, poseName: string) => {
    const charKey = char.name.toUpperCase();
    const currentPoses = (universe.characterPoses as any)?.[charKey] || {};
    const { [poseName]: _, ...remaining } = currentPoses;
    const updated = {
      ...universe,
      characterPoses: {
        ...(universe.characterPoses || {}),
        [charKey]: remaining
      }
    };
    await authenticatedFetch(`/api/universes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    setUniverse(updated);
  };

  const handleDownloadCharacterImage = async (char: StoryCharacter) => {
    if (!char.referenceImageUrl) return;
    try {
      const res = await fetch(char.referenceImageUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${char.name}_reference.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      window.open(char.referenceImageUrl, '_blank');
    }
  };

  const handleUploadCharacterImage = async (char: StoryCharacter, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please upload an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { alert('Image must be under 10MB'); return; }

    setGeneratingImage(char.id);
    try {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/image/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mimeType: file.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      if (data.imageUrl) {
        const bustUrl = `${data.imageUrl}?t=${Date.now()}`;
        updateCharacter(char.id, { referenceImageUrl: bustUrl });
        const updatedChars = universe.characters.map((c: StoryCharacter) =>
          c.id === char.id ? { ...c, referenceImageUrl: data.imageUrl } : c
        );
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...universe, characters: updatedChars }),
        });
        console.log('[Universe] Character image uploaded:', char.name, bustUrl);
      }
    } catch (err: any) {
      alert('Upload failed: ' + err.message);
    } finally {
      setGeneratingImage(null);
    }
  };

  const generateCharacterImage = async (char: StoryCharacter) => {
    if (!char.imagePrompt) return;
    setGeneratingImage(char.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/characters/${char.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: char.imagePrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const url = data.imageUrl;
      if (url) {
        const bustUrl = `${url}?t=${Date.now()}`;
        updateCharacter(char.id, { referenceImageUrl: bustUrl });
        const updatedChars = universe.characters.map((c: StoryCharacter) =>
          c.id === char.id ? { ...c, referenceImageUrl: url } : c
        );
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...universe, characters: updatedChars }),
        });
        console.log('[Universe] Character image saved:', char.name, url);
      }
    } catch (e) {
      console.error('Image generation failed:', e);
    } finally {
      setGeneratingImage(null);
    }
  };

  const handleDownloadLocationImage = async (loc: StoryLocation) => {
    if (!loc.referenceImageUrl) return;
    try {
      const res = await fetch(loc.referenceImageUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${loc.name}_location.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(loc.referenceImageUrl, '_blank');
    }
  };

  const handleUploadLocationImage = async (loc: StoryLocation, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please upload an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { alert('Image must be under 10MB'); return; }
    setGeneratingLocationImage(loc.id);
    try {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });
      const res = await authenticatedFetch(`/api/universes/${id}/locations/${loc.id}/image/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mimeType: file.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      if (data.imageUrl) {
        const bustUrl = `${data.imageUrl}?t=${Date.now()}`;
        updateLocation(loc.id, { referenceImageUrl: bustUrl });
        const updatedLocs = universe.locations.map((l: StoryLocation) =>
          l.id === loc.id ? { ...l, referenceImageUrl: data.imageUrl } : l
        );
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...universe, locations: updatedLocs }),
        });
        console.log('[Universe] Location image uploaded:', loc.name, data.imageUrl);
      }
    } catch (err: any) {
      alert('Upload failed: ' + err.message);
    } finally {
      setGeneratingLocationImage(null);
    }
  };

  const generateLocationImage = async (loc: StoryLocation) => {
    if (!loc.imagePrompt) return;
    setGeneratingLocationImage(loc.id);
    try {
      const res = await authenticatedFetch(`/api/universes/${id}/locations/${loc.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: loc.imagePrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const url = data.imageUrl;
      if (url) {
        const bustUrl = `${url}?t=${Date.now()}`;
        updateLocation(loc.id, { referenceImageUrl: bustUrl });
        const updatedLocs = universe.locations.map((l: StoryLocation) =>
          l.id === loc.id ? { ...l, referenceImageUrl: url } : l
        );
        await authenticatedFetch(`/api/universes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...universe, locations: updatedLocs }),
        });
        console.log('[Universe] Location image saved:', loc.name, url);
      }
    } catch (e) {
      console.error('Location image generation failed:', e);
    } finally {
      setGeneratingLocationImage(null);
    }
  };

  const updateCharacter = (charId: string, patch: Partial<StoryCharacter>) => {
    setUniverse((u: any) => ({
      ...u,
      characters: u.characters.map((c: StoryCharacter) => c.id === charId ? { ...c, ...patch } : c),
    }));
  };

  const updateLocation = (locId: string, patch: Partial<StoryLocation>) => {
    setUniverse((u: any) => ({
      ...u,
      locations: u.locations.map((l: StoryLocation) => l.id === locId ? { ...l, ...patch } : l),
    }));
  };

  const addCharacter = () => {
    const c = emptyCharacter();
    setUniverse((u: any) => ({ ...u, characters: [...u.characters, c] }));
    setExpandedChar(c.id);
    setActiveTab('cast');
  };

  const removeCharacter = (charId: string) => {
    setUniverse((u: any) => ({ ...u, characters: u.characters.filter((c: StoryCharacter) => c.id !== charId) }));
    if (expandedChar === charId) setExpandedChar(null);
  };

  const addLocation = () => {
    const l = emptyLocation();
    setUniverse((u: any) => ({ ...u, locations: [...u.locations, l] }));
    setExpandedLoc(l.id);
    setActiveTab('locations');
  };

  const removeLocation = (locId: string) => {
    setUniverse((u: any) => ({ ...u, locations: u.locations.filter((l: StoryLocation) => l.id !== locId) }));
    if (expandedLoc === locId) setExpandedLoc(null);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'cast', label: `Cast (${universe.characters?.length || 0})`, icon: <Users className="w-4 h-4" /> },
    { id: 'locations', label: `Locations (${universe.locations?.length || 0})`, icon: <MapPin className="w-4 h-4" /> },
    { id: 'rules', label: 'Rules', icon: <Sliders className="w-4 h-4" /> },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <>
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-neutral-500 hover:text-neutral-900 font-medium transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save Universe
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
        <div className="p-6 border-b border-neutral-100 bg-neutral-50/50">
          <input
            className="text-2xl font-bold text-neutral-900 bg-transparent border-none outline-none w-full placeholder-neutral-300"
            placeholder="Universe Title (e.g. Signal Squad)"
            value={universe.title || ''}
            onChange={e => setUniverse((u: any) => ({ ...u, title: e.target.value }))}
          />
          <input
            className="text-sm text-neutral-500 bg-transparent border-none outline-none w-full mt-1 placeholder-neutral-400"
            placeholder="One-sentence logline..."
            value={universe.logline || ''}
            onChange={e => setUniverse((u: any) => ({ ...u, logline: e.target.value }))}
          />
        </div>

        <div className="flex border-b border-neutral-100 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3.5 text-sm font-semibold whitespace-nowrap transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900'
              }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {activeTab === 'overview' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">World Description</label>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-28 text-sm"
                  placeholder="Describe the world, setting, and universe for the AI to understand the context..."
                  value={universe.world || ''}
                  onChange={e => setUniverse((u: any) => ({ ...u, world: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Art Style</label>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-neutral-500 whitespace-nowrap">Quick preset:</span>
                    <select
                      className="flex-1 px-3 py-2 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none bg-white text-sm"
                      value={STYLE_PRESETS.find(p => p.value === universe.artStyle)?.value ?? ''}
                      onChange={e => {
                        if (e.target.value !== '') {
                          setUniverse((u: any) => ({ ...u, artStyle: e.target.value }));
                        }
                      }}
                    >
                      {STYLE_PRESETS.map(p => (
                        <option key={p.label} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none text-sm resize-none"
                    placeholder="Describe the art style in detail — this is injected into every image prompt"
                    value={universe.artStyle || ''}
                    onChange={e => setUniverse((u: any) => ({ ...u, artStyle: e.target.value }))}
                  />
                  <p className="text-xs text-neutral-400 mt-1">This description is injected into every image prompt</p>
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Episode Structure</label>
                  <input
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
                    placeholder="e.g. Hook → Problem → Action → Lesson → CTA"
                    value={universe.episodeStructure || ''}
                    onChange={e => setUniverse((u: any) => ({ ...u, episodeStructure: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'cast' && (
            <div className="space-y-4">
              <button
                onClick={addCharacter}
                className="flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Character
              </button>
              {!isSaved && (
                <div className="text-amber-600 text-sm mb-4 p-3 bg-amber-50 rounded-lg">
                  ⚠️ Save the universe first before generating character reference images.
                </div>
              )}
              {(universe.characters || []).map((char: StoryCharacter) => (
                <div key={char.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                    onClick={() => setExpandedChar(expandedChar === char.id ? null : char.id)}
                  >
                    <div className="flex items-center gap-3">
                      {char.referenceImageUrl ? (
                        <img
                          src={char.referenceImageUrl.includes('?t=') ? char.referenceImageUrl : `${char.referenceImageUrl}?t=${Date.now()}`}
                          alt={char.name}
                          className="w-8 h-8 rounded-full object-cover border border-neutral-200 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={e => { e.stopPropagation(); setLightboxChar(char); }}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-xs font-bold text-neutral-400">
                          {char.name?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div>
                        <span className="font-bold text-neutral-900 text-sm">{char.name || 'Unnamed Character'}</span>
                        <span className="ml-2 text-xs text-neutral-400 capitalize">{char.role}</span>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); removeCharacter(char.id); }}
                      className="p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {expandedChar === char.id && (
                    <div className="px-4 pb-4 space-y-3 border-t border-neutral-100 pt-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Name</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={char.name} onChange={e => updateCharacter(char.id, { name: e.target.value })} placeholder="Character name" />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Role</label>
                          <select className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none bg-white" value={char.role} onChange={e => updateCharacter(char.id, { role: e.target.value })}>
                            <option value="protagonist">Protagonist</option>
                            <option value="antagonist">Antagonist</option>
                            <option value="supporting">Supporting</option>
                            <option value="mentor">Mentor</option>
                            <option value="comic_relief">Comic Relief</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Concept</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={char.concept} onChange={e => updateCharacter(char.id, { concept: e.target.value })} placeholder="One-line description" />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Voice Style</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={char.voiceStyle} onChange={e => updateCharacter(char.id, { voiceStyle: e.target.value })} placeholder="e.g. energetic, calm, mysterious" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Appearance</label>
                        <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-16" value={char.appearance} onChange={e => updateCharacter(char.id, { appearance: e.target.value })} placeholder="Detailed visual description for image generation" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Personality</label>
                        <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-16" value={char.personality} onChange={e => updateCharacter(char.id, { personality: e.target.value })} placeholder="Personality traits for script generation" />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Color Palette</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={char.colorPalette} onChange={e => updateCharacter(char.id, { colorPalette: e.target.value })} placeholder="e.g. electric blue, silver, white" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Image Generation Prompt</label>
                        <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-16" value={char.imagePrompt} onChange={e => updateCharacter(char.id, { imagePrompt: e.target.value })} placeholder="Full Imagen 4 ready prompt for generating a reference image" />
                      </div>
                      <input
                        type="file"
                        id={`upload-${char.id}`}
                        accept="image/*"
                        className="hidden"
                        onChange={e => handleUploadCharacterImage(char, e.target.files?.[0])}
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => generateCharacterImage(char)}
                          disabled={!char.imagePrompt || generatingImage === char.id || !isSaved}
                          title={!isSaved ? 'Save the universe first' : ''}
                          className="flex items-center gap-2 px-3 py-2 text-sm font-bold text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {generatingImage === char.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                          Generate with AI
                        </button>
                        <button
                          onClick={() => generateCharacterPoses(char)}
                          disabled={!char.imagePrompt || generatingPoses === char.id || !isSaved}
                          title={!isSaved ? 'Save the universe first' : 'Generate idle, talking, thinking, excited poses'}
                          className="flex items-center gap-2 px-3 py-2 text-sm font-bold text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {generatingPoses === char.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                          Generate Poses
                        </button>
                        {universe.characterPoses?.[char.name.toUpperCase()] && (
                          <span className="text-xs text-purple-600 font-medium">
                            ✓ {Object.keys(universe.characterPoses[char.name.toUpperCase()]).length} poses ready
                          </span>
                        )}
                        {(char as any).loraStatus === 'ready' ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-green-600 font-medium">✓ LoRA Ready</span>
                            <label className="flex items-center gap-1 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={(char as any).useLoRA || false}
                                onChange={() => toggleUseLoRA(char)}
                                className="w-3 h-3 accent-green-600"
                              />
                              <span className="text-xs text-neutral-600">Use LoRA</span>
                            </label>
                          </div>
                        ) : (char as any).loraStatus === 'training' ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> Training... ~20min
                            </span>
                            <button
                              onClick={() => handleCheckLoraStatus(char)}
                              disabled={checkingLoraStatus === char.id}
                              className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 border border-amber-200 rounded hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              {checkingLoraStatus === char.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                              Check Status
                            </button>
                          </div>
                        ) : (char as any).loraStatus === 'failed' ? (
                          <span className="text-xs text-red-500 font-medium">✗ Training failed</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleTrainLoRA(char)}
                              disabled={!(char as any).referenceImageUrl || trainingLora === char.id || !isSaved}
                              title={!isSaved ? 'Save first' : !(char as any).referenceImageUrl ? 'Generate reference image first' : 'Train a FLUX LoRA for consistent character generation (~20min)'}
                              className="flex items-center gap-2 px-3 py-2 text-sm font-bold text-green-700 border border-green-200 rounded-lg hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              {trainingLora === char.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                              Train LoRA
                            </button>
                            {(char as any).loraTrainingId && (
                              <button
                                onClick={() => handleCheckLoraStatus(char)}
                                disabled={checkingLoraStatus === char.id}
                                className="flex items-center gap-1 px-2 py-1 text-xs text-neutral-600 border border-neutral-200 rounded hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                {checkingLoraStatus === char.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                Check Status
                              </button>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => document.getElementById(`upload-${char.id}`)?.click()}
                          disabled={generatingImage === char.id || !isSaved}
                          title={!isSaved ? 'Save the universe first' : ''}
                          className="flex items-center gap-2 px-3 py-2 text-sm border border-neutral-300 rounded-lg hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {generatingImage === char.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload size={14} />}
                          {char.referenceImageUrl ? 'Replace Image' : 'Upload Image'}
                        </button>
                        {char.referenceImageUrl && (
                          <div className="flex items-center gap-2">
                            <img
                              src={char.referenceImageUrl.includes('?t=') ? char.referenceImageUrl : `${char.referenceImageUrl}?t=${Date.now()}`}
                              alt="Reference"
                              className="w-12 h-12 rounded-lg object-cover border border-neutral-200 cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => setLightboxChar(char)}
                            />
                            <button
                              onClick={() => handleDownloadCharacterImage(char)}
                              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                            >
                              <Download size={12} /> Download
                            </button>
                          </div>
                        )}
                      </div>
                      {(() => {
                        const charPoses = universe.characterPoses?.[char.name.toUpperCase()] || {};
                        const poseEntries = Object.entries(charPoses);
                        if (poseEntries.length === 0) return null;
                        return (
                          <div className="mt-3">
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => togglePosesExpanded(char.id)}
                                className="text-xs text-purple-600 hover:text-purple-800 font-medium flex items-center gap-1"
                              >
                                {posesExpanded[char.id] ? '▼' : '▶'} View {poseEntries.length} poses
                              </button>
                              {poseEntries.length > 0 && (
                                <button
                                  onClick={() => handleDeletePoses(char)}
                                  className="text-xs text-red-500 hover:text-red-700 font-medium mt-0"
                                >
                                  🗑️ Delete all poses
                                </button>
                              )}
                            </div>
                            {posesExpanded[char.id] && (
                              <div className="grid grid-cols-3 gap-2 mt-2">
                                {poseEntries.map(([poseName, poseUrl]) => (
                                  <div key={poseName} className="relative group">
                                    <img
                                      src={poseUrl as string}
                                      alt={poseName}
                                      className="w-full aspect-[9/16] object-cover rounded-lg border border-purple-200 cursor-pointer hover:border-purple-500 transition-all"
                                      onClick={() => setLightboxImage(poseUrl as string)}
                                    />
                                    <p className="text-xs text-center text-gray-500 mt-1 capitalize">{poseName}</p>
                                    <button
                                      onClick={() => handleRegeneratePose(char, poseName)}
                                      disabled={generatingPoses === char.id}
                                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-white rounded-full p-1 text-xs shadow-sm transition-opacity disabled:opacity-50"
                                      title="Regenerate this pose"
                                    >
                                      🔄
                                    </button>
                                    <button
                                      onClick={() => handleDeleteSinglePose(char, poseName)}
                                      className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 bg-white rounded-full p-1 text-xs shadow-sm transition-opacity text-red-500"
                                      title="Delete this pose"
                                    >
                                      🗑️
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
              {(universe.characters || []).length === 0 && (
                <div className="text-center py-12 text-neutral-400">
                  <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No characters yet. Add your first character.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'locations' && (
            <div className="space-y-4">
              <button
                onClick={addLocation}
                className="flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Location
              </button>
              {(universe.locations || []).map((loc: StoryLocation) => (
                <div key={loc.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                    onClick={() => setExpandedLoc(expandedLoc === loc.id ? null : loc.id)}
                  >
                    <div>
                      <span className="font-bold text-neutral-900 text-sm">{loc.name || 'Unnamed Location'}</span>
                      <span className="ml-2 text-xs text-neutral-400 capitalize">{loc.timeOfDay}</span>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); removeLocation(loc.id); }}
                      className="p-1.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {expandedLoc === loc.id && (
                    <div className="px-4 pb-4 space-y-3 border-t border-neutral-100 pt-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Name</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={loc.name} onChange={e => updateLocation(loc.id, { name: e.target.value })} placeholder="Location name" />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Time of Day</label>
                          <select className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none bg-white" value={loc.timeOfDay} onChange={e => updateLocation(loc.id, { timeOfDay: e.target.value as any })}>
                            <option value="any">Any</option>
                            <option value="day">Day</option>
                            <option value="night">Night</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-600 mb-1">Mood</label>
                          <input className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none" value={loc.mood} onChange={e => updateLocation(loc.id, { mood: e.target.value })} placeholder="e.g. tense, peaceful, mysterious" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Description</label>
                        <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-16" value={loc.description} onChange={e => updateLocation(loc.id, { description: e.target.value })} placeholder="Describe the location for AI context" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-neutral-600 mb-1">Image Generation Prompt</label>
                        <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-16" value={loc.imagePrompt} onChange={e => updateLocation(loc.id, { imagePrompt: e.target.value })} placeholder="Full Imagen 4 ready prompt for this location" />
                      </div>
                      {loc.referenceImageUrl && (
                        <div className="mb-1">
                          <img
                            src={loc.referenceImageUrl}
                            alt={loc.name}
                            className="w-full h-32 object-cover rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => setLocationLightbox(loc)}
                          />
                          <button
                            onClick={() => handleDownloadLocationImage(loc)}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                          >
                            <Download size={12} /> Download
                          </button>
                        </div>
                      )}
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={() => generateLocationImage(loc)}
                          disabled={!loc.imagePrompt || generatingLocationImage === loc.id || !isSaved}
                          title={!isSaved ? 'Save the universe first' : ''}
                          className="flex items-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {generatingLocationImage === loc.id ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                          {loc.referenceImageUrl ? 'Re-generate' : 'Generate Image'}
                        </button>
                        <button
                          onClick={() => document.getElementById(`loc-upload-${loc.id}`)?.click()}
                          disabled={generatingLocationImage === loc.id || !isSaved}
                          title={!isSaved ? 'Save the universe first' : ''}
                          className="flex items-center gap-2 px-3 py-2 border border-neutral-300 rounded-lg text-sm hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <Upload size={14} />
                          {loc.referenceImageUrl ? 'Replace Image' : 'Upload Image'}
                        </button>
                        <input
                          type="file"
                          id={`loc-upload-${loc.id}`}
                          accept="image/*"
                          className="hidden"
                          onChange={e => handleUploadLocationImage(loc, e.target.files?.[0])}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {(universe.locations || []).length === 0 && (
                <div className="text-center py-12 text-neutral-400">
                  <MapPin className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No locations yet. Add your first location.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Tone Rules</label>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-20 text-sm"
                  placeholder="e.g. 70% story action, 20% humor, 10% teaching moments. Never break 4th wall."
                  value={universe.toneRules || ''}
                  onChange={e => setUniverse((u: any) => ({ ...u, toneRules: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Recurring Elements</label>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-20 text-sm"
                  placeholder="e.g. Villain arc, running catchphrase, recurring callbacks, mystery subplot..."
                  value={universe.recurringElements || ''}
                  onChange={e => setUniverse((u: any) => ({ ...u, recurringElements: e.target.value }))}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

      {lightboxChar && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxChar(null)}
        >
          <div className="relative max-w-md w-full" onClick={e => e.stopPropagation()}>
            <img
              src={lightboxChar.referenceImageUrl || ''}
              alt={lightboxChar.name}
              className="w-full rounded-xl"
            />
            <p className="text-white text-center mt-2 font-semibold">{lightboxChar.name}</p>
            <div className="flex gap-2 mt-2 justify-center">
              <button
                onClick={() => handleDownloadCharacterImage(lightboxChar)}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
              >
                Download
              </button>
              <button
                onClick={() => setLightboxChar(null)}
                className="bg-gray-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxImage && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative max-w-[400px] w-full" onClick={e => e.stopPropagation()}>
            <img src={lightboxImage} className="max-h-[90vh] w-full rounded-xl object-contain" />
            <button
              className="absolute top-2 right-2 text-white text-2xl bg-black/50 rounded-full w-8 h-8 flex items-center justify-center hover:bg-black/80 transition-colors"
              onClick={() => setLightboxImage(null)}
            >✕</button>
          </div>
        </div>
      )}

      {locationLightbox && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setLocationLightbox(null)}
        >
          <div className="relative max-w-2xl w-full" onClick={e => e.stopPropagation()}>
            <img
              src={locationLightbox.referenceImageUrl || ''}
              alt={locationLightbox.name}
              className="w-full rounded-xl"
            />
            <p className="text-white text-center mt-2 font-semibold">{locationLightbox.name}</p>
            <div className="flex gap-2 mt-2 justify-center">
              <button
                onClick={() => handleDownloadLocationImage(locationLightbox)}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
              >
                Download
              </button>
              <button
                onClick={() => setLocationLightbox(null)}
                className="bg-gray-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
