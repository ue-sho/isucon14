#!/usr/bin/env bash
set -euo pipefail

# Validate before moving files; do not interrupt the services.
sudo -n nginx -t
mysql_log=$(sudo -n mysql -NBe 'SELECT @@global.slow_query_log_file')
if [[ "$mysql_log" != /var/log/mysql/mysql-slow.log ]]; then
  echo "Unexpected MySQL slow log path: $mysql_log" >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%S.%NZ)
for log in /var/log/nginx/access.log /var/log/nginx/access.ltsv; do
  if sudo -n test -f "$log"; then
    sudo -n mv -- "$log" "$log.$stamp"
    echo "Archived: $log.$stamp"
  fi
done
sudo -n nginx -s reopen

if sudo -n test -f "$mysql_log"; then
  sudo -n mv -- "$mysql_log" "$mysql_log.$stamp"
  echo "Archived: $mysql_log.$stamp"
fi
sudo -n mysql -e 'FLUSH SLOW LOGS'
