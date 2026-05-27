import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Loader2, Image as ImageIcon, BookOpen, Users, MapPin, Sliders } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import { v4 as uuidv4 } from 'uuid';
import type { StoryBible, StoryCharacter, StoryLocation } from '../models/project';

const ART_STYLES = ['cinematic', 'anime', 'realistic', 'cartoon', '3d_rendered', 'watercolor', 'cyberpunk', 'mixed'];

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

const emptyBible = (): Omit<StoryBible, 'projectId'> & { id?: string; userId?: string } => ({
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

export function StoryBibleEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [bible, setBible] = useState<any>(emptyBible());
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [expandedChar, setExpandedChar] = useState<string | null>(null);
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    authenticatedFetch(`/api/story-bibles/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBible(data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const save = async () => {
    setSaving(true);
    try {
      const method = isNew ? 'POST' : 'PUT';
      const url = isNew ? '/api/story-bibles' : `/api/story-bibles/${id}`;
      const res = await authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bible),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      if (isNew && saved.id) {
        navigate(`/story-bibles/${saved.id}`, { replace: true });
      } else {
        setBible(saved);
      }
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const generateCharacterImage = async (char: StoryCharacter) => {
    if (!char.imagePrompt) return;
    setGeneratingImage(char.id);
    try {
      const res = await authenticatedFetch('/api/visuals/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: char.imagePrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const url = data.url || data.imageUrl;
      if (url) {
        updateCharacter(char.id, { referenceImageUrl: url });
      }
    } catch (e) {
      console.error('Image generation failed:', e);
    } finally {
      setGeneratingImage(null);
    }
  };

  const updateCharacter = (charId: string, patch: Partial<StoryCharacter>) => {
    setBible((b: any) => ({
      ...b,
      characters: b.characters.map((c: StoryCharacter) => c.id === charId ? { ...c, ...patch } : c),
    }));
  };

  const updateLocation = (locId: string, patch: Partial<StoryLocation>) => {
    setBible((b: any) => ({
      ...b,
      locations: b.locations.map((l: StoryLocation) => l.id === locId ? { ...l, ...patch } : l),
    }));
  };

  const addCharacter = () => {
    const c = emptyCharacter();
    setBible((b: any) => ({ ...b, characters: [...b.characters, c] }));
    setExpandedChar(c.id);
    setActiveTab('cast');
  };

  const removeCharacter = (charId: string) => {
    setBible((b: any) => ({ ...b, characters: b.characters.filter((c: StoryCharacter) => c.id !== charId) }));
    if (expandedChar === charId) setExpandedChar(null);
  };

  const addLocation = () => {
    const l = emptyLocation();
    setBible((b: any) => ({ ...b, locations: [...b.locations, l] }));
    setExpandedLoc(l.id);
    setActiveTab('locations');
  };

  const removeLocation = (locId: string) => {
    setBible((b: any) => ({ ...b, locations: b.locations.filter((l: StoryLocation) => l.id !== locId) }));
    if (expandedLoc === locId) setExpandedLoc(null);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'cast', label: `Cast (${bible.characters?.length || 0})`, icon: <Users className="w-4 h-4" /> },
    { id: 'locations', label: `Locations (${bible.locations?.length || 0})`, icon: <MapPin className="w-4 h-4" /> },
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
          Save Bible
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
        <div className="p-6 border-b border-neutral-100 bg-neutral-50/50">
          <input
            className="text-2xl font-bold text-neutral-900 bg-transparent border-none outline-none w-full placeholder-neutral-300"
            placeholder="Story Bible Title (e.g. Signal Squad)"
            value={bible.title || ''}
            onChange={e => setBible((b: any) => ({ ...b, title: e.target.value }))}
          />
          <input
            className="text-sm text-neutral-500 bg-transparent border-none outline-none w-full mt-1 placeholder-neutral-400"
            placeholder="One-sentence logline..."
            value={bible.logline || ''}
            onChange={e => setBible((b: any) => ({ ...b, logline: e.target.value }))}
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
                  value={bible.world || ''}
                  onChange={e => setBible((b: any) => ({ ...b, world: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Art Style</label>
                  <select
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none bg-white text-sm"
                    value={bible.artStyle || 'cinematic'}
                    onChange={e => setBible((b: any) => ({ ...b, artStyle: e.target.value }))}
                  >
                    {ART_STYLES.map(s => (
                      <option key={s} value={s}>{s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Episode Structure</label>
                  <input
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
                    placeholder="e.g. Hook → Problem → Action → Lesson → CTA"
                    value={bible.episodeStructure || ''}
                    onChange={e => setBible((b: any) => ({ ...b, episodeStructure: e.target.value }))}
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
              {(bible.characters || []).map((char: StoryCharacter) => (
                <div key={char.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                    onClick={() => setExpandedChar(expandedChar === char.id ? null : char.id)}
                  >
                    <div className="flex items-center gap-3">
                      {char.referenceImageUrl ? (
                        <img src={char.referenceImageUrl} alt={char.name} className="w-8 h-8 rounded-full object-cover border border-neutral-200" />
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
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => generateCharacterImage(char)}
                          disabled={!char.imagePrompt || generatingImage === char.id}
                          className="flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {generatingImage === char.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                          Generate Reference Image
                        </button>
                        {char.referenceImageUrl && (
                          <img src={char.referenceImageUrl} alt="Reference" className="w-12 h-12 rounded-lg object-cover border border-neutral-200" />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {(bible.characters || []).length === 0 && (
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
              {(bible.locations || []).map((loc: StoryLocation) => (
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
                    </div>
                  )}
                </div>
              ))}
              {(bible.locations || []).length === 0 && (
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
                  value={bible.toneRules || ''}
                  onChange={e => setBible((b: any) => ({ ...b, toneRules: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Recurring Elements</label>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-20 text-sm"
                  placeholder="e.g. Villain arc, running catchphrase, recurring callbacks, mystery subplot..."
                  value={bible.recurringElements || ''}
                  onChange={e => setBible((b: any) => ({ ...b, recurringElements: e.target.value }))}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
