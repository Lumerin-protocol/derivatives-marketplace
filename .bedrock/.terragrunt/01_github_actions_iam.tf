################################################################################
# GITHUB ACTIONS IAM ROLE AND POLICIES
################################################################################
# If the OIDC provider doesn't exist, create it
# Run this once manually if needed:
# aws iam create-open-id-connect-provider \
#   --url https://token.actions.githubusercontent.com \
#   --client-id-list sts.amazonaws.com \
#   --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1b511abead59c6ce207077c0bf0e0043b1382612 \
#   --profile titanio-stg
#
# Note: Two thumbprints are recommended by GitHub for compatibility:
# - 6938fd4d98bab03faadb97b34396831e3780aea1 (legacy)
# - 1b511abead59c6ce207077c0bf0e0043b1382612 (current as of 2023)

################################################################################
# OIDC PROVIDER FOR GITHUB
################################################################################
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

################################################################################
# IAM ROLE FOR GITHUB ACTIONS
################################################################################
resource "aws_iam_role" "github_actions_derivatives" {
  count = var.create_core ? 1 : 0
  name  = "github-actions-derivatives-v3-${substr(var.account_shortname, 8, 3)}"
  provider = aws.use1
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = concat(
              var.create_core ? [
                for branch_filter in local.github_branch_filter :
                "repo:Lumerin-protocol/derivatives-marketplace:${branch_filter}"
              ] : []
            )
          }
        }
      }
    ]
  })

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "GitHub Actions - Derivatives Marketplace"
    Capability = "CI/CD"
  })
}

################################################################################
# SECRETS ACCESS POLICY (for reading deployment secrets and configuration)
################################################################################
resource "aws_iam_role_policy" "github_secrets_read" {
  count = var.create_core ? 1 : 0
  provider = aws.use1
  name  = "secrets-read-derivatives"
  role  = aws_iam_role.github_actions_derivatives[count.index].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadDerivativesSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          var.create_core ? aws_secretsmanager_secret.perps_keeper.arn : null, 
        ]
      }
    ]
  })
} 


################################################################################
# ECS UPDATE POLICY (for PerpsKeeper service only)
################################################################################
resource "aws_iam_role_policy" "github_ecs_update" {
  count = var.perpskeeper_service.create ? 1 : 0
  name  = "ecs-update-perpskeeper"
  role  = aws_iam_role.github_actions_derivatives[count.index].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdatePerpsKeeperECSService"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = [
          aws_ecs_service.perpskeeper_use1[count.index].id
        ]
      },
      {
        Sid    = "TaskDefinitionOperations"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition"
        ]
        # These actions don't support resource-level permissions
        Resource = "*"
      },
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          var.ecs_task_role_arn,
          local.titanio_role_arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ReadECSCluster"
        Effect = "Allow"
        Action = [
          "ecs:ListServices",
          "ecs:DescribeClusters"
        ]
        Resource = "*"
      }
    ]
  })
}
