#!/usr/bin/env bash
set -e

PROJECT_ID="grc-tool-507203"
REGION="us-central1"
SERVICE_NAME="pbc-grc-app"
DOMAIN="grc.pitchblackcyber.com"
CLOUD_SQL_INSTANCE="grc-tool-507203:us-central1:pbc-grc-postgres-primary"
DB_NAME="cmmc_compliance_db"
DB_USER="postgres"
GCS_BUCKET="pbc-grc-evidence-prod"

echo "=== Deploying PBC-GRC Cloud SQL Express Backend to Cloud Run ==="
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --allow-unauthenticated \
    --add-cloudsql-instances="$CLOUD_SQL_INSTANCE" \
    --set-env-vars="DB_HOST=/cloudsql/${CLOUD_SQL_INSTANCE},DB_NAME=${DB_NAME},DB_USER=${DB_USER},VITE_GCS_BUCKET_NAME=${GCS_BUCKET},VITE_GCP_PROJECT_ID=${PROJECT_ID}"

echo "=== Configuring Custom Domain Mapping ($DOMAIN) ==="
gcloud beta run domain-mappings create \
    --service="$SERVICE_NAME" \
    --domain="$DOMAIN" \
    --region="$REGION" \
    --project="$PROJECT_ID" || true

echo "=== Deployment Complete ==="
