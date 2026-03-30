################################
# LOCAL VARIABLES 
################################
locals {
  shortname = "derivatives-marketplace"
  log_group_name = "bedrock-${local.shortname}-${substr(var.account_shortname, 8, 3)}"
  cloudwatch_event_retention = 90
  ecs_task_worker_qty = 1

  alb_sg_marketplace_use1 = ["outb-all", "webu-all", "webs-all"]
  alb_sg_indexer_use1     = ["outb-all", "webu-all", "webs-all", "weba-all"]
  # alb_sg_notifications_use1 removed - using dedicated security groups now
  titanio_net_ecr            = "343351459450.dkr.ecr.us-east-1.amazonaws.com"
  titanio_role_arn           = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"
  s3_cf_website              = "derivatives"
  s3_cf_origin               = "s3derivatives"

  ################################
  # GITHUB ACTIONS CI/CD
  ################################
  # Hardcoded GitHub org/repo (won't change)
  # NOTE: Case-sensitive! Must match GitHub exactly (capital L in Lumerin)
  github_org_repo = "Lumerin-protocol/derivatives-marketplace"

  # Auto-derive branch filter based on environment lifecycle
  # DEV uses a list to allow both dev and cicd/* branches; STG/PRD use single-item lists
  github_branch_filter = var.account_lifecycle == "dev" ? [
    "ref:refs/heads/dev",
    "ref:refs/heads/cicd/*",
    "environment:dev"
    ] : (
    var.account_lifecycle == "stg" ? ["ref:refs/heads/stg", "environment:stg"] : ["ref:refs/heads/main", "environment:main"]
  )

  ################################
  # DOMAIN CONSTRUCTION (from Route53 data lookups)
  ################################
  # Public zone for this env: hashpower.exchange (lmn) or dev/stg.hashpower.exchange
  domain_zone_name = local.hp_dns["exc"].name
}