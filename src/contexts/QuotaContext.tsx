import React, { createContext, useContext, useState, useEffect } from 'react';

type QuotaContextType = {
  quota: { 
    remainingGenAI: number; 
    totalGenAI: number; 
    hasQuota: boolean;
    resetAt?: Date | string;
    aiImagesLimit?: number;
    aiImagesUsed?: number;
    audioLimit?: number;
    audioUsed?: number;
  };
  loading: boolean;
  isRateLimited: boolean;
  refreshQuota: () => void;
};

const QuotaContext = createContext<QuotaContextType>({ 
  quota: { remainingGenAI: 100, totalGenAI: 100, hasQuota: true },
  loading: false,
  isRateLimited: false,
  refreshQuota: () => {}
});

export function QuotaProvider({ children }: { children: React.ReactNode }) {
  const [quota, setQuota] = useState({ remainingGenAI: 100, totalGenAI: 100, hasQuota: true });
  const [loading, setLoading] = useState(false);

  const refreshQuota = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quota');
      if (res.ok) {
        const data = await res.json();
        setQuota(data);
      }
    } catch (error) {
      console.error('Error fetching quota:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      if (mounted) await refreshQuota();
    };
    init();
    return () => { mounted = false; };
  }, []);

  return (
    <QuotaContext.Provider value={{ quota, loading, isRateLimited: false, refreshQuota }}>
      {children}
    </QuotaContext.Provider>
  );
}

export function useQuota() {
  return useContext(QuotaContext);
}
