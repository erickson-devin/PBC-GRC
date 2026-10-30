import dotenv from 'dotenv';

// npm run dev entry (#160): .env and the shell win; an unset NODE_ENV becomes development. Installations start server/index.ts.
// A dynamic import: static imports are hoisted above the assignment.
dotenv.config();
if (!process.env.NODE_ENV?.trim()) process.env.NODE_ENV = 'development';
import('./index').catch((err: unknown) => {
  console.error('[FATAL] Server cannot start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
