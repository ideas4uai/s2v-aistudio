/// <reference types="vite/client" />
import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true });

const DEV_USER = {
  uid: 'dev-user',
  email: 'dev@localhost',
  displayName: 'Dev User',
} as unknown as User;

// Dev mode has no real auth to wait for, so it is known before the first render —
// seeding it as the initial state instead of setting it in an effect skips the
// null -> DEV_USER cascade (children are gated on !loading, so nothing rendered
// during that discarded pass anyway).
const IS_DEV = import.meta.env.MODE === 'development';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(IS_DEV ? DEV_USER : null);
  const [loading, setLoading] = useState(!IS_DEV);

  useEffect(() => {
    if (IS_DEV) return;

    // Firebase is the external system this effect exists to subscribe to; setState
    // here runs from its callback, not synchronously during the effect.
    const unsubscribe = onAuthStateChanged(auth, (authUser: User | null) => {
      setUser(authUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
