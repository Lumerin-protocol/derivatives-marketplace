# Derivatives Marketplace Infrastructure

Terraform/Terragrunt infrastructure for deploying the Lumerin Derivatives Marketplace keeper service to AWS.

## Overview

Infrastructure as Code for the derivatives-marketplace repository, co-located with application code and CI/CD pipeline.

**Perps keeper (ECS):** Deprecated as of 2026-Q2. Unified cross-venue liquidation runs from [collateral-margin](https://github.com/Lumerin-protocol/collateral-margin) (`svc-col-mar-keeper-*` on the shared `ecs-derivatives-marketplace-*` cluster). Set `perpskeeper_service.create = false` in bedrock tfvars and apply to remove legacy resources.

## Architecture

- **Source**: GitHub repository (`lumerin-protocol/derivatives-marketplace`)
- **Registry**: GitHub Container Registry (GHCR)
- **IaC**: Terraform/Terragrunt
- **Deployment**: GitHub Actions with AWS OIDC
- **Secrets**: AWS Secrets Manager
- **Compute**: ECS Fargate
- **Networking**: Internal ALB, Route53

## Environments

| Environment | Directory | AWS Account | Network |
|-------------|-----------|-------------|---------|
| Development | `02-dev/` | titanio-dev | Arbitrum Sepolia |
| Staging | `03-stg/` | titanio-stg | Arbitrum Mainnet |
| Production | `04-lmn/` | titanio-lmn | Arbitrum Mainnet |

## Service

### Perps Keeper (ECS Fargate)
Automated liquidation bot monitoring user positions and executing liquidations when margin thresholds breach.

- **Deployment**: ECS Fargate singleton task
- **Monitoring**: Event-driven mini-indexer (no subgraph dependency)
- **Execution**: Polls oracle price and liquidates positions on threshold breach
- **Security**: Private key and RPC URL stored in Secrets Manager
- **Networking**: Internal ALB with health checks
- **Configuration**: Poll interval, dry-run mode, profit margins

## Deployment Flow

```
Code Change → GitHub Push (dev/stg/main)
    ↓
GitHub Actions: Build & Push Docker Image → GHCR
    ↓
GitHub Actions: Tag image (latest-dev/latest-stg/latest)
    ↓
AWS ECS: Rolling deployment (stop old task first)
```

## Quick Start

### Prerequisites

- Terraform >= 1.5
- Terragrunt >= 0.48
- AWS CLI with profiles: `titanio-dev`, `titanio-stg`, `titanio-lmn`

### Deploy Infrastructure

```bash
cd .bedrock/02-dev
terragrunt init
terragrunt plan
terragrunt apply
```

Create `secret.auto.tfvars` in each environment:
```hcl
ethereum_rpc_url   = "https://arb-sepolia.g.alchemy.com/v2/..."
keeper_private_key = "0x..."
```

### Application Deployment

Automated via GitHub Actions on push to `dev`/`stg`/`main` branches. Builds Docker image and updates ECS task definition.

## Infrastructure Components

### ECS Cluster
Shared Fargate cluster with Container Insights and CloudWatch logging.

### Perps Keeper Service
- **ECS Service**: Fargate singleton (stop old task before starting new)
- **Task Definition**: 256 CPU / 512 MB RAM
- **Container**: Node.js 22 keeper from GHCR
- **Internal ALB**: HTTPS listener with health checks (`/healthcheck`)
- **Security Groups**: ALB ingress, ECS egress for blockchain RPC
- **Route53**: Internal DNS record

### Secrets Management
AWS Secrets Manager stores keeper credentials:
```
perps-keeper-secrets-{env}
  └── keeper_private_key, eth_node_address
```

### IAM & Security
- **OIDC Provider**: GitHub Actions authentication
- **Deployment Role**: `github-actions-derivatives-{env}`
- **ECS Task Role**: Secrets Manager access, CloudWatch logs

## Configuration

Key variables in `terraform.tfvars`:

```hcl
# Environment
account_shortname = "titanio-dev"
account_lifecycle = "dev"
default_region    = "us-east-1"

# ECS Cluster
ecs_cluster = {
  create  = true
  protect = false
}

# Perps Keeper Service
perpskeeper_service = {
  create                    = true
  ghcr_repo                 = "ghcr.io/lumerin-protocol/perps-keeper"
  ghcr_imagetag             = "latest-dev"
  svc_name                  = "perps-keeper"
  task_worker_qty           = 1
  cnt_port                  = 3000
  task_cpu                  = 256
  task_ram                  = 512
  eth_price_feed_address    = "0x6F736186d2c93913721e2570c283dff2a08575e9"
  keeper_poll_interval_ms   = 5000
  keeper_resync_interval_ms = 300000
  keeper_dry_run            = false
  keeper_min_profit_margin  = 0
  keeper_health_port        = 3000
}

# Contract Addresses
perps_address           = "0x6b87e9c19e2c8a79e068358afa8b62b087548817"
hashrate_oracle_address = "0x6f736186d2c93913721e2570c283dff2a08575e9"
```

## GitHub Actions

Configure repository secrets:
- `AWS_ROLE_ARN_DEV` / `AWS_ROLE_ARN_STG` / `AWS_ROLE_ARN_LMN`
- `SLACK_WEBHOOK_URL` (optional)

Get role ARN from Terraform:
```bash
terragrunt output github_actions_role_arn
```

## Troubleshooting

### Keeper Not Starting
1. Check CloudWatch Logs: `/ecs/perps-keeper-{env}`
2. Verify secrets in Secrets Manager
3. Check ECS task stopped reason
4. Verify RPC URL and private key

### Deployment Failures
1. Check GitHub Actions logs
2. Check ECS service events
3. Verify GHCR image exists and is accessible
4. Review security group rules

### Health Check Failing
Check ALB target group health and keeper `/healthcheck` endpoint.

## Maintenance

### Update Keeper Configuration
Edit `terraform.tfvars` and apply:
```bash
cd .bedrock/02-dev
terragrunt apply
```

### Update Secrets
```bash
aws secretsmanager update-secret \
  --secret-id perps-keeper-secrets-dev \
  --secret-string '{"keeper_private_key":"0x...","eth_node_address":"https://..."}'
```

### Destroy Environment
```bash
cd 02-dev
terragrunt destroy
```

## Directory Structure

```
.bedrock/
├── .terragrunt/
│   ├── 00_*.tf                    # Variables, providers, data, outputs
│   ├── 01_github_actions_iam.tf   # CI/CD IAM roles
│   ├── 01_secrets_manager.tf      # Secrets Manager
│   ├── 02_service_iam.tf          # ECS task IAM role
│   ├── 03_ecs_cluster.tf          # ECS cluster
│   └── 04_perps_keeper_svc.tf     # Keeper service, ALB, security groups
├── 02-dev/                        # Dev environment (Arbitrum Sepolia)
│   ├── terraform.tfvars
│   ├── secret.auto.tfvars         # gitignored
│   └── terragrunt.hcl
├── 03-stg/                        # Staging environment
├── 04-lmn/                        # Production environment
└── root.hcl
```
