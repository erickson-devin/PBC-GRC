/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GCP_PROJECT_ID?: string;
  readonly VITE_GCP_REGION?: string;
  readonly VITE_GCS_BUCKET_NAME?: string;
  readonly VITE_GCP_CLOUD_SQL_INSTANCE?: string;
  readonly VITE_GCP_DATABASE_NAME?: string;
  readonly VITE_GCP_IDENTITY_DOMAIN?: string;
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
