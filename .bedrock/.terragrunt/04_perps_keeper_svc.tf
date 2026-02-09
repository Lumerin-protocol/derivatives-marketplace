# USE1_1 Definition
# PerpsKeeper Service - Telegram Bot with RDS PostgreSQL

################################
# SECURITY GROUPS
################################

# Dedicated security group for PerpsKeeper ALB (Internal)
resource "aws_security_group" "perpskeeper_alb_use1" {
  count       = var.perpskeeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "perpskeeper-alb-int-v2-${substr(var.account_shortname, 8, 3)}"
  description = "Security group for PerpsKeeper internal ALB"
  vpc_id      = data.aws_vpc.use1_1.id

  # Allow HTTPS from VPC (internal ALB)
  ingress {
    description = "HTTPS from VPC"
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
      Name       = "PerpsKeeper ALB Security Group",
      Capability = null,
    },
  )
}

# Dedicated security group for PerpsKeeper ECS tasks
resource "aws_security_group" "perpskeeper_ecs_use1" {
  count       = var.perpskeeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "perpskeeper-ecs-v2-${substr(var.account_shortname, 8, 3)}"
  description = "Security group for PerpsKeeper ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  # All rules managed via separate aws_security_group_rule resources below

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
# SECURITY GROUP RULES - ECS
################################

# ECS ingress from ALB
resource "aws_security_group_rule" "perpskeeper_ecs_from_alb" {
  count                    = var.perpskeeper_service.create ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "HTTP from ALB"
  from_port                = var.perpskeeper_service["cnt_port"]
  to_port                  = var.perpskeeper_service["cnt_port"]
  protocol                 = "tcp"
  security_group_id        = aws_security_group.perpskeeper_ecs_use1[count.index].id
  source_security_group_id = aws_security_group.perpskeeper_alb_use1[count.index].id
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "perpskeeper_use1" {
  count             = var.perpskeeper_service.create ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${var.perpskeeper_service["svc_name"]}-${substr(var.account_shortname, 8, 3)}"
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
# ECS SERVICE & TASK 
################################

# Define Service
resource "aws_ecs_service" "perpskeeper_use1" {
  # lifecycle {ignore_changes = [task_definition] }
  count                  = var.perpskeeper_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${var.perpskeeper_service["svc_name"]}-${substr(var.account_shortname, 8, 3)}"
  cluster                = aws_ecs_cluster.derivatives_marketplace[0].id
  task_definition        = aws_ecs_task_definition.perpskeeper_use1[count.index].arn
  desired_count          = var.perpskeeper_service["task_worker_qty"]
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # Telegram bot requirement: Only one instance can be active at a time
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

  load_balancer {
    target_group_arn = aws_alb_target_group.perpskeeper_int_use1[count.index].arn
    container_name   = "${var.perpskeeper_service["cnt_name"]}-container"
    container_port   = var.perpskeeper_service["cnt_port"]
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
  family                   = "tsk-${var.perpskeeper_service["svc_name"]}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.perpskeeper_service["task_cpu"]
  memory                   = var.perpskeeper_service["task_ram"]
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
          containerPort = tonumber(var.perpskeeper_service["cnt_port"])
          hostPort      = tonumber(var.perpskeeper_service["cnt_port"])
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "PORT"
          value = tostring(var.perpskeeper_service["cnt_port"])
        },
        {
          name  = "LOG_LEVEL"
          value = "info"
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
# APPLICATION LOAD BALANCER (INTERNAL)
################################

# INTERNAL ALB
resource "aws_alb" "perpskeeper_int_use1" {
  count                      = var.perpskeeper_service.create ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-${var.perpskeeper_service["svc_name"]}-${substr(var.account_shortname, 8, 3)}"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.perpskeeper_alb_use1[count.index].id]
  subnets                    = [for m in data.aws_subnet.middle_use1_1 : m.id]
  enable_deletion_protection = false

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper Internal ALB",
      Capability = null,
    },
  )
}

# ALB Internal Target group
resource "aws_alb_target_group" "perpskeeper_int_use1" {
  count                         = var.perpskeeper_service.create ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-notification-v2-${var.perpskeeper_service["cnt_port"]}"
  port                          = tonumber(var.perpskeeper_service["cnt_port"])
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/healthcheck"
    port                = var.perpskeeper_service["cnt_port"]
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper Internal ALB Target Group",
      Capability = null,
    },
  )
}

# Create listeners on the ALB 
resource "aws_alb_listener" "perpskeeper_int_443_use1" {
  count             = var.perpskeeper_service.create ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.perpskeeper_int_use1[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn   = data.aws_acm_certificate.lumerin_marketplace_ext.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.perpskeeper_int_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "PerpsKeeper Internal ALB Listener",
      Capability = null,
    },
  )
}

# Define Route53 Alias to load balancer (internal zone)
resource "aws_route53_record" "perpskeeper_int_use1" {
  count    = var.perpskeeper_service.create ? 1 : 0
  provider = aws.use1
  zone_id  = data.aws_route53_zone.public_lumerin.zone_id
  name     = "${var.perpskeeper_service["alb_name"]}${data.aws_route53_zone.public_lumerin.name}"
  type     = "A"

  alias {
    name                   = aws_alb.perpskeeper_int_use1[count.index].dns_name
    zone_id                = aws_alb.perpskeeper_int_use1[count.index].zone_id
    evaluate_target_health = true
  }
}


