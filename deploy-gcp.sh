#!/usr/bin/env bash
set -e

PROJECT_ID="grc-tool-507203"
REGION="us-central1"
SERVICE_NAME="pbc-grc-app"
DOMAIN="grc.pitchblackcyber.com"

echo "=== Deploying PBC-GRCP to Google Cloud Run ==="
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --allow-unauthenticated

echo "=== Configuring Custom Domain Mapping ($DOMAIN) ==="
gcloud beta run domain-mappings create \
    --service="$SERVICE_NAME" \
    --domain="$DOMAIN" \
    --region="$REGION" \
    --project="$PROJECT_ID" || true

echo "=== Deployment Complete ==="
