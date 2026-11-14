import "dotenv/config";
import { spawnSync } from "node:child_process";

interface CliOptions {
  dryRun: boolean;
  noStart: boolean;
  local: boolean;
  sshTarget: string;
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let noStart = false;
  let local = false;
  let sshTarget = process.env.PIPELINE_SSH_TARGET || "root@vm-main";

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-start") noStart = true;
    else if (arg === "--local") local = true;
    else if (arg.startsWith("--target=")) sshTarget = arg.slice("--target=".length);
  }

  return { dryRun, noStart, local, sshTarget };
}

function buildRemoteResetBashScript(opts: CliOptions): string {
  const dryRunVal = opts.dryRun ? "1" : "0";
  const noStartVal = opts.noStart ? "1" : "0";

  return `#!/usr/bin/env bash
set -Eeuo pipefail

DRY_RUN="${dryRunVal}"
NO_START="${noStartVal}"

PIPELINE_ENV="/root/envs/pipeline/.env"
if [ ! -f "$PIPELINE_ENV" ]; then
  PIPELINE_ENV="/root/Sh-Pipeline/.env"
fi
INNGEST_ENV="/root/inngest/.env"

if [ ! -f "$PIPELINE_ENV" ]; then
  echo "ERROR: Pipeline env file not found (/root/envs/pipeline/.env or /root/Sh-Pipeline/.env)" >&2
  exit 1
fi
if [ ! -f "$INNGEST_ENV" ]; then
  echo "ERROR: Inngest env file not found (/root/inngest/.env)" >&2
  exit 1
fi

set -a
source "$PIPELINE_ENV"
source "$INNGEST_ENV"
set +a

DOWNLOAD_DIR="\${DEFAULT_DOWNLOAD_DIR:-/srv/torrents/complete}"
TORRENT_ROOT="$(dirname "$DOWNLOAD_DIR")"
INCOMPLETE_DIR="$TORRENT_ROOT/incomplete"
STAGING_DIR="\${KIRA_STAGING_DIR:-$DOWNLOAD_DIR/.kira-staging}"
TR_LOCAL_URL="\${TRANSMISSION_LOCAL_URL:-http://127.0.0.1:9091/transmission/rpc}"

echo "============================================================"
echo "  SH-Pipeline Full Reset (DRY_RUN=$DRY_RUN, NO_START=$NO_START)"
echo "============================================================"
echo "  Download dir : $DOWNLOAD_DIR"
echo "  Incomplete   : $INCOMPLETE_DIR"
echo "  Staging dir  : $STAGING_DIR"
echo "============================================================"

# Parse INNGEST_REDIS_URI into host, port, password
eval "$(node -e '
  const raw = process.env.INNGEST_REDIS_URI || "redis://127.0.0.1:6379";
  const u = new URL(raw);
  console.log("REDIS_HOST=" + JSON.stringify(u.hostname || "127.0.0.1"));
  console.log("REDIS_PORT=" + JSON.stringify(u.port || "6379"));
  console.log("REDIS_PASS=" + JSON.stringify(decodeURIComponent(u.password || "")));
')"

redis_exec() {
  if [ -n "$REDIS_PASS" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASS" --no-auth-warning "$@"
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "$@"
  fi
}

echo ""
echo "[1/6] Inspecting current state..."
psql "$DATABASE_URL" -c "SELECT 'pipeline_encoding_job' AS table_name, status, count(*) FROM pipeline_encoding_job GROUP BY status ORDER BY count(*) DESC;"
psql "$DATABASE_URL" -c "SELECT 'pipeline_encoding_batch' AS table_name, status, count(*) FROM pipeline_encoding_batch GROUP BY status ORDER BY count(*) DESC;"
psql "$INNGEST_POSTGRES_URI" -c "
  SELECT f.slug, count(*) AS pending_runs
  FROM function_runs fr
  JOIN functions f ON fr.function_id = f.id
  JOIN apps a ON f.app_id = a.id
  WHERE (a.name = 'sh-pipeline' OR a.url LIKE '%:4050%')
    AND NOT EXISTS (SELECT 1 FROM function_finishes ff WHERE ff.run_id = fr.run_id)
  GROUP BY f.slug
  ORDER BY pending_runs DESC;
"
psql "$INNGEST_POSTGRES_URI" -c "
  SELECT status AS trace_status, count(*)
  FROM trace_runs
  WHERE app_id IN (SELECT id FROM apps WHERE name = 'sh-pipeline' OR url LIKE '%:4050%')
    AND status IN (0, 100, 200)
  GROUP BY status;
"

SH_FN_IDS="$(psql "$INNGEST_POSTGRES_URI" -t -A -c "
  SELECT f.id
  FROM functions f
  JOIN apps a ON f.app_id = a.id
  WHERE a.name = 'sh-pipeline' OR a.url LIKE '%:4050%';
")"

for fn_id in $SH_FN_IDS; do
  q_count="$(redis_exec ZCARD "{queue}:queue:sorted:$fn_id" 2>/dev/null || echo 0)"
  echo "  Redis queue {queue}:queue:sorted:$fn_id = $q_count"
done

echo "  Transmission torrents:"
transmission-remote -l 2>/dev/null || true

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "[DRY RUN] No changes made. Re-run without --dry-run to execute full reset."
  exit 0
fi

echo ""
echo "[2/6] Stopping Sh-Pipeline and stray pipeline workers..."
pm2 stop Sh-Pipeline >/dev/null 2>&1 || true
# Kill only ffmpeg or hf upload child processes working inside staging dir
pkill -f "$STAGING_DIR" >/dev/null 2>&1 || true
sleep 1

echo ""
echo "[3/6] Closing all pending Inngest runs & draining Redis queues for 'sh-pipeline' only..."
for fn_id in $SH_FN_IDS; do
  removed_count="$(redis_exec EVAL '
    local fnId = ARGV[1]
    local total = 0
    local zkeys = { "{queue}:queue:sorted:" .. fnId }
    local cur = "0"
    repeat
      local res = redis.call("SCAN", cur, "MATCH", "{queue}:queue:status:" .. fnId .. ":*", "COUNT", 1000)
      cur = res[1]
      for _, k in ipairs(res[2]) do
        table.insert(zkeys, k)
      end
    until cur == "0"

    local seenItems = {}
    for _, zk in ipairs(zkeys) do
      local members = redis.call("ZRANGE", zk, 0, -1)
      if #members > 0 then
        for i = 1, #members do
          local itemId = members[i]
          if not seenItems[itemId] then
            seenItems[itemId] = true
            local raw = redis.call("HGET", "{queue}:queue:item", itemId)
            if raw then
              local runId = string.match(raw, "\"runID\":\"([^\"]+)\"")
              if runId then
                redis.call("DEL", "{queue}:idx:run:" .. runId)
              end
            end
          end
        end
        for i = 1, #members, 500 do
          local last = math.min(i + 499, #members)
          redis.call("HDEL", "{queue}:queue:item", unpack(members, i, last))
          total = total + (last - i + 1)
        end
      end
      redis.call("DEL", zk)
    end

    redis.call("ZREM", "{queue}:partition:sorted", fnId)
    redis.call("HDEL", "{queue}:partition:item", fnId)

    local acur = "0"
    repeat
      local ares = redis.call("SCAN", acur, "MATCH", "{queue}:accounts:*:partition:sorted", "COUNT", 500)
      acur = ares[1]
      for _, ak in ipairs(ares[2]) do
        redis.call("ZREM", ak, fnId)
      end
    until acur == "0"

    local fcur = "0"
    repeat
      local fres = redis.call("SCAN", fcur, "MATCH", "{queue}:*" .. fnId .. "*", "COUNT", 1000)
      fcur = fres[1]
      for _, fk in ipairs(fres[2]) do
        redis.call("DEL", fk)
      end
    until fcur == "0"

    return total
  ' 0 "$fn_id")"
  echo "  Drained Redis items for $fn_id: $removed_count"
done

psql "$INNGEST_POSTGRES_URI" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO function_finishes (run_id, status, output, completed_step_count, created_at)
SELECT fr.run_id, 'Cancelled', '{"reason":"pipeline_full_reset"}', 0, NOW()
FROM function_runs fr
JOIN functions f ON fr.function_id = f.id
JOIN apps a ON f.app_id = a.id
WHERE (a.name = 'sh-pipeline' OR a.url LIKE '%:4050%')
  AND NOT EXISTS (
    SELECT 1 FROM function_finishes ff WHERE ff.run_id = fr.run_id
  );

UPDATE trace_runs
SET status = 500,
    ended_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE app_id IN (SELECT id FROM apps WHERE name = 'sh-pipeline' OR url LIKE '%:4050%')
  AND status IN (0, 100, 200);
SQL

echo "  Restarting Inngest daemon to clear in-memory partition state..."
pm2 restart inngest >/dev/null
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8288/health >/dev/null 2>&1 || nc -z 127.0.0.1 8288 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "[4/6] Truncating both pipeline tables & resetting sequences..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE pipeline_encoding_job, pipeline_encoding_batch RESTART IDENTITY CASCADE;"

echo ""
echo "[5/6] Clearing Transmission torrents and VM processing files only..."
node -e '
  const rpcUrl = process.env.TR_LOCAL_URL || "http://127.0.0.1:9091/transmission/rpc";
  const user = process.env.TRANSMISSION_USER || "";
  const pass = process.env.TRANSMISSION_PASS || "";
  const headers = { "Content-Type": "application/json" };
  if (user && pass) headers["Authorization"] = "Basic " + Buffer.from(user + ":" + pass).toString("base64");

  async function call(method, args = {}) {
    let sid = null;
    for (let i = 0; i < 2; i++) {
      const h = { ...headers };
      if (sid) h["X-Transmission-Session-Id"] = sid;
      const res = await fetch(rpcUrl, { method: "POST", headers: h, body: JSON.stringify({ method, arguments: args }) });
      if (res.status === 409) {
        sid = res.headers.get("X-Transmission-Session-Id");
        continue;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return data.arguments || {};
    }
    throw new Error("Transmission RPC failed");
  }

  (async () => {
    const list = await call("torrent-get", { fields: ["id", "name"] });
    const ids = (list.torrents || []).map((t) => t.id);
    if (ids.length > 0) {
      await call("torrent-remove", { ids, "delete-local-data": true });
      console.log("  Removed " + ids.length + " torrent(s) + local data from Transmission.");
    } else {
      console.log("  Transmission queue already empty.");
    }
  })().catch((e) => {
    console.warn("  Transmission RPC note:", e.message || e);
  });
' TR_LOCAL_URL="$TR_LOCAL_URL"

# Remove ONLY processing files/dirs, preserving directories, permissions, .pipeline-policy.json, and /tmp/kira-hf-venv
if [ -d "$DOWNLOAD_DIR" ]; then
  find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 1 ! -name '.kira-staging' -exec rm -rf -- {} +
fi
if [ -d "$STAGING_DIR" ]; then
  find "$STAGING_DIR" -mindepth 1 -maxdepth 1 ! -name '.pipeline-policy.json' -exec rm -rf -- {} +
else
  mkdir -p "$STAGING_DIR"
fi
if [ -d "$INCOMPLETE_DIR" ]; then
  find "$INCOMPLETE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
if [ -d "/tmp/kira-staging" ]; then
  find "/tmp/kira-staging" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
rm -rf /tmp/kira_worker_* /tmp/anilight_batch_work_* 2>/dev/null || true

echo ""
echo "[6/6] Finalizing service state & verifying clean reset..."
if [ "$NO_START" = "0" ]; then
  pm2 start Sh-Pipeline >/dev/null 2>&1 || pm2 restart Sh-Pipeline >/dev/null 2>&1 || true
  sleep 3
fi

echo "--- VERIFICATION ---"
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM pipeline_encoding_job) AS job_rows, (SELECT count(*) FROM pipeline_encoding_batch) AS batch_rows;"
psql "$INNGEST_POSTGRES_URI" -c "
  SELECT
    (SELECT count(*) FROM function_runs fr JOIN functions f ON fr.function_id = f.id JOIN apps a ON f.app_id = a.id
      WHERE (a.name = 'sh-pipeline' OR a.url LIKE '%:4050%')
        AND NOT EXISTS (SELECT 1 FROM function_finishes ff WHERE ff.run_id = fr.run_id)) AS pending_inngest_runs,
    (SELECT count(*) FROM trace_runs
      WHERE app_id IN (SELECT id FROM apps WHERE name = 'sh-pipeline' OR url LIKE '%:4050%')
        AND status IN (0, 100, 200)) AS active_trace_runs;
"
echo "  Remaining in $DOWNLOAD_DIR:"
ls -la "$DOWNLOAD_DIR"
echo "  Remaining in $STAGING_DIR:"
ls -la "$STAGING_DIR"
echo "  Remaining in $INCOMPLETE_DIR:"
ls -la "$INCOMPLETE_DIR"
echo "  Transmission torrents:"
transmission-remote -l 2>/dev/null || true
echo "============================================================"
echo "  Reset complete! Ready for a fresh restart."
echo "============================================================"
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const script = buildRemoteResetBashScript(opts).replace(/\r\n/g, "\n");

  if (opts.local) {
    const res = spawnSync("bash", ["-s"], {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
    });
    process.exit(res.status ?? 1);
  }

  console.log(`Connecting via SSH to ${opts.sshTarget}...`);
  const res = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", opts.sshTarget, "tr -d '\\r' | bash -s"],
    {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
    },
  );

  if (res.error) {
    console.error("Failed to run SSH reset:", res.error.message);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});

