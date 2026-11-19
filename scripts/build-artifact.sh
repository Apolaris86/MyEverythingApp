#!/usr/bin/env bash
# Builds a body-only copy of index.html for previewing as a Claude artifact.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
sed -n '/<!--APP-START-->/,/<!--APP-END-->/p' index.html | grep -v -e '^<!--APP-' -e '^</head>$' -e '^<body>$' > dist/artifact.html
echo "wrote dist/artifact.html"
