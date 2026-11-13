#!/bin/bash
# Cập nhật code mới nhất từ GitHub rồi cài lại. Chạy: sudo bash deploy/update.sh
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
bash deploy/install.sh
