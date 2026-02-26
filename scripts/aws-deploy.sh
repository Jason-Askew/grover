#!/usr/bin/env bash
# Provision a single EC2 Spot instance for Grover.
# Creates: security group, key pair (if needed), Spot instance, Elastic IP.
#
# Usage:
#   ./scripts/aws-deploy.sh --domain grover.example.com --key-name my-key [options]
#
# Options:
#   --domain DOMAIN       Domain name for HTTPS (required)
#   --key-name NAME       EC2 key pair name (required)
#   --region REGION        AWS region (default: ap-southeast-2)
#   --instance-type TYPE   Instance type (default: t3.medium)
#   --volume-size GB       Root volume size (default: 30)
#   --my-ip CIDR           SSH source CIDR (default: auto-detect/32)
#   --name TAG             Instance Name tag (default: grover)
#   --arch ARCH            Architecture: amd64 or arm64 (default: amd64)

set -euo pipefail

# ── Defaults ──
REGION="ap-southeast-2"
INSTANCE_TYPE="t3.medium"
VOLUME_SIZE=30
NAME="grover"
ARCH="amd64"
DOMAIN=""
KEY_NAME=""
MY_IP=""

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --key-name)   KEY_NAME="$2"; shift 2 ;;
    --region)     REGION="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --volume-size) VOLUME_SIZE="$2"; shift 2 ;;
    --my-ip)      MY_IP="$2"; shift 2 ;;
    --name)       NAME="$2"; shift 2 ;;
    --arch)       ARCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$KEY_NAME" ]]; then
  echo "Usage: $0 --domain grover.example.com --key-name my-key [options]"
  exit 1
fi

# ── Auto-detect public IP for SSH ──
if [[ -z "$MY_IP" ]]; then
  MY_IP="$(curl -s https://checkip.amazonaws.com)/32"
  echo "Detected your IP: $MY_IP"
fi

export AWS_DEFAULT_REGION="$REGION"

echo "=== Grover AWS Deploy ==="
echo "  Region:    $REGION"
echo "  Domain:    $DOMAIN"
echo "  Instance:  $INSTANCE_TYPE"
echo "  Volume:    ${VOLUME_SIZE}GB gp3"
echo "  Key pair:  $KEY_NAME"
echo "  SSH from:  $MY_IP"
echo ""

# ── 1. Look up Ubuntu 24.04 AMI ──
echo "Looking up Ubuntu 24.04 LTS AMI ($ARCH)..."

if [[ "$ARCH" == "arm64" ]]; then
  AMI_ARCH="arm64"
else
  AMI_ARCH="amd64"
fi

AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${AMI_ARCH}-server-*" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text)

if [[ "$AMI_ID" == "None" || -z "$AMI_ID" ]]; then
  echo "ERROR: Could not find Ubuntu 24.04 AMI for $ARCH in $REGION"
  exit 1
fi
echo "  AMI: $AMI_ID"

# ── 2. Create security group ──
echo "Creating security group..."

VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  echo "ERROR: No default VPC found in $REGION. Create one or specify a VPC."
  exit 1
fi

SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=${NAME}-sg" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID=$(aws ec2 create-security-group \
    --group-name "${NAME}-sg" \
    --description "Grover: SSH + HTTP + HTTPS" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP,Description=SSH}]" \
      "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP}]" \
      "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTPS}]" \
    > /dev/null
  echo "  Created: $SG_ID"
else
  echo "  Exists: $SG_ID"
fi

# ── 3. Verify key pair exists ──
KEY_EXISTS=$(aws ec2 describe-key-pairs --key-names "$KEY_NAME" --query 'KeyPairs[0].KeyName' --output text 2>/dev/null || echo "None")
if [[ "$KEY_EXISTS" == "None" ]]; then
  echo "ERROR: Key pair '$KEY_NAME' not found in $REGION."
  echo "Create one with: aws ec2 create-key-pair --key-name $KEY_NAME --query KeyMaterial --output text > ${KEY_NAME}.pem"
  exit 1
fi

# ── 4. Launch Spot instance ──
echo "Launching Spot instance..."

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"persistent","InstanceInterruptionBehavior":"stop"}}' \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)

echo "  Instance: $INSTANCE_ID"
echo "  Waiting for running state..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# ── 5. Allocate and associate Elastic IP ──
echo "Allocating Elastic IP..."
ALLOC_ID=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)

aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" > /dev/null
echo "  Elastic IP: $EIP"

# ── 6. Wait for SSH ──
echo "Waiting for SSH to become available..."
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "${KEY_NAME}.pem" "ubuntu@${EIP}" true 2>/dev/null; then
    break
  fi
  sleep 10
done

# ── Done ──
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "  Instance:   $INSTANCE_ID"
echo "  Elastic IP: $EIP"
echo "  SSH:        ssh -i ${KEY_NAME}.pem ubuntu@${EIP}"
echo ""
echo "Next steps:"
echo "  1. Point DNS for $DOMAIN to $EIP"
echo "  2. Copy setup script to instance:"
echo "     scp -i ${KEY_NAME}.pem scripts/aws-setup-instance.sh ubuntu@${EIP}:~/"
echo "  3. SSH in and run setup:"
echo "     ssh -i ${KEY_NAME}.pem ubuntu@${EIP}"
echo "     chmod +x aws-setup-instance.sh"
echo "     ./aws-setup-instance.sh --domain $DOMAIN --repo <your-repo-url>"
echo ""
echo "Saved deployment info to .aws-deploy.json"

cat > .aws-deploy.json << EOF
{
  "region": "$REGION",
  "instanceId": "$INSTANCE_ID",
  "elasticIp": "$EIP",
  "allocationId": "$ALLOC_ID",
  "securityGroupId": "$SG_ID",
  "keyName": "$KEY_NAME",
  "domain": "$DOMAIN",
  "amiId": "$AMI_ID"
}
EOF
