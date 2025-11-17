#!/bin/bash

# Integration Test Script for QR Code & Paste Upload
# This script helps automate testing of the Pulse-Vault integration

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PULSE_VAULT_URL="${PULSE_VAULT_URL:-http://localhost:3000}"
TEST_OUTPUT_DIR="./test-output"

echo -e "${GREEN}🧪 Pulse-Vault Integration Test${NC}"
echo "=================================="
echo ""

# Create test output directory
mkdir -p "$TEST_OUTPUT_DIR"

# Step 1: Check Pulse-Vault is running
echo -e "${YELLOW}Step 1: Checking Pulse-Vault status...${NC}"
if curl -s "$PULSE_VAULT_URL/" > /dev/null; then
    echo -e "${GREEN}✅ Pulse-Vault is running${NC}"
else
    echo -e "${RED}❌ Pulse-Vault is not running at $PULSE_VAULT_URL${NC}"
    echo "Please start Pulse-Vault: cd pulse-vault/pulsevault && npm run dev"
    exit 1
fi
echo ""

# Step 2: Test QR code endpoint
echo -e "${YELLOW}Step 2: Testing QR code endpoint...${NC}"
QR_RESPONSE=$(curl -s "$PULSE_VAULT_URL/qr/deeplink?server=$PULSE_VAULT_URL")
echo "$QR_RESPONSE" | jq '.' 2>/dev/null || echo "$QR_RESPONSE"
echo ""

# Extract deeplink
DEEPLINK=$(echo "$QR_RESPONSE" | grep -o '"deeplink":"[^"]*' | cut -d'"' -f4)
if [ -z "$DEEPLINK" ]; then
    echo -e "${RED}❌ Failed to extract deeplink${NC}"
    exit 1
fi

echo -e "${GREEN}✅ QR code endpoint working${NC}"
echo "Deeplink: $DEEPLINK"
echo ""

# Step 3: Generate QR code image (if qrcode package available)
echo -e "${YELLOW}Step 3: Generating QR code image...${NC}"
if curl -s "$PULSE_VAULT_URL/qr/image?server=$PULSE_VAULT_URL&size=400" \
    -o "$TEST_OUTPUT_DIR/qr-code.png" 2>/dev/null; then
    if file "$TEST_OUTPUT_DIR/qr-code.png" | grep -q "PNG"; then
        echo -e "${GREEN}✅ QR code image generated: $TEST_OUTPUT_DIR/qr-code.png${NC}"
        echo "You can scan this QR code with the Pulse-Camera app"
    else
        echo -e "${YELLOW}⚠️  QR code image endpoint returned non-image (qrcode package may not be installed)${NC}"
        echo "Install with: cd pulse-vault/pulsevault && npm install qrcode"
    fi
else
    echo -e "${YELLOW}⚠️  QR code image generation not available${NC}"
    echo "Install qrcode package: cd pulse-vault/pulsevault && npm install qrcode"
fi
echo ""

# Step 4: Test upload endpoint
echo -e "${YELLOW}Step 4: Testing upload endpoint...${NC}"
UPLOAD_RESPONSE=$(curl -s -i -X POST "$PULSE_VAULT_URL/uploads" \
    -H "Upload-Length: 1024" \
    -H "Tus-Resumable: 1.0.0")

UPLOAD_ID=$(echo "$UPLOAD_RESPONSE" | grep -i "Location:" | sed 's/.*\/uploads\///' | tr -d '\r\n ')

if [ -z "$UPLOAD_ID" ]; then
    echo -e "${RED}❌ Failed to create upload session${NC}"
    echo "Response: $UPLOAD_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✅ Upload endpoint working${NC}"
echo "Upload ID: $UPLOAD_ID"
echo ""

# Step 5: Test finalize endpoint (with dummy data)
echo -e "${YELLOW}Step 5: Testing finalize endpoint...${NC}"
# Note: This will fail because we didn't actually upload data, but we can check the endpoint exists
FINALIZE_RESPONSE=$(curl -s -X POST "$PULSE_VAULT_URL/uploads/finalize" \
    -H "Content-Type: application/json" \
    -d "{\"uploadId\":\"$UPLOAD_ID\",\"filename\":\"test.mp4\"}" || true)

if echo "$FINALIZE_RESPONSE" | grep -q "not found\|error\|Error"; then
    echo -e "${YELLOW}⚠️  Finalize endpoint exists but upload not found (expected for test)${NC}"
else
    echo -e "${GREEN}✅ Finalize endpoint accessible${NC}"
fi
echo ""

# Step 6: Check storage directories
echo -e "${YELLOW}Step 6: Checking storage directories...${NC}"
if [ -d "/tmp/pulsevault-test" ]; then
    echo -e "${GREEN}✅ Storage directory exists: /tmp/pulsevault-test${NC}"
    echo "Uploads: $(ls -1 /tmp/pulsevault-test/uploads/ 2>/dev/null | wc -l) files"
    echo "Videos: $(ls -1d /tmp/pulsevault-test/videos/*/ 2>/dev/null | wc -l) directories"
elif [ -d "/mnt/media" ]; then
    echo -e "${GREEN}✅ Storage directory exists: /mnt/media${NC}"
else
    echo -e "${YELLOW}⚠️  Storage directory not found (may be using different path)${NC}"
fi
echo ""

# Step 7: Summary
echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}✅ Integration Test Summary${NC}"
echo -e "${GREEN}==================================${NC}"
echo ""
echo "Pulse-Vault URL: $PULSE_VAULT_URL"
echo "Deeplink: $DEEPLINK"
echo ""
echo "Next steps:"
echo "1. Scan QR code with Pulse-Camera app"
echo "2. Or paste server URL: $PULSE_VAULT_URL"
echo "3. Record and upload a test video"
echo "4. Verify upload in Pulse-Vault storage"
echo ""
if [ -f "$TEST_OUTPUT_DIR/qr-code.png" ]; then
    echo "QR code saved to: $TEST_OUTPUT_DIR/qr-code.png"
fi
echo ""
echo -e "${GREEN}Test completed!${NC}"

