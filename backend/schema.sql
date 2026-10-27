CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  first_played INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  players INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO totals (id, players) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS count_new_player AFTER INSERT ON players
BEGIN
  UPDATE totals SET players = players + 1 WHERE id = 1;
END;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  active INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_online ON sessions (active, seen, player_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (seen);
