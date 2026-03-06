interface Env {
  DB: D1Database;
  API_KEY: string;
}

interface SessionPayload {
  pid: number;
  tty: string;
  elapsed_seconds: number;
  cpu_percent: number;
  rss_mb: number;
  cwd: string;
  flags: string;
  session_id?: string;
}

interface SnapshotPayload {
  active_count: number;
  idle_count: number;
  total_count: number;
  total_cpu: number;
  total_mem_mb: number;
  longest_seconds: number;
  sessions: SessionPayload[];
}

function authCheck(request: Request, env: Env): Response | null {
  const key = request.headers.get("X-API-Key");
  if (!key || key !== env.API_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const auth = authCheck(request, env);
    if (auth) return auth;

    try {
      // POST /snapshot - Record a new snapshot
      if (path === "/snapshot" && request.method === "POST") {
        const body = (await request.json()) as SnapshotPayload;
        const ts = Math.floor(Date.now() / 1000);

        const snapshotResult = await env.DB.prepare(
          `INSERT INTO snapshots (ts, active_count, idle_count, total_count, total_cpu, total_mem_mb, longest_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            ts,
            body.active_count,
            body.idle_count,
            body.total_count,
            body.total_cpu,
            body.total_mem_mb,
            body.longest_seconds
          )
          .run();

        const snapshotId = snapshotResult.meta.last_row_id;

        // Insert sessions in batch
        if (body.sessions?.length) {
          const stmts = body.sessions.map((s) =>
            env.DB.prepare(
              `INSERT INTO sessions (snapshot_id, pid, tty, elapsed_seconds, cpu_percent, rss_mb, cwd, flags, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              snapshotId,
              s.pid,
              s.tty,
              s.elapsed_seconds,
              s.cpu_percent,
              s.rss_mb,
              s.cwd,
              s.flags,
              s.session_id ?? null
            )
          );
          await env.DB.batch(stmts);
        }

        return Response.json(
          { ok: true, snapshot_id: snapshotId, ts },
          { headers: corsHeaders }
        );
      }

      // GET /snapshots?hours=24 - Get snapshot history
      if (path === "/snapshots" && request.method === "GET") {
        const hours = parseInt(url.searchParams.get("hours") ?? "24");
        const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

        const results = await env.DB.prepare(
          `SELECT id, ts, active_count, idle_count, total_count, total_cpu, total_mem_mb, longest_seconds
           FROM snapshots WHERE ts >= ? ORDER BY ts ASC`
        )
          .bind(cutoff)
          .all();

        return Response.json(
          { snapshots: results.results },
          { headers: corsHeaders }
        );
      }

      // GET /trends?hours=24 - Get aggregated trends (hourly buckets)
      if (path === "/trends" && request.method === "GET") {
        const hours = parseInt(url.searchParams.get("hours") ?? "24");
        const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

        const results = await env.DB.prepare(
          `SELECT
            (ts / 3600) * 3600 AS bucket,
            MAX(total_count) AS peak_total,
            MAX(active_count) AS peak_active,
            ROUND(AVG(total_count), 1) AS avg_total,
            ROUND(AVG(total_cpu), 1) AS avg_cpu,
            MAX(total_cpu) AS peak_cpu,
            MAX(total_mem_mb) AS peak_mem_mb,
            COUNT(*) AS sample_count
           FROM snapshots
           WHERE ts >= ?
           GROUP BY ts / 3600
           ORDER BY bucket ASC`
        )
          .bind(cutoff)
          .all();

        return Response.json(
          { trends: results.results },
          { headers: corsHeaders }
        );
      }

      // GET /stats - Summary stats
      if (path === "/stats" && request.method === "GET") {
        const now = Math.floor(Date.now() / 1000);
        const day = now - 86400;
        const week = now - 7 * 86400;

        const [dayStats, weekStats, latest] = await env.DB.batch([
          env.DB.prepare(
            `SELECT MAX(total_count) as peak_sessions, MAX(active_count) as peak_active,
                    ROUND(AVG(total_count), 1) as avg_sessions, MAX(total_cpu) as peak_cpu,
                    MAX(total_mem_mb) as peak_mem_mb, COUNT(*) as samples
             FROM snapshots WHERE ts >= ?`
          ).bind(day),
          env.DB.prepare(
            `SELECT MAX(total_count) as peak_sessions, MAX(active_count) as peak_active,
                    ROUND(AVG(total_count), 1) as avg_sessions, MAX(total_cpu) as peak_cpu,
                    MAX(total_mem_mb) as peak_mem_mb, COUNT(*) as samples
             FROM snapshots WHERE ts >= ?`
          ).bind(week),
          env.DB.prepare(
            `SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1`
          ),
        ]);

        return Response.json(
          {
            day: dayStats.results[0],
            week: weekStats.results[0],
            latest: latest.results[0] ?? null,
          },
          { headers: corsHeaders }
        );
      }

      // POST /cleanup - Recalculate active_count from session data using 3% CPU threshold
      if (path === "/cleanup" && request.method === "POST") {
        // Get all snapshots that have session data
        const snapshots = await env.DB.prepare(
          `SELECT s.id, s.active_count, s.total_count,
                  (SELECT COUNT(*) FROM sessions ss WHERE ss.snapshot_id = s.id AND ss.cpu_percent > 3.0) AS new_active,
                  (SELECT COUNT(*) FROM sessions ss WHERE ss.snapshot_id = s.id AND ss.cpu_percent <= 3.0) AS new_idle
           FROM snapshots s`
        ).all();

        let updated = 0;
        const stmts = [];
        for (const snap of snapshots.results as any[]) {
          if (snap.active_count !== snap.new_active) {
            stmts.push(
              env.DB.prepare(
                `UPDATE snapshots SET active_count = ?, idle_count = ? WHERE id = ?`
              ).bind(snap.new_active, snap.new_idle, snap.id)
            );
            updated++;
          }
        }

        // D1 batch limit is 100 statements
        for (let i = 0; i < stmts.length; i += 100) {
          await env.DB.batch(stmts.slice(i, i + 100));
        }

        return Response.json(
          { ok: true, total: snapshots.results.length, updated },
          { headers: corsHeaders }
        );
      }

      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
    } catch (e: any) {
      return Response.json(
        { error: e.message },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
