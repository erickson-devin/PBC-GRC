/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GCP_PROJECT_ID?: string;
  readonly VITE_GCP_REGION?: string;
  readonly VITE_GCS_BUCKET_NAME?: string;
  readonly VITE_GCP_CLOUD_SQL_INSTANCE?: string;
  readonly VITE_GCP_DATABASE_NAME?: string;
  readonly VITE_GCP_IDENTITY_DOMAIN?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_PHOTON_URL?: string;

  // Optional external identity provider (Firebase); unused with AUTH_MODE=local
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_GCP_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
