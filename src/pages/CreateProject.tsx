import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Sparkles, Layout, BookOpen } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import { TargetLengthField } from '../components/TargetLengthField';
import { targetLengthSeconds, targetWordCount } from '../utils/targetLength';
import { VoicePicker } from '../components/VoicePicker';

export function CreateProject() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [projectType, setProjectType] = useState<'educational' | 'story_episode' | 'standard'>('educational');
  const [universes, setUniverses] = useState<any[]>([]);
  const [episodeData, setEpisodeData] = useState({
    universeId: '',
    episodeNumber: 1,
    featuredCharacterIds: [] as string[],
    featuredLocationId: '',
    episodeConcept: '',
  });
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    script: '',
    settings: {
      aspectRatio: '16:9',
      targetLength: '60s',
      voiceStyle: 'professional',
      visualStyle: 'cinematic',
      language: 'en',
      hookStrategy: 'default',
      pacingIntensity: 'moderate',
      styleProfile: 'cinematic',
      exportMode: 'youtube',
      exportResolution: '1080p',
      exportPreset: 'veryfast',
    },
  });

  useEffect(() => {
    const fetchTemplates = async () => {
      setLoadingTemplates(true);
      try {
        const res = await authenticatedFetch('/api/templates');
        if (res.ok) setTemplates(await res.json());
      } catch (error) {
        console.error('Error fetching templates:', error);
      } finally {
        setLoadingTemplates(false);
      }
    };
    const fetchUniverses = async () => {
      try {
        const res = await authenticatedFetch('/api/universes');
        if (res.ok) setUniverses(await res.json());
      } catch (error) {
        console.error('Error fetching universes:', error);
      }
    };
    fetchTemplates();
    fetchUniverses();
  }, []);

  const applyTemplate = (template: any) => {
    setFormData(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        hookStrategy: template.hookStrategy,
        pacingIntensity: template.pacingIntensity,
        styleProfile: template.styleProfile,
        visualStyle: template.visualStyle,
        voiceStyle: template.voiceStyle,
      }
    }));
  };

  const selectedUniverse = universes.find(u => u.id === episodeData.universeId);

  useEffect(() => {
    if (projectType === 'story_episode') {
      setFormData(prev => ({
        ...prev,
        settings: { ...prev.settings, exportResolution: '1080p' },
      }));
    }
  }, [projectType]);

  useEffect(() => {
    if (projectType === 'story_episode' && selectedUniverse && episodeData.episodeConcept.trim()) {
      const episodeLabel = episodeData.episodeNumber ? `Episode ${episodeData.episodeNumber}: ` : '';
      setFormData(prev => ({
        ...prev,
        title: `${selectedUniverse.title} - ${episodeLabel}${episodeData.episodeConcept.trim()}`,
      }));
    }
  }, [projectType, episodeData.universeId, episodeData.episodeNumber, episodeData.episodeConcept]);

  const toggleCharacter = (charId: string) => {
    setEpisodeData(prev => ({
      ...prev,
      featuredCharacterIds: prev.featuredCharacterIds.includes(charId)
        ? prev.featuredCharacterIds.filter(id => id !== charId)
        : [...prev.featuredCharacterIds, charId],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload: any = { ...formData, projectType };
      if (projectType === 'story_episode') {
        payload.episodeNumber = episodeData.episodeNumber;
        payload.featuredCharacterIds = episodeData.featuredCharacterIds;
        payload.featuredLocationId = episodeData.featuredLocationId;
        if (episodeData.universeId && selectedUniverse) {
          payload.universe = selectedUniverse;
          payload.universeId = episodeData.universeId;
          payload.settings = {
            ...formData.settings,
            artStyle: selectedUniverse.artStyle,
            toneRules: selectedUniverse.toneRules,
            visualStyle: selectedUniverse.artStyle,
          };
        }
        if (episodeData.episodeConcept) {
          payload.description = episodeData.episodeConcept;
        }
      }
      const res = await authenticatedFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to create project: ${res.status} ${errorText}`);
      }
      const data = await res.json();
      if (data.id) {
        navigate(`/projects/${data.id}/edit`);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 text-neutral-500 hover:text-neutral-900 mb-6 font-medium transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Projects
      </button>

      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
        <div className="p-4 md:p-8 border-b border-neutral-100 bg-neutral-50/50">
          <h1 className="text-2xl md:text-3xl font-bold text-neutral-900 mb-2 flex items-center gap-3">
            <Sparkles className="w-8 h-8 text-indigo-600" />
            Create New Project
          </h1>
          <p className="text-neutral-500">Define your story and style to generate a short video.</p>
        </div>

        {/* Project type selector */}
        <div className="p-4 md:p-8 border-b border-neutral-100">
          <h3 className="text-sm font-bold text-neutral-400 uppercase tracking-wider mb-4">What are you creating?</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {([
              { value: 'educational', label: 'Educational Short', desc: 'Fact-based, informational video' },
              { value: 'story_episode', label: 'Story Episode', desc: 'Character-driven story with a Bible' },
              { value: 'standard', label: 'Standard Video', desc: 'General purpose video' },
            ] as const).map(type => (
              <button
                key={type.value}
                type="button"
                onClick={() => setProjectType(type.value)}
                className={`p-4 rounded-xl border-2 text-left transition-all ${
                  projectType === type.value ? 'border-indigo-600 bg-indigo-50' : 'border-neutral-200 hover:border-neutral-300'
                }`}
              >
                <span className={`block font-bold text-sm mb-0.5 ${projectType === type.value ? 'text-indigo-700' : 'text-neutral-900'}`}>{type.label}</span>
                <span className="block text-xs text-neutral-500">{type.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {projectType === 'story_episode' && (
          <div className="p-4 md:p-8 border-b border-neutral-100 space-y-5">
            <h3 className="text-sm font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
              <BookOpen className="w-4 h-4" /> Episode Settings
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Universe</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 outline-none bg-white text-sm"
                  value={episodeData.universeId}
                  onChange={e => setEpisodeData(prev => ({ ...prev, universeId: e.target.value, featuredCharacterIds: [], featuredLocationId: '' }))}
                >
                  <option value="">— Select a Universe —</option>
                  {universes.map(u => <option key={u.id} value={u.id}>{u.title}</option>)}
                </select>
                {universes.length === 0 && (
                  <p className="text-xs text-neutral-400 mt-1">No universes yet. <a href="/universes/new" className="text-indigo-600 hover:underline">Create one first.</a></p>
                )}
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Episode Number</label>
                <input
                  type="number"
                  min={1}
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
                  value={episodeData.episodeNumber}
                  onChange={e => setEpisodeData(prev => ({ ...prev, episodeNumber: Number(e.target.value) }))}
                />
              </div>
            </div>
            {selectedUniverse && (
              <>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Featured Characters</label>
                  <div className="flex flex-wrap gap-2">
                    {(selectedUniverse.characters || []).map((c: any) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCharacter(c.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                          episodeData.featuredCharacterIds.includes(c.id)
                            ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                            : 'border-neutral-200 text-neutral-600 hover:border-neutral-300'
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                    {(selectedUniverse.characters || []).length === 0 && (
                      <p className="text-xs text-neutral-400">No characters in this universe.</p>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Featured Location</label>
                  <select
                    className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 outline-none bg-white text-sm"
                    value={episodeData.featuredLocationId}
                    onChange={e => setEpisodeData(prev => ({ ...prev, featuredLocationId: e.target.value }))}
                  >
                    <option value="">— Flexible / AI decides —</option>
                    {(selectedUniverse.locations || []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Episode Concept</label>
              <textarea
                className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 outline-none resize-none h-20 text-sm"
                placeholder="What does this episode show or teach? What's the main conflict or event?"
                value={episodeData.episodeConcept}
                onChange={e => setEpisodeData(prev => ({ ...prev, episodeConcept: e.target.value }))}
              />
            </div>
          </div>
        )}

        {templates.length > 0 && projectType !== 'story_episode' && (
          <div className="p-4 md:p-8 border-b border-neutral-100">
            <h3 className="text-sm font-bold text-neutral-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Layout className="w-4 h-4" /> Quick Templates
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="p-4 rounded-xl border border-neutral-200 hover:border-indigo-500 hover:bg-indigo-50/50 transition-all text-left group"
                >
                  <span className="block font-bold text-neutral-900 group-hover:text-indigo-700 mb-1">{template.name}</span>
                  <span className="block text-[10px] text-neutral-500 uppercase font-bold">{template.styleProfile} • {template.pacingIntensity}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-4 md:p-8 space-y-8">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Project Title</label>
              <input
                required
                type="text"
                className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                placeholder="e.g., The History of Rome"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
            </div>

            {projectType !== 'story_episode' && (<>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Description / Idea</label>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all h-24 resize-none"
                  placeholder="Briefly describe what this video is about..."
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Script (Optional)</label>
                <p className="text-xs text-neutral-500 mb-2">
                  Tip: For a {targetLengthSeconds(formData.settings.targetLength)}s video, aim for
                  approximately {targetWordCount(targetLengthSeconds(formData.settings.targetLength))} words.
                </p>
                <textarea
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all h-48 font-mono text-sm"
                  placeholder="Paste your full script here, or let AI generate it from your idea..."
                  value={formData.script}
                  onChange={(e) => setFormData({ ...formData, script: e.target.value })}
                />
              </div>

            </>)}
          </div>

          <div className="border-t border-neutral-200 pt-8">
            <h3 className="text-lg font-bold text-neutral-900 mb-6">Video Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {projectType !== 'story_episode' && (
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Hook Strategy</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.hookStrategy}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, hookStrategy: e.target.value } })
                  }
                >
                  <option value="default">Default</option>
                  <option value="controversial">Controversial</option>
                  <option value="curiosity">Curiosity</option>
                  <option value="storytelling">Storytelling</option>
                  <option value="shocking">Shocking</option>
                </select>
              </div>
              )}

              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Pacing</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.pacingIntensity}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, pacingIntensity: e.target.value } })
                  }
                >
                  <option value="slow">Slow</option>
                  <option value="moderate">Moderate</option>
                  <option value="fast">Fast</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </div>

              {projectType !== 'story_episode' && (
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Style Profile</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.styleProfile}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, styleProfile: e.target.value } })
                  }
                >
                  <option value="cinematic">Cinematic</option>
                  <option value="minimal">Minimal</option>
                  <option value="high-contrast">High Contrast</option>
                  <option value="documentary">Documentary</option>
                </select>
              </div>
              )}
              
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Language</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white font-medium"
                  value={formData.settings.language}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, language: e.target.value } })
                  }
                >
                  <option value="en">English</option>
                  <option value="hi">Hindi (हिन्दी)</option>
                  <option value="te">Telugu (తెలుగు)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Export Mode</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setFormData({ 
                      ...formData, 
                      settings: { 
                        ...formData.settings, 
                        exportMode: 'youtube',
                        aspectRatio: '16:9',
                        exportPreset: 'veryfast'
                      } 
                    })}
                    className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                      formData.settings.exportMode === 'youtube' || formData.settings.aspectRatio === '16:9'
                        ? 'border-indigo-600 bg-indigo-50' 
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <div className="w-12 h-8 bg-neutral-200 rounded border border-neutral-300 flex items-center justify-center text-[10px] font-bold">16:9</div>
                    <span className="font-bold text-sm">YouTube</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ 
                      ...formData, 
                      settings: { 
                        ...formData.settings, 
                        exportMode: 'shorts',
                        aspectRatio: '9:16',
                        exportPreset: 'veryfast'
                      } 
                    })}
                    className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                      formData.settings.exportMode === 'shorts' || formData.settings.aspectRatio === '9:16'
                        ? 'border-indigo-600 bg-indigo-50' 
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <div className="w-8 h-12 bg-neutral-200 rounded border border-neutral-300 flex items-center justify-center text-[10px] font-bold">9:16</div>
                    <span className="font-bold text-sm">Shorts</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Resolution</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.exportResolution || '1080p'}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, exportResolution: e.target.value } })
                  }
                >
                  <option value="720p">720p (HD)</option>
                  <option value="1080p">1080p (Full HD)</option>
                  <option value="4k">4K (Ultra HD)</option>
                </select>
                {projectType === 'story_episode' && (
                  <p className="text-xs text-amber-600 mt-1">Recommended: 1080p for YouTube Shorts. 4K creates very large files.</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Render Preset</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.exportPreset || 'veryfast'}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, exportPreset: e.target.value } })
                  }
                >
                  <option value="ultrafast">Ultrafast (Lowest Quality)</option>
                  <option value="veryfast">Very Fast (Balanced)</option>
                  <option value="medium">Medium (Better Quality)</option>
                  <option value="slow">Slow (Best Quality)</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <TargetLengthField
                  value={formData.settings.targetLength}
                  onChange={(targetLength) =>
                    setFormData({ ...formData, settings: { ...formData.settings, targetLength } })
                  }
                />
              </div>

              {projectType !== 'story_episode' && (
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Voice</label>
                <VoicePicker
                  value={{
                    voiceStyle: formData.settings.voiceStyle,
                    clonedVoiceId: (formData.settings as any).clonedVoiceId,
                  }}
                  onChange={(v) =>
                    setFormData({ ...formData, settings: { ...formData.settings, ...v } })
                  }
                />
              </div>
              )}

              {projectType !== 'story_episode' && (
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Visual Style</label>
                <select
                  className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  value={formData.settings.visualStyle}
                  onChange={(e) =>
                    setFormData({ ...formData, settings: { ...formData.settings, visualStyle: e.target.value } })
                  }
                >
                  <option value="cinematic">Cinematic Realism</option>
                  <option value="anime">Anime / 2D Animation</option>
                  <option value="3d">3D Rendered</option>
                  <option value="watercolor">Watercolor Illustration</option>
                  <option value="cyberpunk">Cyberpunk / Neon</option>
                  <option value="minimalist">Minimalist / Flat</option>
                </select>
              </div>
              )}
            </div>
          </div>

          <div className="pt-6 flex justify-end">
            <button
              type="submit"
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
