"""Goldsky index monitor.

Checks that the subgraph answers, the indexed head is close to the chain,
indexing has not failed, and the entity the app reads is present. Drift is
chain head minus the block Goldsky is serving. A null block timestamp is
filled from that block on the chain, so a catch-up is not recorded as fresh.
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
CHAIN_ID = int(os.environ.get("CHAIN_ID", "0") or "0")

# Public endpoints. The monitor must not carry an Alchemy key.
PUBLIC_RPC = {
    8453: (
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
    ),
    84532: (
        "https://sepolia.base.org",
        "https://base-sepolia-rpc.publicnode.com",
    ),
}

cloudwatch = boto3.client("cloudwatch")

ORDERS_QUERY = """
{
  _meta { block { number timestamp } hasIndexingErrors }
  orders(first: 1) { id }
  trades(first: 1, orderBy: timestamp, orderDirection: desc) { timestamp }
}
"""

PERPS_QUERY = """
{
  _meta { block { number timestamp } hasIndexingErrors }
  perps(id: "0") { id }
  fundingUpdates(first: 1, orderBy: timestamp, orderDirection: desc) { timestamp }
}
"""


def post_json(url, payload, timeout=20):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "hashpower-subgraph-monitor",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def query_subgraph(url, query):
    start = time.time()
    try:
        body = post_json(url, {"query": query}, timeout=30)
        return body, int((time.time() - start) * 1000)
    except Exception as exc:
        print(f"query failed: {exc}")
        return None, int((time.time() - start) * 1000)


def rpc(method, params):
    urls = PUBLIC_RPC.get(CHAIN_ID, ())
    if not urls:
        print(f"no public RPC for chain {CHAIN_ID}")
        return None
    last = None
    for url in urls:
        try:
            body = post_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            if body.get("error"):
                last = body["error"]
                continue
            return body.get("result")
        except Exception as exc:
            last = exc
            print(f"rpc {method} failed: {exc}")
    print(f"rpc {method} unavailable: {last}")
    return None


def chain_head():
    result = rpc("eth_blockNumber", [])
    if not result:
        return 0
    try:
        return int(result, 16)
    except (TypeError, ValueError):
        return 0


def block_timestamp(number):
    # Goldsky often leaves _meta.block.timestamp null while a deployment is catching up.
    result = rpc("eth_getBlockByNumber", [hex(number), False])
    if not isinstance(result, dict):
        return 0
    raw = result.get("timestamp")
    if not raw:
        return 0
    try:
        return int(raw, 16)
    except (TypeError, ValueError):
        return 0


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
    age_seconds = None
    blocks_behind = None
    entity_present = 0
    activity_age = 0

    if result and "errors" not in result:
        available = 1
        data = result.get("data") or {}
        meta = data.get("_meta") or {}
        block = meta.get("block") or {}
        indexed = as_int(block.get("number"))
        indexing_errors = 1 if meta.get("hasIndexingErrors") else 0
        block_ts = as_int(block.get("timestamp"))
        head = chain_head()
        if head > 0 and indexed > 0:
            blocks_behind = max(0, head - indexed)
        if block_ts <= 0 and indexed > 0:
            block_ts = block_timestamp(indexed)
        if block_ts > 0:
            age_seconds = max(0, int(time.time()) - block_ts)
        if ENTITY_KIND == "perps":
            entity_present = 1 if data.get("perps") else 0
            updates = data.get("fundingUpdates") or []
        else:
            entity_present = 1 if data.get("orders") else 0
            updates = data.get("trades") or []
        activity_ts = as_int(updates[0].get("timestamp")) if updates else 0
        activity_age = (int(time.time()) - activity_ts) if activity_ts > 0 else 0
        print(
            f"available indexed={indexed} head={head} behind={blocks_behind} "
            f"age={age_seconds}s errors={indexing_errors} "
            f"entity={entity_present} activity_age={activity_age}s"
        )
    else:
        print(f"unavailable ({response_ms}ms) {result}")

    metrics = [
        ("subgraph_available", available, dimensions, "Count"),
        ("subgraphs_available", available, env_dimensions, "Count"),
        ("subgraph_response_time_ms", response_ms, dimensions, "Milliseconds"),
        ("subgraph_indexing_errors", indexing_errors, dimensions, "Count"),
        ("subgraph_entity_present", entity_present, dimensions, "Count"),
        ("subgraph_latest_activity_age_seconds", activity_age, dimensions, "Seconds"),
    ]
    if age_seconds is not None:
        metrics.append(("subgraph_data_age_seconds", age_seconds, dimensions, "Seconds"))
    if blocks_behind is not None:
        metrics.append(("subgraph_blocks_behind", blocks_behind, dimensions, "Count"))

    cloudwatch.put_metric_data(
        Namespace=CW_NAMESPACE,
        MetricData=[
            {
                "MetricName": name,
                "Value": value,
                "Unit": unit,
                "Dimensions": dims,
            }
            for name, value, dims, unit in metrics
        ],
    )
    return {
        "available": available,
        "entityPresent": entity_present,
        "ageSeconds": age_seconds,
        "blocksBehind": blocks_behind,
    }
