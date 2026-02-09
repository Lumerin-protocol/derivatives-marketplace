################################################################################
# APP-SPECIFIC GLOBAL LOOKUPS (data files, dns, iam, etc...)
################################################################################

################################################################################
# DEVOPS/BEDROCK SOURCE INFO
################################################################################

################################
# WAF Protection - for Cloudfront (Global Scope)
################################
data "aws_wafv2_web_acl" "bedrock_waf_cloudfront" {
  provider = aws.use1
  name     = "waf-bedrock-cloudfront"
  scope    = "CLOUDFRONT"
}

################################
# DNS Lookups 
################################

# Find the Route53 Zone for root lumerin.io 
data "aws_route53_zone" "public_lumerin_root" {
  provider     = aws.titanio-prd
  name         = "lumerin.io"
  private_zone = false
}

data "aws_route53_zone" "public_lumerin" {
  provider     = aws.use1
  name         = "${substr(var.account_shortname, 8, 3)}.lumerin.io"
  private_zone = false
}
