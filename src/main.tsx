import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { runBrowserStorageScrub } from './services/browserStorageScrub';
import { scrubLegacySessionToken } from './services/legacySessionScrub';

// The session JWT earlier versions kept in browser storage is no longer used: drop it (the session is an HttpOnly cookie now).
try {
  if (typeof window !== 'undefined' && window.localStorage) scrubLegacySessionToken(window.localStorage);
} catch {
  // storage unavailable: nothing to scrub
}

// Remove cached implementation notes (possible CUI) of server-backed tenants before anything can read or save them.
// The assessment part runs synchronously inside this call; only the ledger redaction finishes asynchronously.
if (typeof window !== 'undefined' && window.localStorage) {
  void runBrowserStorageScrub(window.localStorage).catch(() => undefined);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
