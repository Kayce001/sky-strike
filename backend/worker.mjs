const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ONLINE_TTL = 45000;

export async function handle(request, env, now = Date.now()) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN || 'https://kayce001.github.io';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {status, headers});
  if (origin && origin !== allowed) return reply({error:'Origin not allowed'}, 403);
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers});
  const path = new URL(request.url).pathname;
  if (path !== '/stats' && path !== '/presence') return reply({error:'Not found'}, 404);
  if ((path === '/stats' && request.method !== 'GET') || (path === '/presence' && request.method !== 'POST')) {
    return reply({error:'Method not allowed'}, 405);
  }
  try {
    const statements = [];
    if (path === '/presence') {
      // Read a bounded stream instead of trusting Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return reply({error:'Missing body'}, 400);
      let size = 0, chunks = [];
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512) { await reader.cancel(); return reply({error:'Body too large'}, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return reply({error:'Invalid JSON'}, 400); }
      if (!data || !UUID.test(data.playerId) || !UUID.test(data.sessionId) ||
          typeof data.active !== 'boolean' || !Number.isSafeInteger(data.sequence) || data.sequence < 1) {
        return reply({error:'Invalid presence'}, 400);
      }
      if (data.active) statements.push(env.DB.prepare('INSERT OR IGNORE INTO players (id, first_played) VALUES (?, ?)').bind(data.playerId, now));
      statements.push(env.DB.prepare(`INSERT INTO sessions (id, player_id, sequence, active, seen)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        sequence=excluded.sequence, active=excluded.active, seen=excluded.seen
        WHERE excluded.sequence > sessions.sequence AND excluded.player_id = sessions.player_id`)
        .bind(data.sessionId, data.playerId, data.sequence, data.active ? 1 : 0, now));
      // Tombstones survive for a day so a delayed heartbeat cannot undo a leave.
      statements.push(env.DB.prepare('DELETE FROM sessions WHERE seen < ?').bind(now - 86400000));
    }
    statements.push(env.DB.prepare('SELECT players AS totalPlayers FROM totals WHERE id = 1'));
    statements.push(env.DB.prepare('SELECT COUNT(DISTINCT player_id) AS onlinePlayers FROM sessions WHERE active = 1 AND seen > ?').bind(now - ONLINE_TTL));
    const results = await env.DB.batch(statements);
    const total = results.at(-2).results[0].totalPlayers;
    const online = results.at(-1).results[0].onlinePlayers;
    return reply({totalPlayers:total, onlinePlayers:online, onlineTtlMs:ONLINE_TTL});
  } catch (error) {
    console.error('Player statistics failed', error.message);
    return reply({error:'Statistics temporarily unavailable'}, 503);
  }
}

export default {fetch(request, env) { return handle(request, env); }};
