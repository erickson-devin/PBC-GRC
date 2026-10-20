import React from 'react';

// The build is identified by its git commit, injected by vite.config.ts (`define`) from BUILD_COMMIT at build time
// ('dev' for a local build). The same commit is reported by GET /api/v1/health as `buildCommit`.
export const BuildStamp: React.FC<{ className?: string }> = ({ className = '' }) => (
  <p className={`text-xs text-slate-500 font-mono ${className}`} title={`Build ${__BUILD_COMMIT__}`}>
    Build {__BUILD_COMMIT__.slice(0, 12)} · {__BUILD_DATE__.slice(0, 10)}
  </p>
);
