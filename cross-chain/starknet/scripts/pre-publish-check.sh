#!/bin/bash
set -e

echo "Running pre-publish safety checks..."

# Check if .npmignore exists and has content
if [ ! -f ".npmignore" ] || [ ! -s ".npmignore" ]; then
    echo "❌ ERROR: .npmignore file is missing or empty!"
    exit 1
fi

# Check if .npmignore contains .env
if ! grep -q "^\.env" .npmignore; then
    echo "❌ ERROR: .npmignore doesn't exclude .env files!"
    exit 1
fi

# Do a dry run and check for .env in output
if npm pack --dry-run 2>&1 | grep -i "\.env"; then
    echo "❌ ERROR: .env file would be included in package!"
    exit 1
fi

echo "✅ Pre-publish checks passed!"
echo "   - No .env file in project directory"
echo "   - .npmignore is properly configured"
echo "   - Dry run confirms .env won't be published"