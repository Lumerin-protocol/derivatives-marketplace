################################
# Regional DATA LOOKUPS 
################################

data "aws_vpc" "use1_1" {
  provider = aws.use1
  tags = {
    Name = "vpc-${var.region_shortname}-${var.vpc_index}-${var.account_shortname}"
  }
}
data "aws_internet_gateway" "use1_1" {
  provider = aws.use1
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.use1_1.id]
  }
}

data "aws_subnet" "edge_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-edge-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.edge_use1_1 : n.id]
}

data "aws_subnet" "middle_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-middle-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.middle_use1_1 : n.id]
}

data "aws_subnet" "private_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-private-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.private_use1_1 : n.id]
}

data "aws_subnet" "edge_use1_1a" {
  provider = aws.use1
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-edge-1"]
  }
}

data "aws_subnet" "middle_use1_1a" {
  provider = aws.use1
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-middle-1"]
  }
}

# Find the xxx.Lumerin.io Certificate created in foundation-extra
data "aws_acm_certificate" "lumerin_marketplace_ext" {
  provider    = aws.use1
  # domain      = var.account_lifecycle == "prd" ? data.aws_route53_zone.public_lumerin_root.name : data.aws_route53_zone.public_lumerin.name
  domain      = data.aws_route53_zone.public_lumerin.name
  types       = ["AMAZON_ISSUED"]
  most_recent = true
}

# Find the xxx.Lumerin.io Certificate created in foundation-extra
data "aws_acm_certificate" "lumerin_marketplace_website" {
  provider    = aws.use1
  domain      = var.account_lifecycle == "prd" ? data.aws_route53_zone.public_lumerin_root.name : data.aws_route53_zone.public_lumerin.name
  types       = ["AMAZON_ISSUED"]
  most_recent = true
}

################################
# WAF Protection 
################################
data "aws_wafv2_web_acl" "bedrock_waf_use1_1" {
  provider = aws.use1
  name     = "waf-bedrock-use1-1"
  scope    = "REGIONAL"
}