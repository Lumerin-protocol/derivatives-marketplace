variable "create_core" {
  description = "Decide whether or not to create the core resources"
  type        = bool
  default     = false
}

variable "ecs_cluster" {
  description = "ECS Cluster Variables"
  type    = map(any)
  default = {}
}

variable "perpskeeper_service" {
  description = "PerpsKeeper Service Variables"
  type    = map(any)
  default = {}
}

variable "perpskeeper_private_key" {
  description = "Private key for the PerpsKeeper"
  type        = string
  sensitive   = true
  default     = ""
}

################################################################################
# SHARED INFRASTRUCTURE (used across multiple services)
################################################################################

variable "ethereum_rpc_url" {
  description = "Ethereum RPC URL (used by keeper)"
  type        = string
  sensitive   = true
  default     = ""
}

################################################################################
# THE GRAPH NETWORK CONFIGURATION
# API key and subgraph IDs for querying published subgraphs
################################################################################

variable "graph_api_key" {
  description = "The Graph API Key for accessing published subgraphs"
  type        = string
  sensitive   = true
  default     = ""
}

variable "derivatives_subgraph_id" {
  description = "The Graph Subgraph ID for Derivatives (from published subgraph)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "oracles_subgraph_id" {
  description = "The Graph Subgraph ID for Oracles (from published subgraph)"
  type        = string
  sensitive   = true
  default     = ""
}

################################################################################
# SHARED CONTRACT ADDRESSES (used across multiple services)
################################################################################

variable "clone_factory_address" {
  description = "Clone Factory contract address (used by indexer)"
  type        = string
  default     = ""
}

variable "hashrate_oracle_address" {
  description = "Hashrate Oracle contract address (used by oracle lambda, indexer, and margin call)"
  type        = string
  default     = ""
}

variable "perps_address" {
  description = "Perpetuals contract address "
  type        = string
  default     = ""
}

variable "multicall_address" {
  description = "Multicall3 contract address (same address on all EVM chains)"
  type        = string
  default     = ""
}


################################################################################
# MONITORING CONFIGURATION
################################################################################
# TBD


################################################################################
# Common Account Variables
################################################################################
variable "account_shortname" { description = "Code describing customer  and lifecycle. E.g., mst, sbx, dev, stg, prd" }
variable "account_lifecycle" {
  description = "environment lifecycle, can be 'prod', 'nonprod', 'sandbox'...dev and stg are considered nonprod"
  type        = string
}
variable "account_number" {}
variable "default_region" {}
variable "region_shortname" {
  description = "Region 4 character shortname"
  default     = "use1"
}
variable "vpc_index" {}
variable "devops_keypair" {}
variable "titanio_net_edge_vpn" {}
variable "protect_environment" {}
variable "ecs_task_role_arn" {}
variable "default_tags" {
  description = "Default tag values common across all resources in this account. Values can be overridden when configuring a resource or module."
  type        = map(string)
}
variable "foundation_tags" {
  description = "Default Tags for Bedrock Foundation resources"
  type        = map(string)
}
variable "provider_profile" {
  description = "Provider config added for use in aws_config.tf"
}
