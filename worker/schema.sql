CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  idle_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  total_cpu REAL NOT NULL,
  total_mem_mb INTEGER NOT NULL,
  longest_seconds INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  pid INTEGER NOT NULL,
  tty TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  cpu_percent REAL NOT NULL,
  rss_mb INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_snapshot ON sessions(snapshot_id);
