################################
# ECS CLUSTER 
################################
# Define ECS Cluster with Fargate as default provider 
resource "aws_ecs_cluster" "derivatives_marketplace" {
  count    = var.ecs_cluster.create ? 1 : 0
  provider = aws.use1
  name     = "ecs-${local.shortname}-${substr(var.account_shortname, 8, 3)}"
  configuration {
    execute_command_configuration {
      kms_key_id = "arn:aws:kms:${var.default_region}:${var.account_number}:alias/foundation-cmk-eks"
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_encryption_enabled = false
        cloud_watch_log_group_name     = "bedrock-${local.shortname}-ecs-cluster-${substr(var.account_shortname, 8, 3)}"
      }
    }
  }
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Lumerin ${local.shortname} ECS Cluster",
      Capability = null,
    },
  )
}

resource "aws_ecs_cluster_capacity_providers" "derivatives_marketplace" {
  count              = var.ecs_cluster.create ? 1 : 0
  provider           = aws.use1
  cluster_name       = aws_ecs_cluster.derivatives_marketplace[count.index].name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    base              = local.ecs_task_worker_qty
    weight            = 100
    capacity_provider = "FARGATE"
  }
}


###############################
# Create the default CloudWatch Log Group resource for Lumerin Marketplace Service 
resource "aws_cloudwatch_log_group" "derivatives_marketplace" {
  count             = var.create_core && var.ecs_cluster.create ? 1 : 0
  provider          = aws.use1
  name              = "bedrock-${local.shortname}-ecs-cluster-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = local.cloudwatch_event_retention
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name = "Bedrock ${local.shortname} ECS Cluster Cloudwatch Log Group",
      Capability = "Bedrock Cloudwatch Log Group",
    },
  )
}

# Create the Inline Policy for the IAM Role
resource "aws_iam_role_policy" "derivatives_ecs_cluster" {
  count    = var.create_core && var.ecs_cluster.create ? 1 : 0
  provider = aws.use1
  name     = "${local.shortname}-cw-policy"
  role     = aws_iam_role.derivatives_marketplace[count.index].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          aws_cloudwatch_log_group.derivatives_marketplace[count.index].arn,
        ]
      }
    ]
  })
}
