#!/usr/bin/env bash
set -euo pipefail
# Old Android images have no getconf. New 16 KB images expose the effective page size
# there, including x86_64's simulated 16 KB userspace, so prefer it over smaps.
page_size=$(adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r') || page_size=''
if [[ -z "$page_size" ]]; then
  page_size=$(adb shell cat /proc/self/smaps | awk '/KernelPageSize:/ {print $2 * 1024; exit}')
fi
echo "Android page size: $page_size (expected $1)"
test "$page_size" = "$1"
