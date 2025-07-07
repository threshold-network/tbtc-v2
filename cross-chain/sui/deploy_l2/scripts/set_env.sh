#!/bin/bash

# This script helps set up the environment for running the initialization

echo "🔐 Setting up environment for Gateway V2 initialization"
echo ""
echo "Please enter your SUI private key (hex format, without 0x prefix):"
echo "You can get this from: sui keytool export --key-scheme ed25519"
echo ""
read -s -p "Private key: " PRIVATE_KEY
echo ""

export SUI_PRIVATE_KEY=$PRIVATE_KEY

echo "✅ Environment set up!"
echo ""
echo "Now you can run the initialization:"
echo "node scripts/dist/initialize_gateway_v2_ptb.js"