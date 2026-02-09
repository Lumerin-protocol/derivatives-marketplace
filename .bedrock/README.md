# Futures Marketplace Infrastructure

Terraform/Terragrunt infrastructure for deploying Lumerin Futures Marketplace services to AWS across multiple environments.

## Overview

This `.bedrock` directory contains the infrastructure code for the Lumerin Futures Marketplace platform. The infrastructure is co-located with the application code in the [futures-marketplace](https://github.com/lumerin-protocol/futures-marketplace) repository.

This provides:
- Infrastructure as Code alongside application code and CI/CD pipeline in a single repository
- Visibility into infrastructure configuration for developers
- Slack notifications when infrastructure changes (see `.github/workflows/infra-update.yml`)

## Architecture

The deployment architecture consists of:

- **Source Code & Infrastructure**: GitHub repository (`lumerin-protocol/futures-marketplace`)
- **Container Registry**: GitHub Container Registry (GHCR)
- **Infrastructure**: Terraform/Terragrunt (this `.bedrock/` directory)
- **Deployment**: GitHub Actions with AWS OIDC authentication
- **Secrets**: AWS Secrets Manager
- **Compute**: AWS ECS Fargate, AWS Lambda
- **Database**: AWS RDS PostgreSQL
- **CDN**: AWS CloudFront with WAF integration
- **Networking**: Application Load Balancer (ALB), Route53 DNS
- **Monitoring**: CloudWatch Alarms, Dashboards, Metric Filters, Synthetics Canary

## Environments

| Environment | Directory | AWS Account | Purpose |
|-------------|-----------|-------------|---------|
| Development | `02-dev/` | titanio-dev | Development testing |
| Staging | `03-stg/` | titanio-stg | Pre-production validation |
| Production | `04-lmn/` | titanio-lmn | Production deployment |

## Services

The Futures Marketplace consists of four main services:

### 1. Futures UI (Static Website)
- React-based trading interface
- Hosted on S3 with CloudFront CDN
- SPA routing with custom error pages

### 2. Market Maker Service (ECS Fargate)
- Automated trading bot for liquidity provision
- Runs as a singleton task (only one instance active)
- Connects to blockchain via ETH node
- Uses subgraph for market data

### 3. Notifications Service (ECS Fargate + RDS)
- Telegram bot for user notifications
- RDS PostgreSQL database for state management
- Internal ALB for service-to-service communication
- Singleton deployment (Telegram bot requirement)

### 4. Margin Call Lambda
- Scheduled Lambda function for position monitoring
- Runs on configurable interval (default: 15 minutes)
- Daily execution with `executeMarginCall` flag
- Triggers notifications when margin thresholds exceeded

## Deployment Flow

### UI Deployment
```
Code Change → GitHub Push (dev/stg/main)
    ↓
GitHub Actions: Build React Application
    ↓
GitHub Actions: Deploy to S3
    ↓
GitHub Actions: Invalidate CloudFront Cache
    ↓
GitHub Actions: Verify Deployment
```

### Service Deployment
```
Code Change → GitHub Push (dev/stg/main)
    ↓
GitHub Actions: Build & Push Container → GHCR
    ↓
GitHub Actions: Update ECS Task Definition
    ↓
AWS ECS: Rolling Deployment with Circuit Breaker
```

## Quick Start

### Prerequisites

- Terraform >= 1.5
- Terragrunt >= 0.48
- AWS CLI configured with appropriate profiles
- Access to AWS accounts (dev/stg/lmn)

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/lumerin-protocol/futures-marketplace.git
   cd futures-marketplace/.bedrock
   ```

2. **Configure AWS profiles**
   Ensure you have AWS profiles configured for:
   - `titanio-dev`
   - `titanio-stg` 
   - `titanio-lmn` (production)

3. **Initialize secrets**
   Create `secret.auto.tfvars` in each environment directory with sensitive values:
   ```hcl
   ethereum_rpc_url         = "https://arb-sepolia.g.alchemy.com/v2/..."
   market_maker_private_key = "0x..."
   market_maker_eth_node_url = "https://..."
   telegram_bot_token       = "123456:ABC-..."
   ```

4. **Deploy infrastructure**
   ```bash
   cd 02-dev
   terragrunt init
   terragrunt plan
   terragrunt apply
   ```

### Deploying Application Updates

Application deployments are **automated** via GitHub Actions:

1. **Development**: Push to `dev` branch
2. **Staging**: Push to `stg` branch
3. **Production**: Push to `main` branch

GitHub Actions will automatically:
- Build and test the application
- Create versioned Docker images (for services)
- Deploy to appropriate AWS resources
- Validate deployment success

### Manual Infrastructure Updates

To update infrastructure (not application code):

```bash
cd .bedrock/02-dev  # or 03-stg, 04-lmn
terragrunt plan
terragrunt apply
```

## Infrastructure Components

### ECS Cluster

Shared Fargate cluster for all services:
- Container Insights enabled for enhanced monitoring
- CloudWatch Log Group for cluster-level logging
- KMS encryption for execute command

### Futures UI (CloudFront + S3)

- **S3 Bucket**: Versioned storage with CloudFront OAC
- **CloudFront Distribution**: Global CDN with:
  - HTTP/2 and HTTP/3 support
  - WAF integration
  - TLS 1.2 minimum
  - SPA routing (400/403 → index.html)
- **Route53 DNS Records**:
  - `futures.{env}.lumerin.io` (website)
  - `s3futures.{env}.lumerin.io` (origin alias)

### Market Maker Service

- **ECS Service**: Fargate task with singleton deployment
- **Security Group**: HTTPS/HTTP egress for API calls
- **Environment Variables**: Subgraph URLs, trading parameters
- **Secrets**: Private key and ETH node URL from Secrets Manager

### Notifications Service

- **ECS Service**: Fargate task with singleton deployment
- **RDS PostgreSQL**: Managed database (PostgreSQL 17)
- **Internal ALB**: HTTPS listener for service-to-service calls
- **Security Groups**: ALB, ECS, and RDS security groups with proper rules
- **DNS**: `notifyint.{env}.lumerin.io` (internal)

### Margin Call Lambda

- **Lambda Function**: Node.js 22.x runtime
- **VPC Configuration**: Runs in private subnets for ALB access
- **EventBridge Rules**: 
  - Interval schedule (default: 15 minutes)
  - Daily schedule with `executeMarginCall` flag
- **IAM Role**: Secrets access, VPC execution, basic Lambda execution

### Secrets Management

Three secrets stored in AWS Secrets Manager:

```
futures-marketplace-secrets-v3-{env}
  └── deployment: { s3_bucket, cloudfront_distribution_id, marketplace_url, ... }

market-maker-secrets-v3-{env}
  └── private_key, eth_node_url

notifications-secrets-v3-{env}
  └── telegram_bot_token
```

### IAM & Security

- **OIDC Provider**: Enables GitHub Actions to authenticate without long-lived credentials
- **Deployment Role**: `github-actions-futures-v3-{env}` assumed by GitHub Actions
- **Service IAM Role**: Shared role for ECS tasks with Secrets Manager access

### Monitoring

Comprehensive monitoring with 17+ component alarms organized by service:

#### Futures UI Alarms (3)
- `futures-ui-5xx-errors`: CloudFront 5xx error rate
- `futures-ui-4xx-errors`: CloudFront 4xx error rate
- `futures-ui-unreachable`: Route53 health check failing

#### Market Maker Alarms (3)
- `market-maker-cpu-high`: CPU utilization percentage
- `market-maker-memory-high`: Memory utilization percentage
- `market-maker-running-tasks`: No tasks running

#### Notifications ECS Alarms (3)
- `notifications-cpu-high`: CPU utilization percentage
- `notifications-memory-high`: Memory utilization percentage
- `notifications-running-tasks`: No tasks running

#### Notifications RDS Alarms (3)
- `notifications-rds-cpu`: Database CPU high
- `notifications-rds-storage`: Free storage low
- `notifications-rds-connections`: Connection count high

#### Notifications ALB Alarms (2)
- `notifications-alb-5xx`: ALB 5xx errors
- `notifications-alb-unhealthy`: Unhealthy host count

#### Margin Call Lambda Alarms (3)
- `margin-call-errors`: Lambda invocation errors
- `margin-call-duration`: Execution duration high
- `margin-call-throttles`: Lambda throttling

#### Composite Alarms
- Aggregated health status per service
- Only composite alarms send SNS notifications
- Prevents double-alerting from component alarms

#### CloudWatch Synthetics Canary
- Browser-based UI monitoring (production)
- Selenium-based page verification
- Screenshots captured for debugging

#### CloudWatch Dashboards
- Service overview with alarm status
- ECS metrics (CPU, Memory, Task Count)
- Lambda metrics (Invocations, Errors, Duration)
- RDS metrics (CPU, Storage, Connections)
- ALB metrics (Requests, Errors, Latency)
- CloudFront metrics (Requests, Error Rates, Cache Hit Rate)

## Configuration

### Main Variables

Key variables in `terraform.tfvars`:

```hcl
# Environment
account_shortname = "titanio-dev"
account_lifecycle = "dev"
default_region    = "us-east-1"

# Feature Toggles
create_core = true  # UI and shared resources

ecs_cluster = {
  create  = true
  protect = false
}

# Market Maker
market_maker = {
  create           = true
  mm_imagetag      = "auto"  # or "v0.1.0-dev" to pin
  mm_ghcr_repo     = "ghcr.io/lumerin-protocol/market-maker"
  task_cpu         = 256
  task_ram         = 512
  task_worker_qty  = 1
  float_amount     = 300000000
  spread_amount    = 10000
  grid_levels      = 5
  loop_interval_ms = 15000
  # ... additional config
}

# Margin Call Lambda
margin_call_lambda = {
  create                             = true
  job_interval                       = "15"
  timeout                            = 300
  memory_size                        = 512
  margin_utilization_warning_percent = "80"
  daily_schedule_hour                = "0"
  daily_schedule_minute              = "0"
}

# Notifications Service
notifications_service = {
  create                     = true
  ntf_imagetag               = "dev-latest"
  ntf_ghcr_repo              = "ghcr.io/lumerin-protocol/futures-notifications"
  task_cpu                   = 256
  task_ram                   = 512
  db_instance_class          = "db.t3.micro"
  db_allocated_storage       = 20
  db_backup_retention_period = 7
}

# Monitoring
monitoring = {
  create                   = true
  create_alarms            = true
  create_dashboards        = true
  create_metric_filters    = true
  create_synthetics_canary = false  # true for production
  notifications_enabled    = false  # true to send SNS alerts
  dev_alerts_topic_name    = "titanio-dev-dev-alerts"
  devops_alerts_topic_name = "titanio-dev-dev-alerts"
  dashboard_period         = 300
}

# Contract Addresses
futures_address         = "0x..."
hashrate_oracle_address = "0x..."
multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"
```

**Image Tag Modes**:
- **Auto mode** (recommended): Set `mm_imagetag = "auto"` and Terraform will query GitHub for the latest tag
- **Pinned mode**: Set `mm_imagetag = "v0.1.0-dev"` to pin to a specific version

## GitHub Actions Setup

### Required Secrets

Configure these in the futures-marketplace GitHub repository settings:

**Development Environment:**
- `AWS_ROLE_ARN_DEV` - IAM role ARN (output from Terraform)

**Staging Environment:**
- `AWS_ROLE_ARN_STG` - IAM role ARN (output from Terraform)

**Production Environment:**
- `AWS_ROLE_ARN_LMN` - IAM role ARN (output from Terraform)

**Shared:**
- `SLACK_WEBHOOK_URL` - For deployment notifications

### Environment Variables

Each GitHub Environment should have application-specific variables configured for the UI build.

### Terraform Outputs

After applying Terraform, get the role ARN:

```bash
terragrunt output github_actions_role_arn
```

## Versioning

The project uses semantic versioning:

- **Production (main)**: `v1.0.0`
- **Staging (stg)**: `v0.9.5-stg`
- **Development (dev)**: `v0.9.5-dev`

## Troubleshooting

### Deployment Fails

1. Check GitHub Actions logs in futures-marketplace repository
2. Verify ECS service events: `aws ecs describe-services --cluster <cluster> --services <service>`
3. Check CloudWatch Logs for container errors
4. Verify secrets are correctly set in Secrets Manager

### Service Not Starting

1. Check ECS task stopped reason in AWS Console
2. Review CloudWatch Logs for application errors
3. Verify security group rules allow required traffic
4. Check IAM role permissions for Secrets Manager access

### Database Connection Issues

1. Verify RDS security group allows traffic from ECS tasks
2. Check RDS instance status
3. Review connection string in task definition
4. Verify master user secret is accessible

### Lambda Failures

1. Check CloudWatch Logs for function errors
2. Verify VPC configuration allows outbound traffic
3. Review Secrets Manager access
4. Check EventBridge rule is enabled

### Terraform State Locked

```bash
terragrunt force-unlock <lock-id>
```

## Maintenance

### Scaling ECS Services

Update `task_worker_qty` in `terraform.tfvars`:

```hcl
market_maker = {
  task_worker_qty = 2  # Scale to 2 tasks (not recommended for singleton services)
}
```

Note: Market Maker and Notifications services are designed as singletons. Scaling requires application changes.

### RDS Maintenance

RDS maintenance windows are configurable:

```hcl
notifications_service = {
  db_backup_window      = "03:00-04:00"
  db_maintenance_window = "sun:04:00-sun:05:00"
}
```

### Updating Secrets

1. Update value in AWS Secrets Manager console, or
2. Update `secret.auto.tfvars` and run `terragrunt apply`

### Destroying Environment

**⚠️ CAUTION: This will destroy all resources including RDS data!**

```bash
cd 02-dev  # Choose appropriate environment
terragrunt destroy
```

## Directory Structure

```
.bedrock/
├── .terragrunt/                       # Terraform modules
│   ├── 00_*.tf                        # Variables, providers, data sources, outputs
│   ├── 01_github_actions_iam.tf       # IAM roles and policies for CI/CD
│   ├── 01_github_market_maker_lookup.tf # Auto image tag lookup
│   ├── 01_secrets_manager.tf          # AWS Secrets Manager secrets
│   ├── 02_service_iam.tf              # Shared service IAM role
│   ├── 03_ecs_cluster.tf              # ECS Cluster with Container Insights
│   ├── 04_futures_ui.tf               # S3/CloudFront static website
│   ├── 06_notifications_service.tf    # Notifications ECS + RDS + ALB
│   ├── 07_margin_call_lambda.tf       # Margin Call Lambda function
│   ├── 10_market_maker_svc.tf         # Market Maker ECS service
│   ├── 70_monitoring_common.tf        # Monitoring locals, Route53 health check
│   ├── 71_metric_filters.tf           # CloudWatch metric filters
│   ├── 72_synthetics_canary.tf        # CloudWatch Synthetics Canary
│   ├── 80_alarms.tf                   # Component CloudWatch alarms (17+)
│   ├── 81_composite_alarms.tf         # Composite CloudWatch alarms
│   ├── 89_dashboards.tf               # CloudWatch dashboards
│   └── manage/                        # Maintenance page templates
├── 02-dev/                            # Development environment
│   ├── terraform.tfvars               # Environment config
│   ├── secret.auto.tfvars             # Sensitive values (gitignored)
│   └── terragrunt.hcl                 # Terragrunt config
├── 03-stg/                            # Staging environment
├── 04-lmn/                            # Production environment
├── scripts/                           # Utility scripts
│   └── analyze_market_maker_fees.py   # Fee analysis tool
├── root.hcl                           # Terragrunt root config
└── README.md                          # This documentation
```

## Environment URLs

| Environment | Futures UI | Notifications (Internal) |
|-------------|------------|--------------------------|
| DEV | `https://futures.dev.lumerin.io` | `https://notifyint.dev.lumerin.io` |
| STG | `https://futures.stg.lumerin.io` | `https://notifyint.stg.lumerin.io` |
| PRD | `https://futures.lumerin.io` | `https://notifyint.lumerin.io` |

## Support

For issues related to:
- **Infrastructure or Application Code**: Create issue in [futures-marketplace](https://github.com/lumerin-protocol/futures-marketplace)
- **Deployment Issues**: Check GitHub Actions logs and ECS service events

## Contributing

1. Create feature branch from `dev`
2. Make changes (application code and/or infrastructure)
3. Test in development environment
4. Submit pull request
5. Deploy to staging for validation
6. Deploy to production after approval

## License

See LICENSE file in the repository root.
