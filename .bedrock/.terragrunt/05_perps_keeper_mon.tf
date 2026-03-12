################################################################################
# PERPS KEEPER — MONITORING
# Metric filters, alarms, and dashboard for the Keeper (liquidation bot) service
#
# Log format: structured JSON via pino
#   level 30 = info, 40 = warn, 50 = error
#
# Key log messages:
#   "Resync complete"                  — position resync heartbeat (every ~5m)
#   "Market price"                     — oracle price at resync
#   "Liquidation candidates found"     — found positions to liquidate
#   "Liquidation tx submitted"         — individual liquidation sent
#   "Batch liquidation tx submitted"   — batch liquidation sent
#   "Liquidation confirmed"            — individual tx confirmed
#   "Batch liquidation confirmed"      — batch tx confirmed
#   "Liquidation attempt failed"       — individual tx failed (level 50)
#   "Batch liquidation failed*"        — batch failed, falling back (level 40)
#   "Price check failed"               — can't read oracle price (level 50)
#   "Resync failed"                    — can't read contract state (level 50)
#   "Event watcher error"              — event stream broken (level 50)
#   "Simulation reverted:*"            — stale state, not liquidatable (level 40)
################################################################################

locals {
  keeper_metric_ns  = "PerpsKeeper"
  keeper_env_suffix = substr(var.account_shortname, 8, 3)
}

################################################################################
# SNS TOPIC
#
# Dedicated topic for keeper alerts. To route through the existing
# Slack pipeline, subscribe the devops-alerts Lambda to this topic:
#   titanio-{env}-dev-alerts → devops-alerts Lambda → Slack
# Or replace alarm_actions with the existing topic ARN directly.
################################################################################

resource "aws_sns_topic" "perps_keeper_alerts" {
  count    = var.perpskeeper_service.create ? 1 : 0
  provider = aws.use1
  name     = "perps-keeper-alerts-${local.keeper_env_suffix}"

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Alerts"
    Capability = "Monitoring"
  })
}

################################################################################
# METRIC FILTERS — EVENT COUNTS
################################################################################

