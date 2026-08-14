#!/bin/sh
# 服务器每日冷备（配合 deploy.md 的 cron 条目）：
#   10 3 * * * /opt/homeassistant/deploy/backup-cron.sh >> /var/log/homeassistant-backup.log 2>&1
cd /opt/homeassistant || exit 1
/usr/bin/docker compose exec -T api npm run backup
