import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Play, Loader2, FileText, Film, Image as ImageIcon, 
  Settings, Clock, Plus, Wand2, Download, AlertCircle, Music, Volume2,
  Edit2, Check, X, User, MapPin, Box, RefreshCw, XCircle, Mic
} from 'lucide-react';
import { VoiceCloner } from '../components/VoiceCloner';
import { authenticatedFetch } from '../utils/api';

interface Scene {
  id?: string;
  scene_id?: string;
  order: number;
  duration: number;
  narration_text: string;
  visual_prompt: string;
  visuals?: any[];
  suggestions?: string[];
  image_path?: string;
  status?: string;
}

interface ProjectSettings {
  aspectRatio?: string;
  targetLength?: string;
  voiceStyle?: string;
  visualStyle?: string;
  hookStrategy?: string;
  styleProfile?: string;
  exportMode?: string;
  exportResolution?: string;
  exportPreset?: string;
  [key: string]: any;
}

interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
  thumbnailText: string;
}

interface Project {
  id: string;
  project_id?: string;
  title: string;
  script: string;
  status: string;
  current_action?: string;
  progress_percent?: number;
  logs?: string[];
  output_path?: string;
  character_description?: string;
  world_entities?: {
    characters: { name: string; description: string; prompt: string }[];
    locations: { name: string; description: string; prompt: string }[];
    objects: { name: string; description: string; prompt: string }[];
  };
  settings: ProjectSettings;
  scenes: Scene[];
  seo_metadata?: SeoMetadata;
}

