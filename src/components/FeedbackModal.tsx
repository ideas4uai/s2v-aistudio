import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown, X, Send } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
}

export function FeedbackModal({ isOpen, onClose, projectId }: FeedbackModalProps) {
  const [useful, setUseful] = useState<boolean | null>(null);
  const [improvement, setImprovement] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (useful === null) return;
    
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          useful,
          improvement: improvement.trim() || undefined,
        }),
      });

      if (response.ok) {
        setSubmitted(true);
        setTimeout(() => {
          onClose();
          // Reset state after closing
          setTimeout(() => {
            setUseful(null);
            setImprovement('');
            setSubmitted(false);
          }, 300);
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to submit feedback:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
          >
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-neutral-900">Quick Feedback</h3>
                <button 
                  onClick={onClose}
                  className="p-1 hover:bg-neutral-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-neutral-500" />
                </button>
              </div>

              {!submitted ? (
                <div className="space-y-6">
                  <div>
                    <p className="text-neutral-700 font-medium mb-4">Was this useful?</p>
                    <div className="flex gap-4">
                      <button
                        onClick={() => setUseful(true)}
                        className={`flex-1 flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 transition-all ${
                          useful === true 
                            ? 'bg-green-50 border-green-500 text-green-700 shadow-sm scale-[1.02]' 
                            : 'border-neutral-200 text-neutral-400 hover:border-neutral-300 hover:bg-neutral-50'
                        }`}
                      >
                        <ThumbsUp className={`w-8 h-8 ${useful === true ? 'fill-green-500 text-green-500' : ''}`} />
                        <span className="text-xs font-bold uppercase tracking-wider">Useful</span>
                      </button>
                      <button
                        onClick={() => setUseful(false)}
                        className={`flex-1 flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 transition-all ${
                          useful === false 
                            ? 'bg-red-50 border-red-500 text-red-700 shadow-sm scale-[1.02]' 
                            : 'border-neutral-200 text-neutral-400 hover:border-neutral-300 hover:bg-neutral-50'
                        }`}
                      >
                        <ThumbsDown className={`w-8 h-8 ${useful === false ? 'fill-red-500 text-red-500' : ''}`} />
                        <span className="text-xs font-bold uppercase tracking-wider">Not Useful</span>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-neutral-700 font-medium mb-2">
                      What should improve? <span className="text-neutral-400 font-normal">(Optional)</span>
                    </label>
                    <textarea
                      value={improvement}
                      onChange={(e) => setImprovement(e.target.value)}
                      placeholder="Tell us how we can make it better..."
                      className="w-full h-24 p-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none transition-all placeholder:text-neutral-400"
                    />
                  </div>

                  <button
                    onClick={handleSubmit}
                    disabled={useful === null || isSubmitting}
                    className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
                      useful === null || isSubmitting
                        ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
                    }`}
                  >
                    {isSubmitting ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        Submit Feedback
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="py-8 text-center"
                >
                  <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                    <ThumbsUp className="w-8 h-8 fill-green-600" />
                  </div>
                  <h4 className="text-lg font-bold text-neutral-900 mb-2">Thank you!</h4>
                  <p className="text-neutral-600">Your feedback helps us improve.</p>
                </motion.div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
