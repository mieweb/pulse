#!/bin/bash

# Simple Deeplink Test Script
# Tests deeplink generation and provides easy way to test in app

# Don't exit on error - we want to provide helpful feedback
set +e

# Configuration
# Try to detect local network IP for physical device testing
LOCAL_IP=$(ifconfig 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1 || echo "")
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
fi

# Use provided URL, or try local IP, or fallback to localhost
if [ -n "$PULSEVAULT_URL" ]; then
  SERVER_URL="$PULSEVAULT_URL"
  echo "📡 Using provided PULSEVAULT_URL: $SERVER_URL"
  if [ -n "$LOCAL_IP" ]; then
    echo "   💡 Your current network IP: $LOCAL_IP"
    echo "   💡 If server is on this network, try: http://${LOCAL_IP}:3000"
  fi
  echo ""
elif [ -n "$LOCAL_IP" ]; then
  SERVER_URL="http://${LOCAL_IP}:3000"
  echo "📡 Detected local IP: $LOCAL_IP"
  echo "   Using: $SERVER_URL (works on physical devices)"
  echo ""
else
  SERVER_URL="http://localhost:3000"
  echo "⚠️  Using localhost - this won't work on physical devices!"
  echo "   Set PULSEVAULT_URL=http://YOUR_IP:3000 for device testing"
  echo ""
fi

TEST_USER="test-user-$(date +%s)"

echo "🧪 Pulse Deeplink Test"
echo "======================"
echo ""

# Check if server is running
echo "1️⃣  Checking server connectivity..."
SERVER_REACHABLE=false
if curl -s --connect-timeout 3 --max-time 5 "$SERVER_URL/health" > /dev/null 2>&1; then
  SERVER_REACHABLE=true
elif curl -s --connect-timeout 3 --max-time 5 "$SERVER_URL/" > /dev/null 2>&1; then
  SERVER_REACHABLE=true
fi

if [ "$SERVER_REACHABLE" = false ]; then
  echo "   ❌ Server not reachable at $SERVER_URL"
  echo ""
  echo "   Possible issues:"
  echo "   - Server is not running"
  echo "   - You're on a different network than the server"
  echo "   - Firewall blocking the connection"
  echo "   - Wrong IP address or port"
  echo ""
  if [ -n "$LOCAL_IP" ]; then
    echo "   💡 Your current network IP: $LOCAL_IP"
    echo "   💡 Try: PULSEVAULT_URL=http://${LOCAL_IP}:3000 ./test-deeplink.sh $*"
    echo ""
  fi
  echo "   Troubleshooting:"
  echo "   1. Check if PulseVault is running:"
  echo "      cd pulse-vault && docker-compose ps"
  echo ""
  echo "   2. If server is on a different network, you may need to:"
  echo "      - Use a VPN to connect to the server's network"
  echo "      - Use a public URL if the server is exposed"
  echo "      - Update PULSEVAULT_URL to the correct address"
  echo "      - Find the server's IP on its network and use that"
  echo ""
  echo "   3. To start the server:"
  echo "      cd pulse-vault && docker-compose up -d"
  echo ""
  echo "   4. To find the server's IP (run on the server machine):"
  echo "      ifconfig | grep 'inet ' | grep -v 127.0.0.1"
  echo ""
  echo "   ⚠️  Continuing anyway - deeplink generation will fail but you can test with existing deeplinks"
  echo ""
  read -p "   Continue anyway? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
else
  echo "   ✅ Server is reachable"
  echo ""
fi

# Generate deeplink without draft ID
echo "2️⃣  Generating deeplink (new recording)..."
RESPONSE=$(curl -s "$SERVER_URL/qr/deeplink?userId=$TEST_USER&server=$SERVER_URL")
DEEPLINK=$(echo "$RESPONSE" | jq -r '.deeplink' 2>/dev/null || echo "")

if [ -z "$DEEPLINK" ] || [ "$DEEPLINK" = "null" ]; then
  echo "   ❌ Failed to generate deeplink"
  echo "   Response: $RESPONSE"
  exit 1
fi

echo "   ✅ Deeplink generated"
echo ""
echo "📱 Deeplink:"
echo "   $DEEPLINK"
echo ""

