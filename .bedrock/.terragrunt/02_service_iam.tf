# Create the IAM Role
resource "aws_iam_role" "derivatives_marketplace" {
  count              = var.create_core ? 1 : 0
  provider           = aws.use1
  name               = "${local.shortname}-cw-role"
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "ecs.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name = "Bedrock${local.shortname} IAM Role",
      Capability = "Bedrock IAM Role",
    },
  )
}



