import type { LucideIcon } from 'lucide-react';
import { BookOpen, BrainCircuit, ChevronLeft, FileArchive, PanelTop } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router-dom';

interface StudioNavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

// Only pages that exist. Links to unbuilt sections used to land on a
// "Construction" placeholder, which reads as broken rather than as roadmap.
const primaryNavigation: StudioNavItem[] = [
  { label: 'Dashboard', to: '/content-studio', icon: PanelTop },
  { label: 'Content Director', to: '/content-studio/director', icon: BrainCircuit },
  { label: 'Episodes', to: '/content-studio/episodes', icon: FileArchive },
];

const libraryNavigation: StudioNavItem[] = [
  { label: 'Knowledge Base', to: '/content-studio/knowledge', icon: BookOpen },
];

function StudioNav({ items }: { items: StudioNavItem[] }) {
  return (
    <nav className="space-y-1">
      {items.map(({ label, to, icon: Icon }) => (
        <NavLink
          end={to === '/content-studio'}
          key={to}
          to={to}
          className={({ isActive }) => [
            'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
            isActive
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950',
          ].join(' ')}
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function ContentStudioShell() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-7xl gap-6 px-4 py-6 md:px-8">
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-24 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <Link to="/" className="mb-4 flex items-center gap-2 px-2 text-xs font-semibold text-slate-500 hover:text-indigo-600">
            <ChevronLeft className="h-3.5 w-3.5" /> Script2Video workspace
          </Link>
          <div className="mb-5 px-2">
            <p className="text-sm font-bold tracking-tight text-slate-950">AI Content Studio</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Plan what to create before you render it.</p>
          </div>
          <StudioNav items={primaryNavigation} />
          <div className="my-4 border-t border-slate-100" />
          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Library</p>
          <StudioNav items={libraryNavigation} />
        </div>
      </aside>
      <section className="min-w-0 flex-1">
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
          {[...primaryNavigation, ...libraryNavigation].map(({ label, to }) => (
            <NavLink end={to === '/content-studio'} key={to} to={to} className={({ isActive }) => `shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
              {label}
            </NavLink>
          ))}
        </div>
        <Outlet />
      </section>
    </div>
  );
}
