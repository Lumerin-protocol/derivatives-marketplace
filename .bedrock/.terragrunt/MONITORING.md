# HPDX Monitoring & Alerting

Canonical guide for CloudWatch monitors and alarms in this repo. Agents and humans
must follow this when adding or changing monitoring.

## SNS topics (foundation-core owns these)

Do **not** create SNS topics in this repo. Look them up by name:

| Env | Slack (`#hpdx-alerts`) | Page (SMS + email) |
| --- | --- | --- |
| DEV | `titanio-dev-hpdx-alerts` | same as Slack (no separate page) |
| LMN | `titanio-lmn-hpdx-alerts` | `titanio-lmn-hpdx-page` |

```hcl
locals {
  env_suffix = substr(var.account_shortname, 8, 3)
  alerts_topic_name = var.account_lifecycle == "prd" ? "titanio-${local.env_suffix}-hpdx-page" : "titanio-${local.env_suffix}-hpdx-alerts"
}

data "aws_sns_topic" "alerts" {
  count = /* service create flag */ 1
  name  = local.alerts_topic_name
}
```

- Never hardcode ARNs.
- Never use `terraform_remote_state` for SNS.
- Never create orphan topics (e.g. perps-mktmkr / keeper dedicated SNS).
- Prefer env-suffixed names: `titanio-${local.env_suffix}-hpdx-alerts|page`.

## Severity routing

| Severity | Non-prod (DEV) | Prod/LMN (`account_lifecycle == "prd"`) |
| --- | --- | --- |
| Warning | `hpdx-alerts` (Slack) | `hpdx-alerts` (Slack) |
| Critical | `hpdx-alerts` (Slack) | `hpdx-page` (SMS/email) |

## Alarm pattern (required)

1. **Component metric alarms** — `alarm_actions = []`, `ok_actions = []`.
2. **One composite per service** — only notifier (subgraph, mktmkr, keeper).
3. Gate on `marketmaker_service.create` / `perpskeeper_service.create` (or always-on for subgraph).

Do **not** attach SNS to every component alarm.

## Checklist for a new monitor

1. Metrics/filters + dashboard as needed.
2. Component alarms silent; composite notifies via foundation topic lookup.
3. No new SNS resources.
4. Plan is action rewires / new composite only.

## This repo

- Perps subgraph: `73_perps_subgraph_monitor.tf` (+ `73_subgraph_index_monitor.py`)
- Market maker: `05_market_maker_mon.tf` (composite `mktmkr_unhealthy`)
- Keeper: `05_perps_keeper_mon.tf` (composite `keeper_unhealthy`)