resource "aws_cloudwatch_log_metric_filter" "keeper_error_count" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-error-count"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.level = 50 }"

  metric_transformation {
    name      = "ErrorCount"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_warn_count" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-warn-count"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.level = 40 }"

  metric_transformation {
    name      = "WarnCount"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_resync_complete" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-resync-complete"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Resync complete\" }"

  metric_transformation {
    name      = "ResyncComplete"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_resync_failed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-resync-failed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Resync failed\" }"

  metric_transformation {
    name      = "ResyncFailed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_price_check_failed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-price-check-failed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Price check failed\" }"

  metric_transformation {
    name      = "PriceCheckFailed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_event_watcher_error" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-event-watcher-error"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Event watcher error\" }"

  metric_transformation {
    name      = "EventWatcherError"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_liq_candidates" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-liq-candidates"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Liquidation candidates found\" }"

  metric_transformation {
    name      = "LiqCandidatesFound"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_liq_submitted" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-liq-submitted"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Liquidation tx submitted\" }"

  metric_transformation {
    name      = "LiqSubmitted"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_batch_liq_submitted" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-batch-liq-submitted"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Batch liquidation tx submitted\" }"

  metric_transformation {
    name      = "BatchLiqSubmitted"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_liq_confirmed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-liq-confirmed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Liquidation confirmed\" }"

  metric_transformation {
    name      = "LiqConfirmed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_batch_liq_confirmed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-batch-liq-confirmed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Batch liquidation confirmed\" }"

  metric_transformation {
    name      = "BatchLiqConfirmed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_liq_failed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-liq-failed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Liquidation attempt failed\" }"

  metric_transformation {
    name      = "LiqFailed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_batch_liq_failed" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-batch-liq-failed"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Batch liquidation failed*\" }"

  metric_transformation {
    name      = "BatchLiqFailed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_sim_reverted" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-sim-reverted"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Simulation reverted:*\" }"

  metric_transformation {
    name      = "SimulationReverted"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_sync_order_match_fail" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-sync-match-fail"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Failed to sync*after OrderMatched\" }"

  metric_transformation {
    name      = "SyncAfterMatchFailed"
    namespace = local.keeper_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# METRIC FILTERS — EXTRACTED VALUES
################################################################################

resource "aws_cloudwatch_log_metric_filter" "keeper_tracked_users" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-tracked-users"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Resync complete\" }"

  metric_transformation {
    name          = "TrackedUsers"
    namespace     = local.keeper_metric_ns
    value         = "$.trackedUsers"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_market_price" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-market-price"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Market price\" }"

  metric_transformation {
    name          = "MarketPrice"
    namespace     = local.keeper_metric_ns
    value         = "$.marketPrice"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_liq_candidate_count" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "perps-keeper-liq-candidate-count"
  log_group_name = aws_cloudwatch_log_group.perpskeeper_use1[0].name
  pattern        = "{ $.msg = \"Liquidation candidates found\" }"

  metric_transformation {
    name          = "LiqCandidateCount"
    namespace     = local.keeper_metric_ns
    value         = "$.count"
    default_value = "0"
  }
}

################################################################################
# ALARMS
################################################################################

# CRITICAL — No resync for 10 minutes (normally fires every ~5m)
resource "aws_cloudwatch_metric_alarm" "keeper_no_resync" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-no-resync-${local.keeper_env_suffix}"
  alarm_description   = "No Resync complete events for 10+ minutes — keeper may be down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ResyncComplete"
  namespace           = local.keeper_metric_ns
  period              = 600
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper No Resync Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL — Resync failed (can't read contract state)
resource "aws_cloudwatch_metric_alarm" "keeper_resync_failed" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-resync-fail-${local.keeper_env_suffix}"
  alarm_description   = "Position resync failed — keeper cannot read contract state"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ResyncFailed"
  namespace           = local.keeper_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Resync Failed Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL — Price check failed (blind on liquidation pricing)
resource "aws_cloudwatch_metric_alarm" "keeper_price_fail" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-price-fail-${local.keeper_env_suffix}"
  alarm_description   = "Price check failed — keeper cannot determine liquidation prices"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "PriceCheckFailed"
  namespace           = local.keeper_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Price Fail Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL — Event watcher broken (missing on-chain events)
resource "aws_cloudwatch_metric_alarm" "keeper_event_watcher" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-event-watch-${local.keeper_env_suffix}"
  alarm_description   = "Event watcher error — keeper may miss on-chain position changes"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "EventWatcherError"
  namespace           = local.keeper_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Event Watcher Alarm"
    Capability = "Monitoring"
  })
}

# WARNING — Liquidation execution failures
resource "aws_cloudwatch_metric_alarm" "keeper_liq_failed" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-liq-fail-${local.keeper_env_suffix}"
  alarm_description   = "Liquidation attempt failed — on-chain execution issue"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "LiqFailed"
  namespace           = local.keeper_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Liquidation Failure Alarm"
    Capability = "Monitoring"
  })
}

# WARNING — Elevated error rate
resource "aws_cloudwatch_metric_alarm" "keeper_error_rate" {
  count               = var.perpskeeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "perps-keeper-errors-${local.keeper_env_suffix}"
  alarm_description   = "Keeper error rate elevated (>5 errors in 5 minutes)"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = local.keeper_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_keeper_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_keeper_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Perps Keeper Error Rate Alarm"
    Capability = "Monitoring"
  })
}

################################################################################
# DASHBOARD
################################################################################

resource "aws_cloudwatch_dashboard" "perps_keeper" {
  count          = var.perpskeeper_service.create ? 1 : 0
  provider       = aws.use1
  dashboard_name = "perps-keeper-${local.keeper_env_suffix}"

  dashboard_body = jsonencode({
    widgets = [

      # ── Row 1: Health Overview (single-value) ──────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.keeper_metric_ns, "ResyncComplete", { stat = "Sum", label = "Resyncs" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 600
          title  = "Resyncs (10m)"
        }
      },
      {
        type   = "metric"
        x      = 4
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.keeper_metric_ns, "ErrorCount", { stat = "Sum", label = "Errors", color = "#d62728" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "Errors (5m)"
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.keeper_metric_ns, "TrackedUsers", { stat = "Average", label = "Positions" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 600
          title  = "Tracked Positions"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [{ expression = "m1/100", label = "Price ($)", id = "e1" }],
            [local.keeper_metric_ns, "MarketPrice", { stat = "Average", id = "m1", visible = false }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 600
          title  = "Market Price"
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.keeper_metric_ns, "LiqCandidatesFound", { stat = "Sum", label = "Candidates", color = "#ff7f0e" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 3600
          title  = "Liq Candidates (1h)"
        }
      },
      {
        type   = "metric"
        x      = 20
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [{ expression = "m1+m2", label = "Liquidated", id = "e1", color = "#2ca02c" }],
            [local.keeper_metric_ns, "LiqConfirmed", { stat = "Sum", id = "m1", visible = false }],
            [local.keeper_metric_ns, "BatchLiqConfirmed", { stat = "Sum", id = "m2", visible = false }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 3600
          title  = "Liquidations (1h)"
        }
      },

      # ── Row 2: Alarm Status ────────────────────────────────────────────
      {
        type   = "alarm"
        x      = 0
        y      = 4
        width  = 24
        height = 3
        properties = {
          alarms = [
            aws_cloudwatch_metric_alarm.keeper_no_resync[0].arn,
            aws_cloudwatch_metric_alarm.keeper_resync_failed[0].arn,
            aws_cloudwatch_metric_alarm.keeper_price_fail[0].arn,
            aws_cloudwatch_metric_alarm.keeper_event_watcher[0].arn,
            aws_cloudwatch_metric_alarm.keeper_liq_failed[0].arn,
            aws_cloudwatch_metric_alarm.keeper_error_rate[0].arn,
          ]
          title = "Alarm Status"
        }
      },

      # ── Row 3: Liquidation Activity ────────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "LiqCandidatesFound", { stat = "Sum", label = "Candidates Found", color = "#ff7f0e" }],
            [local.keeper_metric_ns, "LiqCandidateCount", { stat = "Sum", label = "Total Candidate Users", color = "#9467bd" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Liquidation Candidates (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "LiqSubmitted", { stat = "Sum", label = "Individual TX", color = "#1f77b4" }],
            [local.keeper_metric_ns, "BatchLiqSubmitted", { stat = "Sum", label = "Batch TX", color = "#2ca02c" }],
            [local.keeper_metric_ns, "LiqConfirmed", { stat = "Sum", label = "Individual Confirmed", color = "#17becf" }],
            [local.keeper_metric_ns, "BatchLiqConfirmed", { stat = "Sum", label = "Batch Confirmed", color = "#bcbd22" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Liquidation Executions (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "LiqFailed", { stat = "Sum", label = "Liq Failed", color = "#d62728" }],
            [local.keeper_metric_ns, "BatchLiqFailed", { stat = "Sum", label = "Batch Failed", color = "#ff7f0e" }],
            [local.keeper_metric_ns, "SimulationReverted", { stat = "Sum", label = "Sim Reverted", color = "#9467bd" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Liquidation Failures (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },

      # ── Row 4: Market & Positions ──────────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 13
        width  = 12
        height = 6
        properties = {
          metrics = [
            [{ expression = "m1/100", label = "Market Price ($)", id = "e1" }],
            [local.keeper_metric_ns, "MarketPrice", { stat = "Average", id = "m1", visible = false }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Market Price Over Time"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 13
        width  = 12
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "TrackedUsers", { stat = "Average", label = "Tracked Positions", color = "#1f77b4" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Tracked Positions Over Time"
          yAxis  = { left = { min = 0 } }
        }
      },

      # ── Row 5: Infrastructure Health ───────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "ResyncFailed", { stat = "Sum", label = "Resync Failed", color = "#d62728" }],
            [local.keeper_metric_ns, "PriceCheckFailed", { stat = "Sum", label = "Price Check Failed", color = "#ff7f0e" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Data Source Failures (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "EventWatcherError", { stat = "Sum", label = "Event Watcher Errors", color = "#d62728" }],
            [local.keeper_metric_ns, "SyncAfterMatchFailed", { stat = "Sum", label = "Sync After Match Failed", color = "#ff7f0e" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Event Processing Errors (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.keeper_metric_ns, "WarnCount", { stat = "Sum", label = "Warnings", color = "#ff7f0e" }],
            [local.keeper_metric_ns, "ErrorCount", { stat = "Sum", label = "Errors", color = "#d62728" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Errors & Warnings (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },

      # ── Row 6: Logs ────────────────────────────────────────────────────
      {
        type   = "log"
        x      = 0
        y      = 25
        width  = 24
        height = 6
        properties = {
          query  = "SOURCE '${aws_cloudwatch_log_group.perpskeeper_use1[0].name}' | fields @timestamp, msg, coalesce(user, '') as user, coalesce(err.message, '') as error | filter level >= 40 | sort @timestamp desc | limit 50"
          region = var.default_region
          title  = "Recent Errors & Warnings"
          view   = "table"
        }
      }
    ]
  })
}
