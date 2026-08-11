import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { signInWithGoogle, logout } from '../lib/firebase';
import { LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

export function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col font-sans">
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-black text-xl leading-none">S</span>
            </div>
            <span className="font-bold text-xl tracking-tight text-neutral-900 hidden sm:block">Script2Video</span>
          </Link>
          <Link to="/content-studio" className="ml-4 hidden rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-indigo-600 md:block">
            AI Content Studio
          </Link>
          <Link to="/voice-studio" className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-indigo-600 md:block">
            Voice Studio
          </Link>

          <nav className="ml-auto flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-neutral-100 px-3 py-1.5 rounded-full border border-neutral-200">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt={user.displayName || ''} className="w-5 h-5 rounded-full" />
                  ) : (
                    <UserIcon className="w-4 h-4 text-neutral-500" />
                  )}
                  <span className="text-sm font-medium text-neutral-700 hidden md:block">
                    {user.displayName || user.email}
                  </span>
                </div>
                <button
                  onClick={() => logout()}
                  className="p-2 text-neutral-400 hover:text-red-500 transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => signInWithGoogle()}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold transition-all shadow-sm active:scale-95"
              >
                <LogIn className="w-4 h-4" />
                <span>Sign In</span>
              </button>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        {children}
      </main>
      <footer className="bg-white border-t border-neutral-200 py-8">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-neutral-400 text-sm">© 2026 Script2Video AI. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
