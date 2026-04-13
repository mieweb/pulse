# PulseVault Server Evidence Commands

Follow-up SSH commands to run on the deployed server to collect additional evidence and complete remaining TODO items.

---

## 1) Observability — Grafana / Prometheus Screenshots

Run these **locally** (not on server) to set up SSH tunnels, then screenshot in browser:

```bash
ssh -L 3001:localhost:3000 user@yourserver   # Grafana  → http://localhost:3001
ssh -L 9090:localhost:9090 user@yourserver   # Prometheus → http://localhost:9090
```

Pages to screenshot:
- Grafana: `http://localhost:3001` — dashboard panels
- Prometheus: `http://localhost:9090/targets` — shows `pulsevault-backend` health = up

---

## 2) Audit Chain Verification

Runs the built-in chain verifier to prove hash-chain integrity, not just presence.

```bash
docker compose exec pulsevault node -e "
  const AuditLogger = require('./lib/audit-logger');
  const logger = new AuditLogger(process.env.AUDIT_DIR);
  logger.verifyChain().then(r => console.log(JSON.stringify(r, null, 2)));
" | tee ~/pulsevault-evidence/2026-04-13/audit_chain_verification.txt
```

---

## 3) Redis Queue State

Proves the queue infrastructure is live and healthy.

```bash
docker compose exec redis redis-cli info server | tee ~/pulsevault-evidence/2026-04-13/redis_info.txt
docker compose exec redis redis-cli llen transcode-queue | tee -a ~/pulsevault-evidence/2026-04-13/redis_info.txt
docker compose exec redis redis-cli dbsize >> ~/pulsevault-evidence/2026-04-13/redis_info.txt
```

---

## 4) Media Volume Storage Stats

Shows total transcoded video count, storage usage, and audit log scale.

```bash
docker compose exec pulsevault sh -c '
  echo "=== Volume summary ==="
  df -h /media
  echo ""
  echo "=== Videos dir ==="
  du -sh /media/videos/
  echo ""
  echo "=== Total video count ==="
  ls /media/videos | wc -l
  echo ""
  echo "=== Audit dir ==="
  du -sh /media/audit/
  ls /media/audit | wc -l
' | tee ~/pulsevault-evidence/2026-04-13/storage_stats.txt
```

---

## 5) Docker Container Health + Uptime

Proves operational continuity of all 9 services.

```bash
# Service status table
docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}" \
  | tee ~/pulsevault-evidence/2026-04-13/service_health_table.txt

# Resource utilization snapshot
docker stats --no-stream \
  --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
  | tee ~/pulsevault-evidence/2026-04-13/docker_stats.txt
```

---

## 6) Nginx Real-Traffic Evidence

Shows actual HLS delivery, upload, and QR traffic from nginx logs.

```bash
docker compose logs nginx --tail=100 \
  | grep -E "(GET /media|POST /uploads|GET /qr)" \
  | tee ~/pulsevault-evidence/2026-04-13/nginx_traffic_sample.txt
```

---

## 7) QR / Deeplink Route Evidence (Server-Side)

Confirms QR endpoints are live and registered, even without a phone screenshot.

```bash
# QR configure-destination response
curl -s http://localhost:8080/qr/configure-destination \
  | tee ~/pulsevault-evidence/2026-04-13/qr_endpoint_response.txt

# Deeplink endpoint headers
curl -si http://localhost:8080/qr/deeplink | head -20 \
  | tee ~/pulsevault-evidence/2026-04-13/qr_deeplink_headers.txt
```

---

## 8) Full Prometheus Metrics Dump

Complete /metrics snapshot (all gauges and counters, not just the top 40).

```bash
docker compose exec pulsevault sh -c 'wget -qO- http://localhost:3000/metrics' \
  | tee ~/pulsevault-evidence/2026-04-13/metrics_full_snapshot.txt
```

---

## 9) Package and Transfer Evidence Archive

Bundle everything and scp back to local machine.

```bash
# On server
tar -czf ~/pulsevault-evidence-2026-04-13.tar.gz ~/pulsevault-evidence/2026-04-13/

# Locally
scp user@yourserver:~/pulsevault-evidence-2026-04-13.tar.gz ./
```

---

## What Still Requires a Physical Device (Stays Manual)

These cannot be done via SSH — they remain in the manual-only section of the TODO:

- **QR scan-result screenshot** — needs a phone running the Pulse app scanning the generated QR code.
- **`\approvedby{...}`** — needs program office confirmation of the official Form 9 thesis head name.
- **Emailing professors** — manual send of review packet.

---

## Artifacts Produced (Target Files)

Once commands above are run, these files will exist in `~/pulsevault-evidence/2026-04-13/`:

| File | What It Proves |
|---|---|
| `audit_chain_verification.txt` | Built-in verifier confirms hash chain is intact |
| `redis_info.txt` | Redis server live, queue depth, key count |
| `storage_stats.txt` | Media volume size, 26+ video dirs, audit log count |
| `service_health_table.txt` | All 9 services Up with uptime |
| `docker_stats.txt` | CPU/memory/network per container |
| `nginx_traffic_sample.txt` | Real HLS delivery + upload + QR traffic |
| `qr_endpoint_response.txt` | QR configure-destination route live |
| `qr_deeplink_headers.txt` | Deeplink endpoint registered and responding |
| `metrics_full_snapshot.txt` | Complete Prometheus metric set from /metrics |
