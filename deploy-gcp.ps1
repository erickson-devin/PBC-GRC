# PBC-GRC Cloud Run Deploy & Custom Domain Setup Script
$ErrorActionPreference = "Stop"

$ProjectId = "grc-tool-507203"
$Region = "us-central1"
$ServiceName = "pbc-grc-app"
$Domain = "grc.pitchblackcyber.com"

Write-Host "=== Deploying PBC-GRCP to Google Cloud Run ($ServiceName) ===" -ForegroundColor Cyan
gcloud run deploy $ServiceName `
    --source . `
    --project=$ProjectId `
    --region=$Region `
    --allow-unauthenticated

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
