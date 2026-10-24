#!/usr/bin/env bash
# Create a disposable local MySQL. Never connect to s1 or use application DB env.
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/isucon14-location-state.XXXXXX")
test_container="isucon14-location-state-${test_dir##*.}"

cleanup() {
  docker rm --force --volumes "$test_container" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

docker run --detach --rm --name "$test_container" \
  --publish 127.0.0.1::3306 \
  --env MYSQL_ROOT_PASSWORD=location-state-test \
  --mount "type=bind,source=$repo_dir/webapp/sql,target=/test/sql,readonly" \
  mysql:8.0 --skip-log-bin > "$test_dir/container-id"

test_ready=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec --env MYSQL_PWD=location-state-test "$test_container" \
    mysql --user=root --batch --skip-column-names -e 'SELECT 1' >/dev/null 2>&1; then
    test_ready=1
    break
  fi
  sleep 1
done
if [ "$test_ready" != 1 ]; then
  docker logs "$test_container"
  exit 1
fi

test_address=$(docker port "$test_container" 3306/tcp)
case "$test_address" in
  127.0.0.1:*) test_port=${test_address##*:} ;;
  *) echo 'Expected a loopback-only MySQL port' >&2; exit 1 ;;
esac

# Exercise the real init.sh twice inside this container. Its hardcoded isuride
# database and reference dump never run against any existing local/server DB.
docker exec --interactive --env MYSQL_PWD=location-state-test "$test_container" \
  mysql --user=root < "$repo_dir/webapp/sql/0-init.sql"
for pass in 1 2; do
  test_started=$(date +%s)
  if ! docker exec --workdir /test/sql \
    --env ISUCON_DB_USER=root --env ISUCON_DB_PASSWORD=location-state-test \
    "$test_container" bash init.sh > "$test_dir/initialize.log" 2>&1; then
    cat "$test_dir/initialize.log"
    exit 1
  fi
  test_elapsed=$(( $(date +%s) - test_started ))
  if [ "$test_elapsed" -ge 25 ]; then
    echo "Initialization exceeded the application's 25-second limit" >&2
    exit 1
  fi
  test_counts=$(docker exec --env MYSQL_PWD=location-state-test "$test_container" \
    mysql --user=root --batch --skip-column-names isuride \
    -e "SELECT CONCAT(COUNT(*), '/', SUM(recorded_at IS NULL)) FROM chair_location_state")
  test "$test_counts" = '500/113'
  echo "Initialization $pass: ${test_elapsed}s, 500 state rows (113 without coordinates)"
done

# The SSE regression suite runs the real application and init.sh on the host.
# Supply a test-only mysql client that executes exclusively in our container;
# translate its published host port to the MySQL port inside that container.
mkdir "$test_dir/bin"
cat > "$test_dir/bin/mysql" <<'CLIENT'
#!/usr/bin/env bash
set -euo pipefail
mysql_args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--port' ]; then
    mysql_args+=(--port 3306)
    shift 2
  else
    mysql_args+=("$1")
    shift
  fi
done
exec docker exec --interactive "$LOCATION_TEST_CONTAINER" mysql "${mysql_args[@]}"
CLIENT
chmod +x "$test_dir/bin/mysql"

cd "$repo_dir/webapp/nodejs"
env -u NEARBY_TEST_MYSQL_SOCKET \
  PATH="$test_dir/bin:$PATH" \
  LOCATION_TEST_CONTAINER="$test_container" \
  SSE_TEST_MYSQL=1 \
  ISUCON_DB_HOST=127.0.0.1 ISUCON_DB_PORT="$test_port" \
  ISUCON_DB_USER=isucon ISUCON_DB_PASSWORD=isucon ISUCON_DB_NAME=isuride \
  LOCATION_STATE_TEST_MYSQL_PORT="$test_port" \
  LOCATION_STATE_TEST_MYSQL_PASSWORD=location-state-test \
  NEARBY_TEST_MYSQL_PORT="$test_port" \
  NEARBY_TEST_MYSQL_PASSWORD=location-state-test \
  npm test
