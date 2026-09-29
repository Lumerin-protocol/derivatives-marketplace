"""Goldsky index monitor.

Checks that the subgraph answers, the indexed chain head is fresh, indexing
has not failed, and the entity the app reads is present. Newest trade or
funding age is published for later dashboards and is not an alarm.
"""

import json
import os
import time
import urllib.request
from datetime import datetime

import boto3

GS_URL = os.environ.get("GS_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "SubgraphIndex")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")
SUBGRAPH_NAME = os.environ.get("SUBGRAPH_NAME", "subgraph")
# "orders" requires at least one Order. "perps" requires the Perps singleton.
ENTITY_KIND = os.environ.get("ENTITY_KIND", "orders")

cloudwatch = boto3.client("cloudwatch")

ORDERS_QUERY = """
{
  _meta { block { timestamp } hasIndexingErrors }
  orders(first: 1) { id }
  trades(first: 1, orderBy: timestamp, orderDirection: desc) { timestamp }
}
"""

PERPS_QUERY = """
{
  _meta { block { timestamp } hasIndexingErrors }
  perps(id: "0") { id }
  fundingUpdates(first: 1, orderBy: timestamp, orderDirection: desc) { timestamp }
}
"""


def query_subgraph(url, query):
    start = time.time()
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({"query": query}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "hashpower-subgraph-monitor",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
        return body, int((time.time() - start) * 1000)
    except Exception as exc:
        print(f"query failed: {exc}")
        return None, int((time.time() - start) * 1000)


def as_int(value):
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def lambda_handler(event, context):
    print(f"subgraph index check {SUBGRAPH_NAME} {ENVIRONMENT} {datetime.now().isoformat()}")
    dimensions = [
        {"Name": "Environment", "Value": ENVIRONMENT},
        {"Name": "Subgraph", "Value": SUBGRAPH_NAME},
    ]
    env_dimensions = [{"Name": "Environment", "Value": ENVIRONMENT}]
    query = PERPS_QUERY if ENTITY_KIND == "perps" else ORDERS_QUERY
    result, response_ms = query_subgraph(GS_URL, query)

    available = 0
    indexing_errors = 0
    age_seconds = 0
    entity_present = 0
    activity_age = 0

    if result and "errors" not in result:
        available = 1
        data = result.get("data") or {}
        meta = data.get("_meta") or {}
        block = meta.get("block") or {}
        block_ts = as_int(block.get("timestamp"))
        indexing_errors = 1 if meta.get("hasIndexingErrors") else 0
        age_seconds = (int(time.time()) - block_ts) if block_ts > 0 else 0
        if ENTITY_KIND == "perps":
            entity_present = 1 if data.get("perps") else 0
            updates = data.get("fundingUpdates") or []
        else:
            entity_present = 1 if data.get("orders") else 0
            updates = data.get("trades") or []
        activity_ts = as_int(updates[0].get("timestamp")) if updates else 0
        activity_age = (int(time.time()) - activity_ts) if activity_ts > 0 else 0
        print(
            f"available age={age_seconds}s errors={indexing_errors} "
            f"entity={entity_present} activity_age={activity_age}s"
        )
    else:
        print(f"unavailable ({response_ms}ms) {result}")

    metrics = [
        ("subgraph_available", available, dimensions),
        ("subgraphs_available", available, env_dimensions),
        ("subgraph_response_time_ms", response_ms, dimensions),
        ("subgraph_indexing_errors", indexing_errors, dimensions),
        ("subgraph_data_age_seconds", age_seconds, dimensions),
        ("subgraph_entity_present", entity_present, dimensions),
        ("subgraph_latest_activity_age_seconds", activity_age, dimensions),
    ]
    cloudwatch.put_metric_data(
        Namespace=CW_NAMESPACE,
        MetricData=[
            {
                "MetricName": name,
                "Value": value,
                "Unit": "Count" if "age" not in name and "time" not in name else "Seconds" if "age" in name else "Milliseconds",
                "Dimensions": dims,
            }
            for name, value, dims in metrics
        ],
    )
    return {"available": available, "entityPresent": entity_present, "ageSeconds": age_seconds}
