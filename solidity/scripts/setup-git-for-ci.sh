#!/bin/bash

# Script to set up git configuration for CI environments
# This ensures that GitHub repositories are accessed via HTTPS instead of SSH

echo "Setting up git configuration for CI..."

# Force HTTPS for GitHub URLs
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Force HTTPS for all git URLs
git config --global url."https://".insteadOf "git://"

echo "Git configuration updated successfully!"
echo "GitHub URLs will now use HTTPS instead of SSH"
