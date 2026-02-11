# USE1_1 Definition
# PerpsKeeper Service - Background liquidation keeper with health endpoint

################################
# SECURITY GROUPS
################################

# Dedicated security group for PerpsKeeper ECS tasks
resource "aws_security_group" "perpskeeper_ecs_use1" {
  count       = var.perpskeeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "perpskeeper-ecs-v2-${substr(var.account_shortname, 8, 3)}"
  description = "Security group for PerpsKeeper ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  # Allow health endpoint access from VPC and VPN
  ingress {
    description = "HTTP health endpoint from VPC and VPN"
    from_port   = var.perpskeeper_service.cnt_port
    to_port     = var.perpskeeper_service.cnt_port
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.use1_1.cidr_block, "172.18.0.0/19"] # VPC + VPN
  }

  # Allow all outbound (for Ethereum RPC and blockchain access)
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper ECS Security Group",
      Capability = null,
    },
  )
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "perpskeeper_use1" {
  count             = var.perpskeeper_service.create ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${var.perpskeeper_service.svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = 7

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper ECS Log Group",
      Capability = null,
    },
  )
}

################################
# SERVICE DISCOVERY (CLOUD MAP)
################################

# Service discovery namespace for internal services
resource "aws_service_discovery_private_dns_namespace" "internal" {
  count       = var.perpskeeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "internal"
  description = "Private namespace for ECS service discovery"
  vpc         = data.aws_vpc.use1_1.id

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "ECS Service Discovery Namespace",
      Capability = null,
    },
  )
}

# Register keeper service in service discovery
resource "aws_service_discovery_service" "perpskeeper_use1" {
  count    = var.perpskeeper_service.create ? 1 : 0
  provider = aws.use1
  name     = var.perpskeeper_service.svc_name  # "perps-keeper"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal[count.index].id
    
    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper Service Discovery",
      Capability = null,
    },
  )
}

# Create CNAME in public zone: keeper.dev.lumerin.io -> perps-keeper.internal
resource "aws_route53_record" "perpskeeper_public_cname" {
  count    = var.perpskeeper_service.create ? 1 : 0
  provider = aws.use1
  zone_id  = data.aws_route53_zone.public_lumerin.zone_id
  name     = "${var.perpskeeper_service.dns_name}.${data.aws_route53_zone.public_lumerin.name}"
  type     = "CNAME"
  ttl      = 60
  records  = ["${var.perpskeeper_service.svc_name}.${aws_service_discovery_private_dns_namespace.internal[count.index].name}"]
}

################################
# ECS SERVICE & TASK 
################################

# Define Service
resource "aws_ecs_service" "perpskeeper_use1" {
  # lifecycle {ignore_changes = [task_definition] }
  count                  = var.perpskeeper_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${var.perpskeeper_service.svc_name}-${substr(var.account_shortname, 8, 3)}"
  cluster                = aws_ecs_cluster.derivatives_marketplace[0].id
  task_definition        = aws_ecs_task_definition.perpskeeper_use1[count.index].arn
  desired_count          = var.perpskeeper_service.task_worker_qty
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # Liquidation keeper: Only one instance can be active at a time
  # Kill old task before starting new one (recreate deployment strategy)
  deployment_minimum_healthy_percent = 0   # Allow stopping all old tasks
  deployment_maximum_percent         = 100 # Only run desired_count (1 task max)

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.perpskeeper_ecs_use1[count.index].id]
  }

  # Service Discovery configuration
  service_registries {
    registry_arn = aws_service_discovery_service.perpskeeper_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper Service",
      Capability = null,
    },
  )
}

# Define Task  
resource "aws_ecs_task_definition" "perpskeeper_use1" {
  # lifecycle { ignore_changes = [container_definitions] }
  count                    = var.perpskeeper_service.create ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${var.perpskeeper_service.svc_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.perpskeeper_service.task_cpu
  memory                   = var.perpskeeper_service.task_ram
  task_role_arn            = local.titanio_role_arn
  execution_role_arn       = local.titanio_role_arn

  container_definitions = jsonencode([
    {
      name        = "${var.perpskeeper_service.cnt_name}-container"
      image       = "${var.perpskeeper_service.ghcr_repo}:${var.perpskeeper_service.ghcr_imagetag}"
      cpu         = 0
      launch_type = "FARGATE"
      essential   = true

      portMappings = [
        {
          containerPort = tonumber(var.perpskeeper_service.cnt_port)
          hostPort      = tonumber(var.perpskeeper_service.cnt_port)
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "PORT"
          value = tostring(var.perpskeeper_service.cnt_port)
        },
        {
          name  = "KEEPER_LOG_LEVEL"
          value = "info"
        },
        {
          name  = "PERPS_ADDRESS"
          value = var.perps_address
        },
        {
          name = "NETWORK"
          value = var.perpskeeper_service.network
        },
        {
          name  = "ETH_PRICE_FEED_ADDRESS"
          value = var.perpskeeper_service.eth_price_feed_address
        },
        {
          name  = "KEEPER_POLL_INTERVAL_MS"
          value = var.perpskeeper_service.keeper_poll_interval_ms
        },
        {
          name  = "KEEPER_RESYNC_INTERVAL_MS"
          value = var.perpskeeper_service.keeper_resync_interval_ms
        },
        {
          name  = "KEEPER_DRY_RUN"
          value = var.perpskeeper_service.keeper_dry_run
        },
        {
          name  = "KEEPER_MIN_PROFIT_MARGIN"
          value = var.perpskeeper_service.keeper_min_profit_margin
        },
        {
          name  = "KEEPER_HEALTH_PORT"
          value = var.perpskeeper_service.keeper_health_port
        }
      ]
      secrets = [
        {
          name  = "KEEPER_PRIVATE_KEY"
          valueFrom = "${aws_secretsmanager_secret.perps_keeper.arn}:keeper_private_key::"
        },
        {
          name  = "ETH_NODE_ADDRESS"
          valueFrom = "${aws_secretsmanager_secret.perps_keeper.arn}:eth_node_address::"
        }
      ]
      
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = aws_cloudwatch_log_group.perpskeeper_use1[0].name
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "${var.perpskeeper_service.svc_name}-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper ECS Task Definition",
      Capability = null,
    },
  )
}

################################
# ACCESS INFORMATION
################################

# The PerpsKeeper service is accessible via:
#   DEV: http://keeper.dev.lumerin.io:3000/health
#   STG: http://keeper.stg.lumerin.io:3000/health
#   LMN: http://keeper.lmn.lumerin.io:3000/health
#
# Access is restricted by security group to:
#   - VPC CIDR: data.aws_vpc.use1_1.cidr_block
#   - VPN CIDR: 172.18.0.0/19
#
# DNS Resolution:
#   keeper.{env}.lumerin.io (CNAME in public zone)
#     -> perps-keeper.internal (service discovery A record)
#       -> Task private IP (auto-updated on task restart)

