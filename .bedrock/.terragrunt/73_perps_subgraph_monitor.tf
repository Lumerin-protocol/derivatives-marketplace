################################################################################
# PERPS SUBGRAPH INDEX
# The endpoint, the indexed head, indexing errors, and the Perps singleton.
# Newest funding age is a metric only. Component alarms do not notify.
################################################################################

locals {
  perps_env_suffix                 = substr(var.account_shortname, 8, 3)
  perps_subgraph_namespace         = "DerivativesMarketplace/${local.perps_env_suffix}"
  perps_subgraph_monitor_name      = "perps-subgraph-health-${local.perps_env_suffix}"
  perps_subgraph_check_seconds     = 300
  perps_subgraph_stale_seconds     = 900
  perps_subgraph_eval_periods      = 3
  perps_alerts_topic_name          = var.account_lifecycle == "prd" ? "titanio-lmn-devops-alerts" : "titanio-dev-dev-alerts"
}

data "aws_sns_topic" "perps_alerts" {
  name = local.perps_alerts_topic_name
}

data "archive_file" "perps_subgraph_monitor" {
  type        = "zip"
  source_file = "${path.module}/73_subgraph_index_monitor.py"
  output_path = "${path.module}/perps_subgraph_monitor_${filemd5("${path.module}/73_subgraph_index_monitor.py")}.zip"
}

resource "aws_iam_role" "perps_subgraph_monitor" {
  provider = aws.use1
  name     = local.perps_subgraph_monitor_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Subgraph Monitor"
    Capability = "Monitoring"
  })
}

resource "aws_iam_role_policy" "perps_subgraph_monitor" {
  provider = aws.use1
  name     = "perps-subgraph-monitor"
  role     = aws_iam_role.perps_subgraph_monitor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.default_region}:${var.account_number}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "perps_subgraph_monitor" {
  provider      = aws.use1
  function_name = local.perps_subgraph_monitor_name
  description   = "Checks the hpow-derivatives index is answering, fresh, and has the Perps entity"
  role          = aws_iam_role.perps_subgraph_monitor.arn
  handler       = "73_subgraph_index_monitor.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 256

  filename         = data.archive_file.perps_subgraph_monitor.output_path
  source_code_hash = data.archive_file.perps_subgraph_monitor.output_base64sha256

  environment {
    variables = {
      GS_URL        = var.gs_subgraphs["derivatives"]
      CW_NAMESPACE  = local.perps_subgraph_namespace
      ENVIRONMENT   = local.perps_env_suffix
      SUBGRAPH_NAME = "perps"
      ENTITY_KIND   = "perps"
    }
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Subgraph Monitor"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_event_rule" "perps_subgraph_monitor" {
  provider            = aws.use1
  name                = "${local.perps_subgraph_monitor_name}-schedule"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "perps_subgraph_monitor" {
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.perps_subgraph_monitor.name
  target_id = "perps-subgraph-monitor"
  arn       = aws_lambda_function.perps_subgraph_monitor.arn
}

resource "aws_lambda_permission" "perps_subgraph_monitor" {
  provider      = aws.use1
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.perps_subgraph_monitor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.perps_subgraph_monitor.arn
}

resource "aws_cloudwatch_metric_alarm" "perps_subgraph_unavailable" {
  provider            = aws.use1
  alarm_name          = "perps-subgraph-unavailable-${local.perps_env_suffix}"
  alarm_description   = "Perps subgraph did not answer"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.perps_subgraph_eval_periods
  metric_name         = "subgraphs_available"
  namespace           = local.perps_subgraph_namespace
  period              = local.perps_subgraph_check_seconds
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions          = { Environment = local.perps_env_suffix }
  alarm_actions       = []
  ok_actions          = []
}

resource "aws_cloudwatch_metric_alarm" "perps_subgraph_errors" {
  provider            = aws.use1
  alarm_name          = "perps-subgraph-indexing-errors-${local.perps_env_suffix}"
  alarm_description   = "Perps subgraph reports indexing errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.perps_subgraph_eval_periods
  metric_name         = "subgraph_indexing_errors"
  namespace           = local.perps_subgraph_namespace
  period              = local.perps_subgraph_check_seconds
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions = {
    Environment = local.perps_env_suffix
    Subgraph    = "perps"
  }
  alarm_actions = []
  ok_actions    = []
}

resource "aws_cloudwatch_metric_alarm" "perps_subgraph_stale" {
  provider            = aws.use1
  alarm_name          = "perps-subgraph-stale-${local.perps_env_suffix}"
  alarm_description   = "Perps subgraph indexed head is older than 15 minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.perps_subgraph_eval_periods
  metric_name         = "subgraph_data_age_seconds"
  namespace           = local.perps_subgraph_namespace
  period              = local.perps_subgraph_check_seconds
  statistic           = "Maximum"
  threshold           = local.perps_subgraph_stale_seconds
  treat_missing_data  = "breaching"
  dimensions = {
    Environment = local.perps_env_suffix
    Subgraph    = "perps"
  }
  alarm_actions = []
  ok_actions    = []
}

resource "aws_cloudwatch_metric_alarm" "perps_subgraph_empty" {
  provider            = aws.use1
  alarm_name          = "perps-subgraph-empty-${local.perps_env_suffix}"
  alarm_description   = "Perps subgraph has no Perps entity"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.perps_subgraph_eval_periods
  metric_name         = "subgraph_entity_present"
  namespace           = local.perps_subgraph_namespace
  period              = local.perps_subgraph_check_seconds
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions = {
    Environment = local.perps_env_suffix
    Subgraph    = "perps"
  }
  alarm_actions = []
  ok_actions    = []
}

resource "aws_cloudwatch_composite_alarm" "perps_subgraph_unhealthy" {
  provider          = aws.use1
  alarm_name        = "perps-subgraph-${local.perps_env_suffix}"
  alarm_description = "Perps index is down, erroring, stale, or missing the Perps entity"

  alarm_rule = join(" OR ", [
    "ALARM(${aws_cloudwatch_metric_alarm.perps_subgraph_unavailable.alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.perps_subgraph_errors.alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.perps_subgraph_stale.alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.perps_subgraph_empty.alarm_name})",
  ])

  alarm_actions = [data.aws_sns_topic.perps_alerts.arn]
  ok_actions    = [data.aws_sns_topic.perps_alerts.arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Subgraph Unhealthy"
    Capability = "Monitoring"
  })
}
