# PBC-GRC Cloud Run Deploy & Custom Domain Setup Script with Cloud SQL & RLS
$ErrorActionPreference = "Stop"

$ProjectId = "grc-tool-507203"
$Region = "us-central1"
$ServiceName = "pbc-grc-app"
$Domain = "grc.pitchblackcyber.com"
$CloudSqlInstance = "grc-tool-507203:us-central1:pbc-grc-postgres-primary"
$DbName = "cmmc_compliance_db"
$DbUser = "postgres"
$GcsBucket = "pbc-grc-evidence-prod"

Write-Host "=== Deploying PBC-GRC Cloud SQL Express Backend to Cloud Run ($ServiceName) ===" -ForegroundColor Cyan
gcloud run deploy $ServiceName `
    --source . `
    --project=$ProjectId `
    --region=$Region `
    --allow-unauthenticated `
    --add-cloudsql-instances=$CloudSqlInstance `
    --set-env-vars="DB_HOST=/cloudsql/$CloudSqlInstance,DB_NAME=$DbName,DB_USER=$DbUser,VITE_GCS_BUCKET_NAME=$GcsBucket,VITE_GCP_PROJECT_ID=$ProjectId"

Write-Host "=== Configuring Custom Domain Mapping ($Domain) ===" -ForegroundColor Cyan
try {
    gcloud beta run domain-mappings create `
        --service=$ServiceName `
        --domain=$Domain `
        --region=$Region `
        --project=$ProjectId
} catch {
    Write-Host "Domain mapping already created or pending DNS records." -ForegroundColor Yellow
}

Write-Host "=== Cloud Run Deployment Completed ===" -ForegroundColor Green
