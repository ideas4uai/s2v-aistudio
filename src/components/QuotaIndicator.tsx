import React, { useState, useEffect } from 'react';
import { useQuota } from '../contexts/QuotaContext';
import { Zap, Clock, AlertTriangle, RefreshCw } from 'lucide-react';

export function QuotaIndicator({ isCollapsed }: { isCollapsed: boolean }) {
  const { quota, loading, isRateLimited, refreshQuota } = useQuota();
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshQuota();
    setRefreshing(false);
  };

  useEffect(() => {
    if (!quota?.resetAt) return;

    const updateTimer = () => {
      const now = new Date();
      const reset = new Date((quota.resetAt || new Date()));
      const diff = reset.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeLeft('Resetting...');
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [quota?.resetAt]);

  if (loading || !quota) return null;

  const aiImagePercent = (((quota.aiImagesLimit || 0) - (quota.aiImagesUsed || 0)) / (quota.aiImagesLimit || 0)) * 100;
  const audioPercent = (((quota.audioLimit || 0) - (quota.audioUsed || 0)) / (quota.audioLimit || 0)) * 100;

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 border-t border-neutral-100">
        <div className={`p-2 rounded-lg ${isRateLimited ? 'bg-amber-100 text-amber-600' : 'bg-indigo-50 text-indigo-600'}`}>
          <Zap size={18} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 mx-2 mb-2 rounded-xl bg-neutral-50 border border-neutral-100 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold text-neutral-500 uppercase tracking-wider">
          <Zap size={14} className="text-indigo-600" />
          Quota Usage
        </div>
        <div className="flex items-center gap-2">
          {isRateLimited && (
            <div className="flex items-center gap-1 text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-100 animate-pulse">
              <AlertTriangle size={10} />
              Limited
            </div>
          )}
          <button 
            onClick={handleRefresh}
            disabled={refreshing}
            className={`p-1 rounded-md hover:bg-neutral-200 text-neutral-400 transition-colors ${refreshing ? 'animate-spin' : ''}`}
            title="Refresh Quota"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="flex justify-between text-[10px] font-medium text-neutral-600 mb-1">
            <span>AI Images</span>
            <span>{(quota.aiImagesLimit || 0) - (quota.aiImagesUsed || 0)} left</span>
          </div>
          <div className="h-1.5 w-full bg-neutral-200 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${aiImagePercent < 10 ? 'bg-red-500' : (aiImagePercent < 30 ? 'bg-amber-500' : 'bg-indigo-600')}`}
              style={{ width: `${Math.max(0, Math.min(aiImagePercent, 100))}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between text-[10px] font-medium text-neutral-600 mb-1">
            <span>Audio Gen</span>
            <span>{(quota.audioLimit || 0) - (quota.audioUsed || 0)} left</span>
          </div>
          <div className="h-1.5 w-full bg-neutral-200 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${audioPercent < 10 ? 'bg-red-500' : (audioPercent < 30 ? 'bg-amber-500' : 'bg-emerald-600')}`}
              style={{ width: `${Math.max(0, Math.min(audioPercent, 100))}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 text-[10px] text-neutral-400 font-medium">
        <Clock size={12} />
        Resets in: <span className="text-neutral-600">{timeLeft}</span>
      </div>
    </div>
  );
}