# Generate QR code image if possible
echo "3️⃣  Generating QR code image..."
HTTP_CODE=$(curl -s -o /tmp/pulse-qr.png -w "%{http_code}" "$SERVER_URL/qr/image?userId=$TEST_USER&server=$SERVER_URL&size=400" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  # Verify it's a valid PNG
  if file /tmp/pulse-qr.png 2>/dev/null | grep -q "PNG\|image"; then
    echo "   ✅ QR code saved to /tmp/pulse-qr.png"
    
    # Try to open QR code
    if command -v open >/dev/null 2>&1; then
      if open /tmp/pulse-qr.png 2>/dev/null; then
        echo "   📱 QR code opened - scan with your phone"
      else
        echo "   📱 QR code saved to /tmp/pulse-qr.png (open manually: open /tmp/pulse-qr.png)"
      fi
    elif command -v xdg-open >/dev/null 2>&1; then
      if xdg-open /tmp/pulse-qr.png 2>/dev/null; then
        echo "   📱 QR code opened - scan with your phone"
      else
        echo "   📱 QR code saved to /tmp/pulse-qr.png (open manually)"
      fi
    else
      echo "   📱 QR code saved to /tmp/pulse-qr.png (open manually)"
    fi
  else
    echo "   ⚠️  QR code file is not a valid image"
    echo "   Response might be JSON error - check if qrcode package is installed on server"
    echo "   Run: cd pulse-vault/pulsevault && npm install qrcode"
    rm -f /tmp/pulse-qr.png
  fi
elif [ "$HTTP_CODE" = "501" ]; then
  echo "   ⚠️  QR image generation not available (install qrcode package on server)"
  echo "   Run: cd pulse-vault/pulsevault && npm install qrcode"
  rm -f /tmp/pulse-qr.png
else
  echo "   ⚠️  QR image generation failed (HTTP $HTTP_CODE)"
  echo "   You can still use the deeplink URL above"
  rm -f /tmp/pulse-qr.png
fi
echo ""

# Test with draft ID if provided
if [ -n "$1" ]; then
  DRAFT_ID="$1"
  echo "4️⃣  Generating deeplink with draft ID: $DRAFT_ID..."
  RESPONSE2=$(curl -s "$SERVER_URL/qr/deeplink?draftId=$DRAFT_ID&userId=$TEST_USER&server=$SERVER_URL")
  DEEPLINK2=$(echo "$RESPONSE2" | jq -r '.deeplink' 2>/dev/null || echo "")
  
  if [ -n "$DEEPLINK2" ] && [ "$DEEPLINK2" != "null" ]; then
    echo "   ✅ Deeplink with draft ID generated"
    echo ""
    echo "📱 Deeplink (with draft):"
    echo "   $DEEPLINK2"
    echo ""
    DEEPLINK="$DEEPLINK2"
  fi
fi

# Provide testing instructions
echo "🧪 Testing Instructions"
echo "======================"
echo ""
echo "Option 1: iOS Simulator"
echo "   xcrun simctl openurl booted \"$DEEPLINK\""
echo ""
echo "Option 2: Android Emulator"
echo "   adb shell am start -W -a android.intent.action.VIEW -d \"$DEEPLINK\""
echo ""
echo "Option 3: Physical Device"
echo "   1. Scan QR code: /tmp/pulse-qr.png"
echo "   2. Or copy deeplink above and open in browser"
echo ""
echo "Option 4: Expo CLI"
echo "   npx uri-scheme open \"$DEEPLINK\" --ios"
echo "   npx uri-scheme open \"$DEEPLINK\" --android"
echo ""

# Auto-open if on macOS with iOS simulator
if [[ "$OSTYPE" == "darwin"* ]]; then
  BOOTED_DEVICE=$(xcrun simctl list devices | grep "Booted" | head -1 | grep -oE '\([A-F0-9-]+\)' | tr -d '()')
  if [ -n "$BOOTED_DEVICE" ]; then
    echo "🚀 Auto-opening in iOS Simulator..."
    xcrun simctl openurl "$BOOTED_DEVICE" "$DEEPLINK" 2>/dev/null || xcrun simctl openurl booted "$DEEPLINK" 2>/dev/null
    echo "   ✅ Opened!"
  fi
fi

echo ""
echo "✅ Test ready! Check your app for:"
echo "   - App opens in upload mode"
echo "   - Draft loads (if draft ID provided)"
echo "   - Server/token stored in AsyncStorage"
echo ""

