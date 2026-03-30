# USE1_1 Definition
# Perps MktMkr Service - Automated market-making bot with health endpoint

################################
# SECURITY GROUPS
################################

# Security group for internal ALB
resource "aws_security_group" "marketmaker_alb_use1" {
  count       = var.marketmaker_service.create ? 1 : 0
  provider    = aws.use1
  name        = "perps-mktmkr-alb-${substr(var.account_shortname, 8, 3)}"
  description = "Security group for Perps MktMkr internal ALB"
  vpc_id      = data.aws_vpc.use1_1.id

  # Allow HTTPS from VPC and VPN
  ingress {
    description = "HTTPS from VPC and VPN"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.use1_1.cidr_block, "172.18.0.0/19"] # VPC + VPN
  }

  # Allow all outbound
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
      Name       = "Perps MktMkr ALB Security Group",
      Capability = null,
    },
  )
}

# Security group for Perps MktMkr ECS tasks
resource "aws_security_group" "marketmaker_ecs_use1" {
  count       = var.marketmaker_service.create ? 1 : 0
  provider    = aws.use1
  name        = "perps-mktmkr-ecs-${substr(var.account_shortname, 8, 3)}"
  description = "Security group for Perps MktMkr ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  # Allow HTTP from ALB
  ingress {
    description     = "HTTP from ALB"
    from_port       = var.marketmaker_service.cnt_port
    to_port         = var.marketmaker_service.cnt_port
    protocol        = "tcp"
    security_groups = [aws_security_group.marketmaker_alb_use1[count.index].id]
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
      Name       = "Perps MktMkr ECS Security Group",
      Capability = null,
    },
  )
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "marketmaker_use1" {
  count             = var.marketmaker_service.create ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${var.marketmaker_service.svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = 7

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr ECS Log Group",
      Capability = null,
    },
  )
}

################################
# APPLICATION LOAD BALANCER (INTERNAL)
################################

# Internal ALB
resource "aws_alb" "marketmaker_int_use1" {
  count                      = var.marketmaker_service.create ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-perps-mktmkr-${substr(var.account_shortname, 8, 3)}"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.marketmaker_alb_use1[count.index].id]
  subnets                    = [for m in data.aws_subnet.middle_use1_1 : m.id]
  enable_deletion_protection = false

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr Internal ALB",
      Capability = null,
    },
  )
}

# Target group
resource "aws_alb_target_group" "marketmaker_int_use1" {
  count                         = var.marketmaker_service.create ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-perps-mktmkr-${substr(var.account_shortname, 8, 3)}"
  port                          = tonumber(var.marketmaker_service.cnt_port)
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/health"
    port                = var.marketmaker_service.cnt_port
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr Target Group",
      Capability = null,
    },
  )
}

# HTTPS Listener
resource "aws_alb_listener" "marketmaker_int_443_use1" {
  count             = var.marketmaker_service.create ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.marketmaker_int_use1[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn   = local.hp_acm["exc"].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.marketmaker_int_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr HTTPS Listener",
      Capability = null,
    },
  )
}

# Route53 record
resource "aws_route53_record" "marketmaker_int_use1" {
  count    = var.marketmaker_service.create ? 1 : 0
  provider = aws.use1
  zone_id  = local.hp_dns["exc"].zone_id
  name     = "perpsmm.${local.hp_dns["exc"].name}"
  type     = "A"

  alias {
    name                   = aws_alb.marketmaker_int_use1[count.index].dns_name
    zone_id                = aws_alb.marketmaker_int_use1[count.index].zone_id
    evaluate_target_health = true
  }
}

################################
# ECS SERVICE & TASK 
################################

# Define Service
resource "aws_ecs_service" "marketmaker_use1" {
  lifecycle {ignore_changes = [task_definition] }
  count                  = var.marketmaker_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${var.marketmaker_service.svc_name}-${substr(var.account_shortname, 8, 3)}"
  cluster                = aws_ecs_cluster.derivatives_marketplace[0].id
  task_definition        = aws_ecs_task_definition.marketmaker_use1[count.index].arn
  desired_count          = var.marketmaker_service.task_worker_qty
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # Market maker: Only one instance active at a time
  # Recreate deployment strategy to avoid duplicate order submissions
  deployment_minimum_healthy_percent = 0   # Allow stopping all old tasks
  deployment_maximum_percent         = 100 # Only run desired_count (1 task max)

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.marketmaker_ecs_use1[count.index].id]
  }

  # Load balancer configuration
  load_balancer {
    target_group_arn = aws_alb_target_group.marketmaker_int_use1[count.index].arn
    container_name   = "${var.marketmaker_service.cnt_name}-container"
    container_port   = var.marketmaker_service.cnt_port
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr Service",
      Capability = null,
    },
  )
}

# Define Task  
resource "aws_ecs_task_definition" "marketmaker_use1" {
  lifecycle { ignore_changes = [container_definitions] }
  count                    = var.marketmaker_service.create ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${var.marketmaker_service.svc_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.marketmaker_service.task_cpu
  memory                   = var.marketmaker_service.task_ram
  task_role_arn            = local.titanio_role_arn
  execution_role_arn       = local.titanio_role_arn

  container_definitions = jsonencode([
    {
      name        = "${var.marketmaker_service.cnt_name}-container"
      image       = "${var.marketmaker_service.ghcr_repo}:${var.marketmaker_service.ghcr_imagetag}"
      cpu         = 0
      launch_type = "FARGATE"
      essential   = true

      portMappings = [
        {
          containerPort = tonumber(var.marketmaker_service.cnt_port)
          hostPort      = tonumber(var.marketmaker_service.cnt_port)
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "PORT"
          value = tostring(var.marketmaker_service.cnt_port)
        },
        {
          name  = "MAKER_LOG_LEVEL"
          value = var.marketmaker_service.maker_log_level
        },
        {
          name  = "PERPS_ADDRESS"
          value = var.perps_address
        },
        {
          name  = "NETWORK"
          value = var.marketmaker_service.network
        },
        {
          name  = "MAKER_HEALTH_PORT"
          value = tostring(var.marketmaker_service.cnt_port)
        }
      ]
      secrets = [
        {
          name      = "MAKER_PRIVATE_KEY"
          valueFrom = "${aws_secretsmanager_secret.market_maker.arn}:maker_private_key::"
        },
        {
          name      = "ETH_NODE_ADDRESS"
          valueFrom = "${aws_secretsmanager_secret.market_maker.arn}:eth_node_address::"
        }
      ]
      
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = aws_cloudwatch_log_group.marketmaker_use1[0].name
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "${var.marketmaker_service.svc_name}-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Perps MktMkr ECS Task Definition",
      Capability = null,
    },
  )
}

################################
# ACCESS INFORMATION
################################

# The Perps MktMkr service is accessible via internal ALB:
#   DEV: https://perpsmm.dev.hashpower.exchange/health
#   STG: https://perpsmm.stg.hashpower.exchange/health
#   LMN: https://perpsmm.hashpower.exchange/health
#
# Access is restricted by ALB security group to:
#   - VPC CIDR: data.aws_vpc.use1_1.cidr_block
#   - VPN CIDR: 172.18.0.0/19
#
# Architecture:
#   perpsmm.{env}.hashpower.exchange (Route53 A record)
#     -> Internal ALB (HTTPS:443)
#       -> Target Group (health check: /health)
#         -> ECS Task (HTTP:3001)
#
# Additional Monitoring:
#   - CloudWatch Logs: /ecs/perps-mktmkr-{env}
#   - ECS Console: Task status and metrics
