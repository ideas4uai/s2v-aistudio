import React from 'react';

// Simplified guard. If there was custom key logic, it could go here, otherwise just pass children.
export function ApiKeyGuard({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
