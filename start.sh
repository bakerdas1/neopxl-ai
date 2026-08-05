#!/bin/bash
cd "$(dirname "$0")"
export TESSDATA_PREFIX="$(pwd)"
exec node server.mjs
