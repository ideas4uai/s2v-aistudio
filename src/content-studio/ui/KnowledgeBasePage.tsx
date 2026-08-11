import { BookOpen, Download, FileUp, Plus, Save, Search, Tag } from 'lucide-react';
import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../utils/api';

type KnowledgeCategory = 'character_bible' | 'production_bible' | 'brand_bible' | 'visual_style' | 'office_guide' | 'episode_history' | 'running_jokes' | 'relationships' | 'lessons_learned' | 'prompt_template' | 'general';
interface KnowledgeDocument { id: string; title: string; content: string; category: KnowledgeCategory; universe?: string; tags: string[]; relatedDocumentIds: string[]; version: number; updatedAt: string; }
const categories: KnowledgeCategory[] = ['general', 'brand_bible', 'character_bible', 'production_bible', 'visual_style', 'office_guide', 'episode_history', 'running_jokes', 'relationships', 'lessons_learned', 'prompt_template'];
const label = (category: string) => category.replace(/_/g, ' ');

export function KnowledgeBasePage() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const [versions, setVersions] = useState<Array<{ id: string; version: number; createdAt: string }>>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(); if (query) params.set('q', query); if (category) params.set('category', category);
      const response = await authenticatedFetch(`/api/content-studio/knowledge?${params}`);
      if (!response.ok) throw new Error('Could not load knowledge documents.');
      setDocuments(await response.json()); setError(null);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Could not load knowledge documents.'); }
    finally { setLoading(false); }
  }, [category, query]);

  useEffect(() => { const timer = window.setTimeout(() => void loadDocuments(), 200); return () => window.clearTimeout(timer); }, [loadDocuments]);

  async function selectDocument(id: string) {
    const response = await authenticatedFetch(`/api/content-studio/knowledge/${id}`);
    if (!response.ok) { setError('Could not load knowledge document.'); return; }
    const data = await response.json(); setSelected(data.document); setVersions(data.versions);
  }

  function newDocument() { setSelected({ id: '', title: '', content: '', category: 'general', tags: [], relatedDocumentIds: [], version: 0, updatedAt: '' }); setVersions([]); }

  async function saveDocument(event: FormEvent) {
    event.preventDefault(); if (!selected) return; setSaving(true); setError(null);
    const body = { title: selected.title, content: selected.content, category: selected.category, universe: selected.universe ?? '', tags: selected.tags, relatedDocumentIds: selected.relatedDocumentIds };
    try {
      const response = await authenticatedFetch(selected.id ? `/api/content-studio/knowledge/${selected.id}` : '/api/content-studio/knowledge', { method: selected.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not save the document.');
      setSelected(await response.json()); await loadDocuments();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Could not save the document.'); }
    finally { setSaving(false); }
  }

  async function exportKnowledge() { const response = await authenticatedFetch('/api/content-studio/knowledge/export'); if (!response.ok) return setError('Could not export knowledge.'); const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'content-studio-knowledge.json'; anchor.click(); URL.revokeObjectURL(url); }
  async function importKnowledge(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; try { const response = await authenticatedFetch('/api/content-studio/knowledge/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() }); if (!response.ok) throw new Error('Import failed.'); await loadDocuments(); } catch { setError('The selected file is not a valid knowledge export.'); } finally { event.target.value = ''; } }

  return <div className="space-y-5"><header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-semibold text-indigo-600">Persistent context</p><h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Knowledge Base</h1><p className="mt-2 text-sm leading-6 text-slate-600">Versioned Markdown that agents can load without relying on individual prompts.</p></div><div className="flex gap-2"><input ref={uploadRef} onChange={importKnowledge} type="file" accept="application/json" className="hidden" /><button onClick={() => uploadRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"><FileUp className="h-4 w-4" />Import</button><button onClick={() => void exportKnowledge()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Export</button><button onClick={newDocument} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-indigo-700"><Plus className="h-4 w-4" />New</button></div></header>{error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}<div className="grid min-h-[500px] gap-5 xl:grid-cols-[0.7fr_1.3fr]"><section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><div className="flex gap-2"><label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search knowledge" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-indigo-500" /></label><select value={category} onChange={(event) => setCategory(event.target.value)} className="max-w-32 rounded-xl border border-slate-200 bg-white px-2 text-sm"> <option value="">All</option>{categories.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></div><div className="mt-3 space-y-1">{loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : documents.length ? documents.map((document) => <button key={document.id} onClick={() => void selectDocument(document.id)} className={`w-full rounded-xl p-3 text-left transition ${selected?.id === document.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}><p className="truncate text-sm font-bold text-slate-900">{document.title}</p><p className="mt-1 text-xs capitalize text-slate-500">{label(document.category)} · v{document.version}{document.universe && document.universe !== 'default' ? ` · ${document.universe}` : ''}</p></button>) : <div className="p-5 text-center text-sm text-slate-500"><BookOpen className="mx-auto mb-2 h-5 w-5" />No knowledge documents yet.</div>}</div></section><section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">{selected ? <form onSubmit={saveDocument}><div className="flex items-center justify-between gap-3"><input value={selected.title} required onChange={(event) => setSelected({ ...selected, title: event.target.value })} placeholder="Document title" className="min-w-0 flex-1 border-0 text-xl font-bold outline-none placeholder:text-slate-400" /><select value={selected.category} onChange={(event) => setSelected({ ...selected, category: event.target.value as KnowledgeCategory })} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs capitalize">{categories.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></div><div className="mt-4 flex items-center gap-2 text-xs text-slate-500"><span className="font-semibold uppercase tracking-wide">Universe</span><input value={selected.universe ?? ''} onChange={(event) => setSelected({ ...selected, universe: event.target.value })} placeholder="default" className="w-40 border-0 outline-none" /><Tag className="h-3.5 w-3.5" /><input value={selected.tags.join(', ')} onChange={(event) => setSelected({ ...selected, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="tags, comma-separated" className="min-w-0 flex-1 border-0 outline-none" /></div><textarea value={selected.content} required onChange={(event) => setSelected({ ...selected, content: event.target.value })} placeholder="Write in Markdown…" className="mt-5 min-h-72 w-full resize-y rounded-xl border border-slate-200 p-3 font-mono text-sm leading-6 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /><div className="mt-4 flex items-center justify-between"><p className="text-xs text-slate-500">{selected.id ? `Version ${selected.version} · ${versions.length} saved revision${versions.length === 1 ? '' : 's'}` : 'New document'}</p><button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-60"><Save className="h-4 w-4" />{saving ? 'Saving...' : 'Save'}</button></div></form> : <div className="flex h-full flex-col items-center justify-center text-center"><BookOpen className="h-8 w-8 text-indigo-500" /><h2 className="mt-4 font-bold text-slate-900">Select or create a document</h2><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Capture the context that makes every future content decision consistent.</p></div>}</section></div></div>;
}
