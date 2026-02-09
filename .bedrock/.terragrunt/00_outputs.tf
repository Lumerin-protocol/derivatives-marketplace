
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

