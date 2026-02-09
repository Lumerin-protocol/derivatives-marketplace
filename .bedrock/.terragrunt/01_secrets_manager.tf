################################################################################
# SECRETS MANAGER
################################################################################
# AWS Secrets Manager resources for sensitive variables

# IAM policy to allow ECS task execution role to read the graph indexer secrets
resource "aws_iam_policy" "derivatives_marketplace_secret_access" {
  count       = (var.create_core) ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-secret-access-${substr(var.account_shortname, 8, 3)}"
  description = "Allow ECS tasks to read Derivatives Marketplace secrets from Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = compact([
          var.create_core ? aws_secretsmanager_secret.perps_keeper.arn : ""
        ])
      }
    ]
  })

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Derivatives Marketplace Secret Access Policy",
      Capability = null,
    },
  )
}

# Attach the policy to the bedrock foundation role
resource "aws_iam_role_policy_attachment" "derivatives_marketplace_secret_access" {
  count      = (var.create_core) ? 1 : 0
  provider   = aws.use1
  role       = "bedrock-foundation-role"
  policy_arn = aws_iam_policy.derivatives_marketplace_secret_access[0].arn
}


################################################################################
# Keeper Secrets
################################################################################
# Separate secret for Perps Keeper 
# Contains private key and ETH node URL (sensitive trading credentials)

resource "aws_secretsmanager_secret" "perps_keeper" {
  name        = "perps-keeper-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Secrets for Keeper trading service (private key and ETH node URL)"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "perps-keeper-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "perps_keeper" {
  count = var.perpskeeper_service.create ? 1 : 0
  # lifecycle {ignore_changes = [secret_string]}
  secret_id = aws_secretsmanager_secret.perps_keeper.id
  secret_string = jsonencode({
    keeper_private_key          = var.perpskeeper_private_key
    eth_node_address         = var.ethereum_rpc_url
    futures_subgraph_url = "https://gateway.thegraph.com/api/${var.graph_api_key}/subgraphs/id/${var.derivatives_subgraph_id}"
    oracles_subgraph_url = "https://gateway.thegraph.com/api/${var.graph_api_key}/subgraphs/id/${var.oracles_subgraph_id}"
  })
}