export function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [activeTab, setActiveTab] = useState(1);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editNarrationText, setEditNarrationText] = useState("");
  const [isUpdatingNarration, setIsUpdatingNarration] = useState(false);
  const [scriptText, setScriptText] = useState('');
  const [characterText, setCharacterText] = useState('');
  const [worldEntities, setWorldEntities] = useState<any>({ characters: [], locations: [], objects: [] });
  const [isUpdatingCharacter, setIsUpdatingCharacter] = useState(false);
  const [isAnalyzingWorld, setIsAnalyzingWorld] = useState(false);
  const [settings, setSettings] = useState<ProjectSettings>({});
  
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [ambientEnabled, setAmbientEnabled] = useState(true);
  
  const [isGeneratingScenes, setIsGeneratingScenes] = useState(false);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [isGeneratingMedia, setIsGeneratingMedia] = useState(false);
  const [generatingAudioId, setGeneratingAudioId] = useState<string | null>(null);
  
  const [isRendering, setIsRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string>('idle');
  const [currentAction, setCurrentAction] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const [seoMetadata, setSeoMetadata] = useState<SeoMetadata | null>(null);
  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  const isBusyStatus = (status: string) => 
    ['processing', 'scripting', 'scene_parsing', 'generating_assets', 'stitching_video'].includes(status);

  const saveSettings = async (newSettings: ProjectSettings) => {
    try {
      await authenticatedFetch(`/api/projects/${id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: newSettings })
      });
      setSettings(newSettings);
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  };

  const fetchProject = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`/api/projects/${id}`);
      if (!res.ok) throw new Error('Failed to fetch project');
      const data = await res.json();
      setProject(data);
      setScriptText(data.script || '');
      setCharacterText(data.character_description || '');
      setWorldEntities(data.world_entities || { characters: [], locations: [], objects: [] });
      setSettings(data.settings || {
        hookStrategy: 'Curiosity',
        exportMode: 'youtube',
        exportResolution: '1080p',
        exportPreset: 'veryfast'
      });
      setRenderStatus(data.status || 'idle');
      setCurrentAction(data.current_action || '');
      setProgressPercent(data.progress_percent || 0);
      setActivityLogs(data.logs || []);
      if (data.seo_metadata) setSeoMetadata(data.seo_metadata);
      
      if (isBusyStatus(data.status)) {
        setIsRendering(true);
      } else {
        setIsRendering(false);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchProject();
  }, [id, fetchProject]);

  useEffect(() => {
    if (isRendering) {
      pollInterval.current = setInterval(async () => {
        try {
          const res = await authenticatedFetch(`/api/projects/${id}/status`);
          if (res.ok) {
            const data = await res.json();
            setRenderStatus(data.status);
            setCurrentAction(data.current_action || '');
            setProgressPercent(data.progress_percent || 0);
            setActivityLogs(data.logs || []);
            
            if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
              setIsRendering(false);
              fetchProject();
              if (pollInterval.current) {
                clearInterval(pollInterval.current);
                pollInterval.current = null;
              }
            }
          }
        } catch (e) {
          console.error('Polling error', e);
        }
      }, 3000);
    }
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [isRendering, id, fetchProject]);

  const handleGenerateScript = async () => {
    if (!project) return;
    setIsGeneratingScript(true);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/generate-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error('Failed to generate script');
      const data = await res.json();
      setScriptText(data.script || '');
      if (data.seoMetadata) setSeoMetadata(data.seoMetadata);
      await fetchProject();
    } catch (err: any) {
      console.error('handleGenerateScript error:', err);
      alert(err.message);
    } finally {
      setIsGeneratingScript(false);
    }
  };

  const handleGenerateScenes = async () => {
    if (!project) return;
    setIsGeneratingScenes(true);
    try {
      // Pass the current scriptText to the server so it uses the edited version if present
      const res = await authenticatedFetch(`/api/projects/${id}/generate-scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: scriptText })
      });
      
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || 'Failed to generate scenes');
      }
      
      await fetchProject();
      setActiveTab(3); // Go to Scenes tab
    } catch (err: any) {
      console.error('handleGenerateScenes error:', err);
      if (err.message === 'Failed to fetch') {
        alert('The request timed out or connection was lost. The server might still be generating your scenes in the background. Please wait 30 seconds and refresh the page.');
      } else {
        alert(err.message);
      }
    } finally {
      setIsGeneratingScenes(false);
    }
  };

  const handleGenerateAllAssets = async () => {
    if (!project?.scenes) return;
    setIsGeneratingMedia(true);
    try {
      for (const scene of project.scenes) {
        const sceneId = scene.id || scene.scene_id;
        if (!sceneId || scene.status === 'completed') continue;
        try {
          const res = await authenticatedFetch(`/api/projects/${id}/scenes/${sceneId}/generate-image`, {
            method: 'POST'
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data.url) {
            setProject(prev => prev ? {
              ...prev,
              scenes: prev.scenes.map(s =>
                (s.id === sceneId || s.scene_id === sceneId)
                  ? { ...s, image_path: data.url, status: 'completed' }
                  : s
              )
            } : prev);
          }
        } catch (err) {
          console.warn('Scene image failed, skipping:', sceneId, err);
        }
      }
    } finally {
      setIsGeneratingMedia(false);
      await fetchProject();
    }
  };

  const handleGenerateAudio = async (sceneId: string) => {
    setGeneratingAudioId(sceneId);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/scenes/${sceneId}/generate-audio`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate audio');
      await fetchProject();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGeneratingAudioId(null);
    }
  };

  const handleDownload = async () => {
    if (!project) return;
    const fileName = project.title ? `${project.title.replace(/[^a-z0-9]/gi, '_')}.mp4` : 'video.mp4';
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/download`);
      if (!res.ok) throw new Error('Download failed');

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.downloadUrl) {
          const a = document.createElement('a');
          a.href = data.downloadUrl;
          a.target = '_blank';
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          return;
        }
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error('Download error:', err);
      alert('Failed to download video. Please try again.');
    }
  };
  
  const handleUpdateNarration = async (sceneId: string) => {
    if (!(editNarrationText || '').trim()) return;
    
    setIsUpdatingNarration(true);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/scenes/${sceneId}/update-narration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narrationText: editNarrationText })
      });
      
      if (!res.ok) throw new Error('Failed to update narration');
      
      await fetchProject();
      setEditingSceneId(null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsUpdatingNarration(false);
    }
  };

  const [isResetting, setIsResetting] = useState(false);

  const handleClearQuota = async () => {
    try {
      const res = await authenticatedFetch('/api/projects/clear-ai-quota', { method: 'POST' });
      if (res.ok) {
        alert('AI models reset. Now click "Retry Failed Assets" to regenerate images.');
      }
    } catch (e) {
      alert('Failed to reset AI status');
    }
  };

  const handleRetryAssets = async () => {
    setIsResetting(true);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/retry-failed-assets`, { method: 'POST' });
      if (res.ok) {
        alert('Assets reset to pending. Click "Render" to start regeneration.');
        fetchProject();
      }
    } catch (e) {
      alert('Failed to reset assets');
    } finally {
      setIsResetting(false);
    }
  };

  const handleUpdateCharacter = async (propagate: boolean = false) => {
    setIsUpdatingCharacter(true);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/update-character`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          characterDescription: characterText,
          propagate
        })
      });
      
      if (!res.ok) throw new Error('Failed to update character description');
      
      await fetchProject();
      alert(propagate ? 'Anchor saved and applied to all scenes! You might need to re-render to see changes.' : 'Consistency Seed saved successfully!');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsUpdatingCharacter(false);
    }
  };

  const handleUpdateWorldEntities = async (updatedEntities: any) => {
    setIsUpdatingCharacter(true);
    try {
      // Also save the character seed (Master Anchor) to ensure they are in sync
      await authenticatedFetch(`/api/projects/${id}/update-character`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterDescription: characterText })
      });

      const res = await authenticatedFetch(`/api/projects/${id}/update-world-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldEntities: updatedEntities })
      });
      
      if (!res.ok) throw new Error('Failed to update world entities');
      
      await fetchProject();
      alert('World settings and character seed saved!');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsUpdatingCharacter(false);
    }
  };

  const handleAnalyzeWorld = async () => {
    if (!(scriptText || '').trim() || !project) {
      alert("Please provide a script first.");
      return;
    }
    setIsAnalyzingWorld(true);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/analyze-world`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: scriptText })
      });
      
      if (!res.ok) throw new Error('Failed to analyze world');
      
      await fetchProject();
      alert('Script analyzed! Characters, locations, and objects identified.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsAnalyzingWorld(false);
    }
  };

  const handleRender = async () => {
    setIsRendering(true);
    setRenderStatus('processing');
    setActivityLogs([]);
    try {
      const res = await authenticatedFetch(`/api/projects/${id}/pipeline/run`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start render pipeline');
    } catch (err: any) {
      alert(err.message);
      setIsRendering(false);
      setRenderStatus('failed');
    }
  };

  const handleCancelRender = async () => {
    if (!confirm('Are you sure you want to kill the current render process?')) return;
    try {
      await authenticatedFetch(`/api/projects/${id}/cancel`, { method: 'POST' });
      setIsRendering(false);
      setRenderStatus('cancelled');
    } catch (e) {
      alert('Failed to cancel render');
    }
  };

  const handleAnalyzeImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsAnalyzingImage(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        const res = await authenticatedFetch(`/api/projects/${id}/analyze-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64Data })
        });
        
        if (!res.ok) throw new Error('Failed to analyze image');
        const data = await res.json();
        alert('Image analyzed! Content generated in Script and World tabs.');
        await fetchProject();
        setActiveTab(1); // Go to script
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsAnalyzingImage(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-neutral-900">Error loading project</h2>
        <p className="text-neutral-500 mt-2">{error}</p>
        <button onClick={() => navigate('/')} className="text-indigo-600 mt-4 font-medium">Back to Dashboard</button>
      </div>
    );
  }

  const tabs = [
    { id: 1, name: 'Script', icon: FileText },
    { id: 2, name: 'World & Casting', icon: User },
    { id: 3, name: 'Scenes', icon: Film },
    { id: 4, name: 'Media', icon: ImageIcon },
    { id: 5, name: 'Export', icon: Settings },
    { id: 6, name: 'Timeline', icon: Clock },
  ];

  return (
    <div className="flex flex-col h-screen bg-neutral-50">
      {/* HEADER */}
      <header className="bg-white border-b border-neutral-200 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/')} className="text-neutral-500 hover:text-neutral-900 transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold text-neutral-900 truncate max-w-md">{project.title}</h1>
        </div>
        
        <div className="flex items-center gap-6">
          {isBusyStatus(renderStatus) && (
            <button 
              onClick={handleCancelRender}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 rounded-full text-xs font-black uppercase tracking-tighter border border-red-200 hover:bg-red-100 transition-all animate-pulse shadow-sm"
            >
              <XCircle className="w-3.5 h-3.5" />
              Kill Active Build
            </button>
          )}
          <div className="flex items-center gap-4 border-r border-neutral-200 pr-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={musicEnabled} 
                onChange={(e) => setMusicEnabled(e.target.checked)}
                className="rounded text-indigo-600 focus:ring-indigo-500"
              />
              <Music className="w-4 h-4 text-neutral-500" />
              <span className="text-sm font-medium text-neutral-700">Music</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={ambientEnabled} 
                onChange={(e) => setAmbientEnabled(e.target.checked)}
                className="rounded text-indigo-600 focus:ring-indigo-500"
              />
              <Volume2 className="w-4 h-4 text-neutral-500" />
              <span className="text-sm font-medium text-neutral-700">Ambient</span>
            </label>
          </div>
          
          <button 
            onClick={() => navigate(`/projects/${id}`)}
            className="px-4 py-2 text-sm font-bold text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
          >
            Preview
          </button>
          <button 
            onClick={handleRender}
            disabled={isRendering}
            className="px-4 py-2 text-sm font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {isRendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Render
          </button>
        </div>
      </header>

      {/* TAB BAR */}
      <div className="bg-white border-b border-neutral-200 px-6 flex gap-8 shrink-0">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 py-4 border-b-2 transition-colors ${
                isActive ? 'border-indigo-600 text-indigo-600 font-bold' : 'border-transparent text-neutral-500 hover:text-neutral-900 font-medium'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.id}. {tab.name}
            </button>
          );
        })}
      </div>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-5xl mx-auto">
          
          {/* TAB 1: SCRIPT */}
          {activeTab === 1 && (
            <div className="space-y-8">
              {/* IMAGE TO VIDEO DROPZONE */}
              <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-2xl p-8 border-2 border-dashed border-indigo-200">
                <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center mb-4 text-indigo-600">
                    {isAnalyzingImage ? <Loader2 className="w-8 h-8 animate-spin" /> : <ImageIcon className="w-8 h-8" />}
                  </div>
                  <h3 className="text-xl font-bold text-neutral-900 mb-2">Image as Reference (New Feature)</h3>
                  <p className="text-neutral-500 max-w-lg mb-6">
                    Upload an image and the AI will analyze its objects, characters, and mood to build a unique story and visual script.
                  </p>
                  <label className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-bold transition-all cursor-pointer shadow-lg shadow-indigo-100 flex items-center gap-2">
                    <Wand2 className="w-4 h-4" />
                    {isAnalyzingImage ? 'Analyzing Reference...' : 'Upload Image as Story Seed'}
                    <input type="file" className="hidden" accept="image/*" onChange={handleAnalyzeImage} disabled={isAnalyzingImage} />
                  </label>
                </div>
              </div>

              <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-bold text-neutral-900">Script Editor</h2>
                  <button 
                    onClick={handleGenerateScript}
                    disabled={isGeneratingScript}
                    className="text-sm font-bold text-indigo-600 flex items-center gap-2 hover:text-indigo-700 disabled:opacity-50"
                  >
                    {isGeneratingScript ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} 
                    AI Generate Script
                  </button>
                </div>
                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  className="w-full h-64 p-4 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-sm resize-none"
                  placeholder="Write or paste your script here..."
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6 space-y-4">
                  <h3 className="font-bold text-neutral-900">Video Format</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setSettings({ ...settings, exportMode: 'youtube' })}
                      className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-colors ${
                        settings.exportMode === 'youtube' ? 'border-indigo-600 bg-indigo-50' : 'border-neutral-200 hover:border-neutral-300'
                      }`}
                    >
                      <div className="w-12 h-8 bg-neutral-200 rounded border border-neutral-300 flex items-center justify-center text-[10px] font-bold">16:9</div>
                      <span className="font-bold text-sm">YouTube</span>
                    </button>
                    <button
                      onClick={() => setSettings({ ...settings, exportMode: 'shorts' })}
                      className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-colors ${
                        settings.exportMode === 'shorts' ? 'border-indigo-600 bg-indigo-50' : 'border-neutral-200 hover:border-neutral-300'
                      }`}
                    >
                      <div className="w-8 h-12 bg-neutral-200 rounded border border-neutral-300 flex items-center justify-center text-[10px] font-bold">9:16</div>
                      <span className="font-bold text-sm">Shorts</span>
                    </button>
                  </div>

                  <div className="pt-2">
                    <label className="block text-sm font-bold text-neutral-700 mb-2">Language</label>
                    <select 
                      value={settings.language || 'English'}
                      onChange={(e) => saveSettings({ ...settings, language: e.target.value })}
                      className="w-full p-3 rounded-xl border border-neutral-300 outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="English">English</option>
                      <option value="Telugu">Telugu (తెలుగు)</option>
                      <option value="Hindi">Hindi (हिन्दी)</option>
                      <option value="Spanish">Spanish (Español)</option>
                    </select>
                  </div>

                  <div className="pt-2">
                    <label className="block text-sm font-bold text-neutral-700 mb-2">Resolution</label>
                    <select 
                      value={settings.exportResolution || '1080p'}
                      onChange={(e) => saveSettings({ ...settings, exportResolution: e.target.value })}
                      className="w-full p-3 rounded-xl border border-neutral-300 outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="720p">720p (HD)</option>
                      <option value="1080p">1080p (Full HD)</option>
                      <option value="4k">4K (Ultra HD - Best for Big Screens)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-bold text-neutral-700 mb-2">Motion Intensity</label>
                    <select 
                      value={settings.motionIntensity || 'medium'}
                      onChange={(e) => saveSettings({ ...settings, motionIntensity: e.target.value })}
                      className="w-full p-3 rounded-xl border border-neutral-300 outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="low">Low (Subtle)</option>
                      <option value="medium">Medium (Standard)</option>
                      <option value="high">High (Dramatic)</option>
                    </select>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6 space-y-4">
                  <div className="flex justify-between items-center">
                    <h3 className="font-bold text-neutral-900">Hook Options</h3>
                    <button className="text-xs font-bold text-indigo-600 hover:text-indigo-700">Generate 3 Options</button>
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-neutral-700 mb-2">Hook Strategy</label>
                    <select 
                      value={settings.hookStrategy || 'Curiosity'}
                      onChange={(e) => setSettings({ ...settings, hookStrategy: e.target.value })}
                      className="w-full p-3 rounded-xl border border-neutral-300 outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Curiosity">Curiosity</option>
                      <option value="Dramatic">Dramatic</option>
                      <option value="Informative">Informative</option>
                      <option value="Inspirational">Inspirational</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-bold text-neutral-700 mb-2">Cinematic Effect</label>
                    <select 
                      value={settings.motionEffect || 'zoom_in'}
                      onChange={(e) => saveSettings({ ...settings, motionEffect: e.target.value })}
                      className="w-full p-3 rounded-xl border border-neutral-300 outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="still">No Motion</option>
                      <option value="zoom_in">Ken Burns: Zoom In</option>
                      <option value="zoom_out">Ken Burns: Zoom Out</option>
                      <option value="pan_right">Pan: Right</option>
                      <option value="pan_left">Pan: Left</option>
                      <option value="random">AI Recommended (Mixed)</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleGenerateScenes}
                  disabled={isGeneratingScenes || !(scriptText || '').trim()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  {isGeneratingScenes ? <Loader2 className="w-5 h-5 animate-spin" /> : <Film className="w-5 h-5" />}
                  Generate Scenes
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: WORLD & CASTING */}
          {activeTab === 2 && (
            <div className="space-y-8">
              <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-8 text-white">
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="p-2 bg-white/20 backdrop-blur-sm rounded-lg">
                        <User className="w-6 h-6" />
                      </div>
                      <h2 className="text-2xl font-bold">World & Casting</h2>
                    </div>
                    <button 
                      onClick={handleAnalyzeWorld}
                      disabled={isAnalyzingWorld || !project?.script}
                      className="px-4 py-2 bg-white/10 hover:bg-white/20 active:bg-white/30 rounded-lg text-sm font-bold transition-all flex items-center gap-2 backdrop-blur-sm border border-white/20 disabled:opacity-50"
                    >
                      {isAnalyzingWorld ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                      {worldEntities.characters.length > 0 || worldEntities.locations.length > 0 ? 'Re-analyze Script' : 'Analyze Script for Entities'}
                    </button>
                  </div>
                  <p className="text-white/80 max-w-2xl">
                    Define consistent looks for your characters, locations, and key objects. 
                    The Director Agent has extracted these from your script and suggested visual descriptions.
                  </p>
                </div>
                
                <div className="p-8">
                  {/* Global Character Description (Master Visual Anchor) */}
                  <div className="mb-10">
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex flex-col">
                        <h3 className="font-bold text-neutral-900 flex items-center gap-2">
                          <User className="w-4 h-4 text-indigo-600" /> Master Visual Anchor (Consistency Seed)
                        </h3>
                        <p className="text-xs text-neutral-500 mt-1">
                          Describe your main character or theme here to keep it consistent across every AI-generated image.
                        </p>
                      </div>
                    </div>
                    <textarea
                      value={characterText}
                      onChange={(e) => setCharacterText(e.target.value)}
                      className="w-full h-24 p-4 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm resize-none"
                      placeholder="e.g. A young male scientist, mid-20s, wearing thick glasses and a white lab coat with a blue tie, messy brown hair..."
                    />
                    <div className="flex justify-between items-center mt-2">
                       <div className="flex gap-4">
                         <button
                           onClick={handleClearQuota}
                           className="text-xs font-medium text-neutral-500 hover:text-indigo-600 transition-colors flex items-center gap-1 group"
                         >
                           <Wand2 className="w-3 h-3 group-hover:rotate-12 transition-transform" /> Reset AI Models
                         </button>
                         <button
                           onClick={handleRetryAssets}
                           disabled={isResetting}
                           className="text-xs font-medium text-neutral-500 hover:text-rose-600 transition-colors flex items-center gap-1 group"
                         >
                           {isResetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 group-hover:rotate-180 transition-transform duration-500" />}
                           Retry Failed Assets
                         </button>
                       </div>
                       <div className="flex gap-2">
                         <button
                           onClick={() => handleUpdateCharacter(false)}
                           disabled={isUpdatingCharacter}
                           title="Save this description as the global consistency seed"
                           className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-1 bg-indigo-50 px-3 py-1.5 rounded-lg transition-colors border border-indigo-100"
                         >
                           {isUpdatingCharacter ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                           Save Seed Only
                         </button>
                         <button
                           onClick={() => {
                             if(confirm("This will overwrite/append to the visual prompts of ALL existing scenes. Are you sure?")) {
                               handleUpdateCharacter(true);
                             }
                           }}
                           disabled={isUpdatingCharacter}
                           title="Will append this description to all existing visual prompts"
                           className="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 flex items-center gap-1 px-3 py-1.5 rounded-lg transition-colors border border-indigo-500 shadow-sm"
                         >
                           <Wand2 className="w-3 h-3" /> Save & Overwrite Scenes
                         </button>
                       </div>
                     </div>
                  </div>

                  {/* World Entities Grid */}
                  <div className="space-y-8">
                    {/* Characters Section */}
                    <div>
                      <h3 className="text-lg font-bold text-neutral-900 mb-4 flex items-center gap-2 border-b border-neutral-100 pb-2">
                        <User className="w-5 h-5 text-indigo-600" /> Characters & Cast
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {worldEntities.characters.map((char: any, idx: number) => (
                          <div key={idx} className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 group">
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-bold text-neutral-800">{char.name}</h4>
                            </div>
                            <p className="text-xs text-neutral-500 mb-3">{char.description}</p>
                            <label className="block text-[10px] font-bold text-neutral-400 uppercase mb-1">Visual Prompt Detail</label>
                            <textarea
                              value={char.prompt}
                              onChange={(e) => {
                                const newChars = [...worldEntities.characters];
                                newChars[idx].prompt = e.target.value;
                                setWorldEntities({ ...worldEntities, characters: newChars });
                              }}
                              className="w-full text-xs p-2 rounded-lg border border-neutral-200 bg-white min-h-[60px] focus:ring-1 focus:ring-indigo-500 outline-none"
                            />
                          </div>
                        ))}
                        {worldEntities.characters.length === 0 && (
                          <p className="text-sm text-neutral-400 italic py-4">No characters identified yet.</p>
                        )}
                      </div>
                    </div>

                    {/* Locations Section */}
                    <div>
                      <h3 className="text-lg font-bold text-neutral-900 mb-4 flex items-center gap-2 border-b border-neutral-100 pb-2">
                        <MapPin className="w-5 h-5 text-indigo-600" /> Locations & Environments
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {worldEntities.locations.map((loc: any, idx: number) => (
                          <div key={idx} className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 group">
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-bold text-neutral-800">{loc.name}</h4>
                            </div>
                            <p className="text-xs text-neutral-500 mb-3">{loc.description}</p>
                            <label className="block text-[10px] font-bold text-neutral-400 uppercase mb-1">Visual Prompt Detail</label>
                            <textarea
                              value={loc.prompt}
                              onChange={(e) => {
                                const newLocs = [...worldEntities.locations];
                                newLocs[idx].prompt = e.target.value;
                                setWorldEntities({ ...worldEntities, locations: newLocs });
                              }}
                              className="w-full text-xs p-2 rounded-lg border border-neutral-200 bg-white min-h-[60px] focus:ring-1 focus:ring-indigo-500 outline-none"
                            />
                          </div>
                        ))}
                        {worldEntities.locations.length === 0 && (
                          <p className="text-sm text-neutral-400 italic py-4">No locations identified yet.</p>
                        )}
                      </div>
                    </div>

                    {/* Objects Section */}
                    <div>
                      <h3 className="text-lg font-bold text-neutral-900 mb-4 flex items-center gap-2 border-b border-neutral-100 pb-2">
                        <Box className="w-5 h-5 text-indigo-600" /> Key Objects & Props
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {worldEntities.objects.map((obj: any, idx: number) => (
                          <div key={idx} className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 group">
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-bold text-neutral-800">{obj.name}</h4>
                            </div>
                            <p className="text-xs text-neutral-500 mb-3">{obj.description}</p>
                            <label className="block text-[10px] font-bold text-neutral-400 uppercase mb-1">Visual Prompt Detail</label>
                            <textarea
                              value={obj.prompt}
                              onChange={(e) => {
                                const newObjs = [...worldEntities.objects];
                                newObjs[idx].prompt = e.target.value;
                                setWorldEntities({ ...worldEntities, objects: newObjs });
                              }}
                              className="w-full text-xs p-2 rounded-lg border border-neutral-200 bg-white min-h-[60px] focus:ring-1 focus:ring-indigo-500 outline-none"
                            />
                          </div>
                        ))}
                        {worldEntities.objects.length === 0 && (
                          <p className="text-sm text-neutral-400 italic py-4">No key objects identified yet.</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-10 flex justify-end">
                    <button
                      onClick={() => handleUpdateWorldEntities(worldEntities)}
                      disabled={isUpdatingCharacter}
                      className="px-8 py-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 flex items-center gap-2 disabled:opacity-50"
                    >
                      {isUpdatingCharacter ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
                      Save World Settings
                    </button>
                  </div>
                </div>

                {/* Voice Cloning Section */}
                <div className="bg-neutral-50 p-8 border-t border-neutral-200">
                  <div className="max-w-xl mx-auto">
                    <div className="mb-6">
                      <h3 className="text-lg font-bold text-neutral-900 mb-1">Authentic Voice Cloning</h3>
                      <p className="text-sm text-neutral-500">
                        Instead of using full AI voices, you can upload samples of your own voice or a dedicated segment voice to make the content more authentic.
                      </p>
                    </div>
                    
                    {settings.customVoiceId ? (
                      <div className="bg-white p-6 rounded-2xl border border-green-200 shadow-sm flex items-center justify-between">
                         <div className="flex items-center gap-3">
                           <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                             <Volume2 className="w-5 h-5 text-green-600" />
                           </div>
                           <div>
                             <p className="font-bold text-neutral-900">Custom Voice Active</p>
                             <p className="text-xs text-neutral-500">All scenes will be narrated using your cloned voice.</p>
                           </div>
                         </div>
                         <button 
                           onClick={() => saveSettings({ ...settings, customVoiceId: undefined })}
                           className="text-xs font-bold text-red-600 hover:underline"
                         >
                           Remove
                         </button>
                      </div>
                    ) : (
                      <VoiceCloner 
                        onVoiceCloned={(voiceId) => saveSettings({ ...settings, customVoiceId: voiceId })} 
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: SCENES */}
          {activeTab === 3 && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold text-neutral-900">Scene Breakdown</h2>
                <button className="flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                  <Plus className="w-4 h-4" /> Add Scene
                </button>
              </div>

              {!project.scenes || project.scenes.length === 0 ? (
                <div className="bg-white rounded-2xl border-2 border-dashed border-neutral-200 p-12 text-center">
                  <Film className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-neutral-900 mb-2">No scenes yet</h3>
                  <p className="text-neutral-500">Go to the Script tab and click Generate Scenes.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {[...project.scenes].sort((a, b) => a.order - b.order).map((scene, idx) => {
                    const sceneId = scene.id || scene.scene_id || String(idx);
                    return (
                      <div key={sceneId} className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6 relative">
                      <div className="absolute top-6 right-6 bg-neutral-100 text-neutral-600 text-xs font-bold px-2 py-1 rounded-md flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {scene.duration}s
                      </div>
                      
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm">
                          {idx + 1}
                        </div>
                        <h3 className="font-bold text-neutral-900">Scene {idx + 1}</h3>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <div className="flex justify-between items-center mb-2">
                            <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider">Narration</label>
                            {editingSceneId === sceneId ? (
                              <div className="flex gap-2">
                                <button 
                                  onClick={() => handleUpdateNarration(sceneId)}
                                  disabled={isUpdatingNarration}
                                  className="text-green-600 hover:text-green-700 p-1 rounded-md hover:bg-green-50 transition-colors"
                                  title="Save changes"
                                >
                                  {isUpdatingNarration ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                </button>
                                <button 
                                  onClick={() => setEditingSceneId(null)}
                                  className="text-red-500 hover:text-red-600 p-1 rounded-md hover:bg-red-50 transition-colors"
                                  title="Cancel"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <button 
                                onClick={() => {
                                  setEditingSceneId(sceneId);
                                  setEditNarrationText(scene.narration_text || "");
                                }}
                                className="text-neutral-400 hover:text-indigo-600 p-1 rounded-md hover:bg-indigo-50 transition-colors"
                                title="Edit narration"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          
                          {editingSceneId === sceneId ? (
                            <textarea
                              value={editNarrationText}
                              onChange={(e) => setEditNarrationText(e.target.value)}
                              className="w-full text-sm text-neutral-700 bg-white p-3 rounded-lg border-2 border-indigo-500 outline-none min-h-[80px] transition-all shadow-md focus:shadow-indigo-100"
                              autoFocus
                            />
                          ) : (
                            <p className="text-sm text-neutral-700 bg-neutral-50 p-3 rounded-lg border border-neutral-100 min-h-[80px]">
                              {scene.narration_text}
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2">Visual Prompt</label>
                          <p className="text-sm text-neutral-700 bg-neutral-50 p-3 rounded-lg border border-neutral-100 min-h-[80px]">
                            {scene.visual_prompt}
                          </p>
                        </div>
                      </div>

                      {scene.suggestions && scene.suggestions.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-neutral-100">
                          <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2">Suggestions</label>
                          <div className="flex flex-wrap gap-2">
                            {scene.suggestions.map((sug, i) => (
                              <span key={i} className="px-3 py-1 bg-amber-50 text-amber-700 text-xs font-medium rounded-full border border-amber-100">
                                {sug}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: MEDIA */}
          {activeTab === 4 && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold text-neutral-900">Media Assets</h2>
                <button 
                  onClick={handleGenerateAllAssets}
                  disabled={isGeneratingMedia || !project.scenes?.length}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg font-bold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {isGeneratingMedia ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                  Generate All Assets
                </button>
              </div>

              {!project.scenes || project.scenes.length === 0 ? (
                <div className="bg-white rounded-2xl border-2 border-dashed border-neutral-200 p-12 text-center">
                  <ImageIcon className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-neutral-900 mb-2">No scenes available</h3>
                  <p className="text-neutral-500">Generate scenes first to create media.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {[...project.scenes].sort((a, b) => a.order - b.order).map((scene, idx) => {
                    const sceneId = scene.id || scene.scene_id || String(idx);
                    const isGeneratingThisAudio = generatingAudioId === sceneId;
                    
                    return (
                      <div key={sceneId} className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden flex flex-col">
                        <div className="aspect-video bg-neutral-100 relative">
                          {scene.image_path ? (
                            <img src={scene.image_path} alt={`Scene ${idx + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-neutral-300">
                              <ImageIcon className="w-8 h-8" />
                            </div>
                          )}
                          <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm text-white text-xs font-bold px-2 py-1 rounded">
                            Scene {idx + 1}
                          </div>
                          <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-sm text-white text-xs font-bold px-2 py-1 rounded flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {scene.duration}s
                          </div>
                        </div>
                        <div className="p-4 flex-1 flex flex-col">
                          {editingSceneId === sceneId ? (
                            <div className="mb-4 flex-1">
                              <textarea
                                value={editNarrationText}
                                onChange={(e) => setEditNarrationText(e.target.value)}
                                className="w-full text-xs text-neutral-700 bg-white p-2 rounded-lg border-2 border-indigo-500 outline-none h-24"
                                autoFocus
                              />
                              <div className="flex justify-end gap-2 mt-2">
                                <button 
                                  onClick={() => setEditingSceneId(null)}
                                  className="px-2 py-1 text-[10px] font-bold text-neutral-500 hover:text-neutral-700"
                                >
                                  Cancel
                                </button>
                                <button 
                                  onClick={() => handleUpdateNarration(sceneId)}
                                  disabled={isUpdatingNarration}
                                  className="px-2 py-1 text-[10px] font-bold bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {isUpdatingNarration ? 'Saving...' : 'Save & Regenerate'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="group relative mb-4 flex-1">
                              <p className="text-sm text-neutral-600 line-clamp-2">
                                "{scene.narration_text}"
                              </p>
                              <button 
                                onClick={() => {
                                  setEditingSceneId(sceneId);
                                  setEditNarrationText(scene.narration_text || "");
                                }}
                                className="absolute -top-1 -right-1 p-1 bg-white border border-neutral-200 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400 hover:text-indigo-600 shadow-sm"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                          
                          <button 
                            onClick={() => handleGenerateAudio(sceneId)}
                            disabled={isGeneratingThisAudio || editingSceneId === sceneId || isUpdatingNarration}
                            className="w-full py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            {isGeneratingThisAudio ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                            Generate Audio
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: EXPORT */}
          {activeTab === 5 && (
            <div className="max-w-2xl mx-auto space-y-8">
              <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-8">
                <h2 className="text-2xl font-bold text-neutral-900 mb-2 text-center">Ready to Render</h2>
                <p className="text-neutral-500 mb-8 text-center">Review your settings and start the final video generation pipeline.</p>
                
                {/* ADVANCED PROGRESS UI */}
                {(isRendering || isBusyStatus(renderStatus) || progressPercent > 0) && (
                  <div className="mb-8 space-y-4">
                    <div className="flex justify-between items-end mb-1">
                      <div className="flex flex-col items-start">
                         <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">{renderStatus === 'processing' ? 'BUILDING' : renderStatus.toUpperCase()}</span>
                         <span className="text-sm font-medium text-neutral-900">{currentAction || 'Initializing...'}</span>
                      </div>
                      <span className="text-sm font-bold text-neutral-900">{Math.round(progressPercent)}%</span>
                    </div>
                    <div className="w-full h-3 bg-neutral-100 rounded-full overflow-hidden border border-neutral-200">
                      <div 
                        className="h-full bg-indigo-600 transition-all duration-500 relative"
                        style={{ width: `${progressPercent}%` }}
                      >
                        <div className="absolute inset-0 bg-white/20 animate-pulse" />
                      </div>
                    </div>

                    {/* ACTIVITY LOG (ChatGPT Style) */}
                    <div className="bg-neutral-900 rounded-xl p-4 h-48 overflow-y-auto font-mono text-[11px] space-y-1">
                      {activityLogs.length === 0 && <div className="text-neutral-600 uppercase tracking-widest text-[9px]">Awaiting system initialization...</div>}
                      {activityLogs.map((log, i) => (
                        <div key={i} className="text-neutral-400 group flex gap-2">
                          <span className="text-neutral-600">{new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="text-indigo-400 font-bold">»</span>
                          <span className="flex-1">{log}</span>
                        </div>
                      ))}
                    </div>

                    <button 
                      onClick={handleCancelRender}
                      className="w-full py-4 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-xs uppercase tracking-widest transition-all border border-red-200 flex items-center justify-center gap-2"
                    >
                      <XCircle className="w-4 h-4" />
                      Kill Render Engine (Emergency Stop)
                    </button>
                  </div>
                )}

                <div className="flex justify-center mb-8">
                  {!isRendering && (
                    <div className={`px-4 py-2 rounded-full text-sm font-bold uppercase tracking-wider flex items-center gap-2 ${
                      renderStatus === 'completed' ? 'bg-green-100 text-green-700' :
                      renderStatus === 'failed' ? 'bg-red-100 text-red-700' :
                      renderStatus === 'cancelled' ? 'bg-neutral-100 text-neutral-700' :
                      'bg-neutral-100 text-neutral-600'
                    }`}>
                      Status: {renderStatus}
                    </div>
                  )}
                </div>

                {project.output_path && !isRendering && (
                  <div className="mb-8">
                    <button
                      onClick={handleDownload}
                      className="inline-flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold transition-colors"
                    >
                      <Download className="w-5 h-5" /> Download Video
                    </button>
                  </div>
                )}
                {!project.output_path && project.status === 'completed' && !isRendering && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                    Video was rendered but the download link is unavailable. Re-render to generate a new link.
                  </div>
                )}

                {(project.scenes?.filter(s => !s.image_path && !s.visuals?.[0]?.rendered_path).length ?? 0) > 0 && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                    ⚠ {project.scenes.filter(s => !s.image_path && !s.visuals?.[0]?.rendered_path).length} scene(s) missing images. Generate assets before rendering for best results.
                  </div>
                )}

                <button
                  onClick={handleRender}
                  disabled={isRendering}
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isRendering ? <Loader2 className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6" />}
                  Render Video
                </button>
              </div>

              {/* YOUTUBE METADATA */}
              {seoMetadata && (
                <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6 space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-neutral-900">YouTube Metadata</h3>
                    <span className="text-xs text-neutral-400 bg-neutral-100 px-2 py-1 rounded-full">AI Generated — copy & paste to YouTube</span>
                  </div>

                  {/* Title */}
                  <div>
                    <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">Title</label>
                    <div className="flex gap-2 items-start">
                      <p className="flex-1 text-sm font-semibold text-neutral-900 bg-neutral-50 p-3 rounded-lg border border-neutral-200">{seoMetadata.title}</p>
                      <button
                        onClick={() => navigator.clipboard.writeText(seoMetadata.title)}
                        className="shrink-0 px-3 py-2 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 transition-colors"
                        title="Copy title"
                      >Copy</button>
                    </div>
                    <p className="text-[10px] text-neutral-400 mt-1">{seoMetadata.title.length}/60 chars</p>
                  </div>

                  {/* Thumbnail text */}
                  <div>
                    <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">Thumbnail Text Overlay</label>
                    <div className="flex gap-2 items-start">
                      <p className="flex-1 text-sm font-black text-white bg-neutral-900 p-3 rounded-lg tracking-tight uppercase">{seoMetadata.thumbnailText}</p>
                      <button
                        onClick={() => navigator.clipboard.writeText(seoMetadata.thumbnailText)}
                        className="shrink-0 px-3 py-2 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 transition-colors"
                        title="Copy thumbnail text"
                      >Copy</button>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">Description</label>
                    <div className="flex gap-2 items-start">
                      <pre className="flex-1 text-xs text-neutral-700 bg-neutral-50 p-3 rounded-lg border border-neutral-200 whitespace-pre-wrap font-sans">{seoMetadata.description}</pre>
                      <button
                        onClick={() => navigator.clipboard.writeText(seoMetadata.description)}
                        className="shrink-0 px-3 py-2 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 transition-colors"
                        title="Copy description"
                      >Copy</button>
                    </div>
                  </div>

                  {/* Tags */}
                  <div>
                    <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2">Tags ({seoMetadata.tags.length})</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {seoMetadata.tags.map((tag, i) => (
                        <span key={i} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-medium rounded-full border border-indigo-100">{tag}</span>
                      ))}
                    </div>
                    <button
                      onClick={() => navigator.clipboard.writeText(seoMetadata.tags.join(', '))}
                      className="text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-200 transition-colors"
                    >Copy all tags</button>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6">
                <h3 className="font-bold text-neutral-900 mb-4">Project Settings</h3>
                <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm">
                  {Object.entries(project.settings || {}).map(([key, value]) => (
                    <div key={key} className="flex flex-col border-b border-neutral-100 pb-2">
                      <span className="text-neutral-400 font-medium capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                      <span className="text-neutral-900 font-bold">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: TIMELINE */}
          {activeTab === 6 && (
            <div className="space-y-6">
              <h2 className="text-xl font-bold text-neutral-900">Project Timeline</h2>
              
              {(!project.scenes || project.scenes.length === 0) ? (
                <div className="bg-white rounded-2xl border-2 border-dashed border-neutral-200 p-12 text-center">
                  <Clock className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-neutral-900 mb-2">Empty Timeline</h3>
                  <p className="text-neutral-500">Generate scenes to see them on the timeline.</p>
                </div>
              ) : (
                <div className="bg-white rounded-3xl shadow-lg border border-neutral-200 p-8">
                   {/* RULER */}
                   <div className="flex mb-2 text-[10px] font-bold text-neutral-400 px-4">
                     {Array.from({ length: 11 }).map((_, i) => (
                       <div key={i} className="flex-1 border-l border-neutral-200 pl-1 h-3">
                         {i * 5}s
                       </div>
                     ))}
                   </div>
                   
                   <div className="bg-white rounded-[32px] shadow-sm border border-neutral-200 p-10">
                    <div className="bg-indigo-50/50 rounded-[32px] border border-indigo-100 p-10">
                      <div className="flex items-center justify-between mb-8">
                         <h3 className="text-sm font-black text-indigo-600 uppercase tracking-[0.2em]">Master Sequence</h3>
                      </div>
                    </div>
                   </div>

                    {/* SCRUBBER CONTAINER */}
                    <div className="relative group/scrubber">
                       {/* THE TIMELINE TRACK */}
                       <div className="relative h-72 bg-neutral-50 rounded-[24px] border border-neutral-100 overflow-x-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-neutral-200 hover:scrollbar-thumb-neutral-300 pb-4">
                          <div className="flex h-full min-w-max p-6 relative">
                             {/* VERTICAL GRID LINES */}
                             <div className="absolute inset-0 flex pointer-events-none px-6">
                                {Array.from({ length: 40 }).map((_, i) => (
                                  <div key={i} className={`h-full border-l flex-1 opacity-20 ${i % 5 === 0 ? 'border-neutral-300' : 'border-neutral-200'}`} />
                                ))}
                             </div>

                             <div className="flex gap-4 relative z-10">
                                {[...project.scenes]
                                  .sort((a, b) => (a.order || 0) - (b.order || 0))
                                  .map((scene, idx) => {
                                    const dur = Number(scene.duration) || 5;
                                    const width = Math.max(160, dur * 40); 
                                    
                                    return (
                                      <div 
                                        key={scene.id || scene.scene_id || `timeline-${idx}`} 
                                        style={{ width: `${width}px` }}
                                        className={`group relative h-full rounded-3xl p-5 flex flex-col justify-between transition-all duration-500 shadow-sm border-2 ${
                                          scene.status === 'completed' 
                                            ? 'bg-indigo-600 border-indigo-400 text-white translate-y-0 scale-100 shadow-indigo-200/50' 
                                            : 'bg-white border-neutral-200 text-neutral-900 hover:border-indigo-300 translate-y-1 hover:translate-y-0'
                                        }`}
                                      >
                                        <div className="flex justify-between items-center mb-3">
                                          <div className="px-2 py-1 bg-white/20 backdrop-blur-sm rounded-lg text-[9px] font-black tracking-widest uppercase">
                                            PT {idx + 1}
                                          </div>
                                          <div className="text-[10px] font-bold opacity-60 flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {dur}s
                                          </div>
                                        </div>
                                        
                                        <div className="flex-1 space-y-3">
                                          {scene.image_path ? (
                                            <div className="aspect-video rounded-xl overflow-hidden shadow-inner bg-neutral-900/10 border border-white/10 group-hover:scale-[1.02] transition-transform duration-500">
                                              <img 
                                                src={scene.image_path} 
                                                alt="" 
                                                className={`w-full h-full object-cover transition-all duration-700 ${scene.status === 'completed' ? 'grayscale-0' : 'grayscale group-hover:grayscale-0'}`} 
                                              />
                                            </div>
                                          ) : (
                                            <div className="aspect-video rounded-xl bg-neutral-100 flex items-center justify-center text-neutral-300">
                                              <Film className="w-6 h-6 opacity-30" />
                                            </div>
                                          )}
                                          <p className={`text-[10px] leading-relaxed line-clamp-2 font-medium ${scene.status === 'completed' ? 'text-indigo-50' : 'text-neutral-500'}`}>
                                            {scene.narration_text}
                                          </p>
                                        </div>

                                        <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
                                           <div className="flex -space-x-2">
                                              <div className="w-6 h-6 rounded-full bg-white/20 border border-white/20 flex items-center justify-center"><User className="w-3 h-3" /></div>
                                              <div className="w-6 h-6 rounded-full bg-white/20 border border-white/20 flex items-center justify-center"><Mic className="w-3 h-3" /></div>
                                           </div>
                                           {scene.status === 'completed' && (
                                              <div className="w-6 h-6 bg-emerald-400 rounded-full flex items-center justify-center animate-in zoom-in fade-in duration-500">
                                                <Check className="w-3.5 h-3.5 text-emerald-900" />
                                              </div>
                                           )}
                                        </div>
                                      </div>
                                    );
                                  })}
                             </div>
                          </div>
                       </div>
                    </div>

                  <div className="mt-8 flex items-center justify-between border-t border-neutral-100 pt-6">
                    <div className="flex gap-8">
                       <div className="flex flex-col">
                         <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">TOTAL DURATION</span>
                         <span className="text-xl font-black text-neutral-900">
                           {(project.scenes || []).reduce((acc, s) => acc + (Number(s.duration) || 5), 0).toFixed(1)}s
                         </span>
                       </div>
                       <div className="flex flex-col">
                         <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">SCENE COUNT</span>
                         <span className="text-xl font-black text-neutral-900">{(project.scenes || []).length}</span>
                       </div>
                    </div>
                    <div className="text-xs text-neutral-400 font-medium bg-neutral-100 px-4 py-2 rounded-full border border-neutral-200">
                      Standard Cinematic Flow: 24fps
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
