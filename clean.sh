#!/bin/bash
set -euo pipefail

echo "Cleaning base directory and tools..."

# Installation directories
rm -rf ./node_modules/
rm -rf ./tools/pkglint/node_modules/

# Build files
if [ -f .BUILD_COMPLETED ]; then
    rm .BUILD_COMPLETED
fi

# Packaging directory
rm -rf ./dist

# Integ test directory
rm -rf "./integ/stage"
rm -rf "./integ/.e2etemp"

echo "Done"
