
################################################################################
# OUTPUTS - # Usage: terragrunt output github_actions_role_arn
################################################################################
output "github_actions_role_arn" {
  description = "ARN of the IAM role for GitHub Actions (used by all services)"
  value       = (var.create_core) ? aws_iam_role.github_actions_derivatives[0].arn : null
}
output "github_actions_role_name" {
  description = "Name of the IAM role for GitHub Actions"
  value       = var.create_core ? aws_iam_role.github_actions_derivatives[0].name : null
}

################################################################################
# SERVICE ENDPOINTS (internal ALB, reachable via VPN)
################################################################################
output "perps_keeper_endpoint" {
  description = "Perps Keeper health endpoint (internal ALB via VPN)"
  value       = var.perpskeeper_service.create ? "https://keeper.${local.hp_dns["exc"].name}/health" : null
}

output "perps_mktmkr_endpoint" {
  description = "Perps MktMkr health endpoint (internal ALB via VPN)"
  value       = var.marketmaker_service.create ? "https://perpsmm.${local.hp_dns["exc"].name}/health" : null
}

