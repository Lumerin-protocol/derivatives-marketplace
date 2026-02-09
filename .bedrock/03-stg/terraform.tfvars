#Create Switches for Lumerin Marketplace and Indexer / proxy-router-ui  
create_core = false

ecs_cluster = {
  create  = false
  protect = false
}

# Configure Market Maker Lambda
perpskeeper_service = {
  create                      = false
  ghcr_repo                   = "ghcr.io/lumerin-protocol/perps-keeper"
  ghcr_imagetag               = "latest-stg"
  svc_name                    = "perps-keeper"
  task_worker_qty             = 1
  cnt_port                    = 3000
  cnt_name                    = "perps-keeper"
  task_cpu                    = 256
  task_ram                    = 512


}

########################################
# Shared Contract Addresses
########################################
# Note: ethereum_rpc_url is defined in secret.auto.tfvars (contains API key)
# Contract addresses for the environment
# DEV uses Arbitrum Sepolia testnet, STG/LMN use Arbitrum mainnet
clone_factory_address   = "0xb5838586b43b50f9a739d1256a067859fe5b3234"
hashrate_oracle_address = "0x2c1db79d2f3df568275c940dac81ad251871faf4"
perps_address           = "tbd"
multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"

########################################
# Monitoring Configuration
########################################
# monitoring = {
#   create                    = true
#   create_alarms             = true
#   create_dashboards         = true
#   create_metric_filters     = true
#   create_synthetics_canary  = true  # Canary only in production
#   notifications_enabled     = true  # Disabled to reduce noise in dev
#   dev_alerts_topic_name     = "titanio-dev-dev-alerts"
#   devops_alerts_topic_name  = "titanio-dev-dev-alerts"
#   dashboard_period          = 300
# }

# DEV environment
# monitoring_schedule = {
#   synthetics_canary_rate_minutes = 60  # If canary enabled, run every 60 min
#   unhealthy_alarm_period_minutes = 60  # How long to tolerate "bad" before alarm triggers
# }

# DEV environment - relaxed thresholds
# alarm_thresholds = {
#   ecs_cpu_threshold           = 90
#   ecs_memory_threshold        = 90
#   ecs_min_running_tasks       = 1
#   lambda_error_threshold      = 5
#   lambda_duration_threshold   = 240000  # 80% of 300s timeout
#   lambda_throttle_threshold   = 10
#   alb_5xx_threshold           = 20
#   alb_unhealthy_threshold     = 1
#   alb_latency_threshold       = 15
#   rds_cpu_threshold           = 90
#   rds_storage_threshold       = 5
#   rds_connections_threshold   = 90
#   cloudfront_5xx_threshold    = 5
#   cloudfront_4xx_threshold    = 10
# }

########################################
# Account metadata
########################################
provider_profile  = "titanio-stg"  # Local account profile ... should match account_shortname..kept separate for future ci/cd
account_shortname = "titanio-stg"  # shortname account code 7 digit + 3 digit eg: titanio-mst, titanio-inf, or rhodium-prd
account_number    = "464450398935" # 12 digit account number 
account_lifecycle = "stg"          # [sbx, dev, stg, prd] -used for NACL and other reference
default_region    = "us-east-1"
region_shortname  = "use1"

########################################
# Environment Specific Variables
#######################################
vpc_index            = 1
devops_keypair       = "bedrock-titanio-stg-use1"
titanio_net_edge_vpn = "172.18.16.0/20"
protect_environment  = false
ecs_task_role_arn    = "arn:aws:iam::464450398935:role/ecsTaskExecutionRole" # "arn:aws:iam::330280307271:role/services/bedrock-cicd-lmntkndstui" #

# Default tag values common across all resources in this account.
# Values can be overridden when configuring a resource or module.
default_tags = {
  ServiceOffering = "Cloud Foundation"
  Department      = "DevOps"
  Environment     = "stg"
  Owner           = "aws-titanio-stg@titan.io" #AWS Account Email Address 092029861612 | aws-sandbox@titan.io | OrganizationAccountAccessRole 
  Scope           = "Global"
  CostCenter      = null
  Compliance      = null
  Classification  = null
  Repository      = "https://github.com/Lumerin-protocol/derivatives-marketplace.git//bedrock/03-stg"
  ManagedBy       = "Terraform"
}

# Default Tags for Cloud Foundation resources
foundation_tags = {
  Name          = null
  Capability    = null
  Application   = "Lumerin Derivatives Marketplace - STG"
  LifecycleDate = null
}