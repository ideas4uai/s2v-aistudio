import React, { useState } from 'react';
import { Upload, Mic, Loader2, CheckCircle2 } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

export function VoiceCloner({ onVoiceCloned }: { onVoiceCloned: (voiceId: string, name: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloned, setCloned] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const handleClone = async () => {
    if (files.length === 0) return;
    setCloning(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('name', name || 'Custom Voice');
      files.forEach(f => formData.append('files', f));

      const res = await authenticatedFetch('/api/voices/clone', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to clone voice');
      }

      const data = await res.json();
      setCloned(true);
      onVoiceCloned(data.voiceId, data.name);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCloning(false);
    }
  };

  if (cloned) {
    return (
      <div className="bg-green-50 text-green-800 p-4 rounded-xl border border-green-200 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 text-green-600" />
        <span className="font-medium">Voice "{name || 'Custom Voice'}" successfully cloned!</span>
      </div>
    );
  }

  return (
    <div className="bg-neutral-50 p-4 md:p-6 rounded-xl border border-neutral-200 space-y-4">
      <div className="flex items-center gap-2 text-indigo-700 font-bold mb-2">
        <Mic className="w-5 h-5" />
        <h3>Clone Your Own Voice (ElevenLabs)</h3>
      </div>
      <p className="text-sm text-neutral-600">
        Upload 1-3 short audio samples of a voice speaking clearly to generate a custom AI voice clone.
      </p>
      
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">Voice Name</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
            placeholder="e.g. My Podcast Voice"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
        
        <div>
           <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">Upload Audio Samples (.mp3, .wav)</label>
           <div className="flex items-center gap-3">
             <label className="flex-1 border-2 border-dashed border-neutral-300 hover:border-indigo-500 hover:bg-white rounded-lg p-3 text-center cursor-pointer transition-colors">
               <span className="text-sm text-neutral-500 flex items-center justify-center gap-2">
                  <Upload className="w-4 h-4" /> 
                  {files.length > 0 ? `${files.length} file(s) selected` : 'Click to Browse'}
               </span>
               <input type="file" multiple accept="audio/*" className="hidden" onChange={handleFileChange} />
             </label>
           </div>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

        <button
          type="button"
          disabled={files.length === 0 || cloning}
          onClick={handleClone}
          className="w-full bg-neutral-900 text-white font-bold py-2 rounded-lg disabled:opacity-50 flex justify-center items-center gap-2 mt-2 hover:bg-neutral-800 transition-colors"
        >
          {cloning ? <><Loader2 className="w-4 h-4 animate-spin" /> Cloning...</> : 'Clone & Apply Voice'}
        </button>
      </div>
    </div>
  );
}
