export class PlayerStats {
  constructor({endpoint, isPlaying, storage, uuid, fetcher, render, beacon, clock = globalThis}) {
    Object.assign(this, {endpoint:endpoint.replace(/\/$/, ''), isPlaying, fetcher, render, beacon, clock});
    this.sequence = 0;
    this.sessionId = uuid();
    try {
      this.playerId = storage.getItem('sky-strike-player-id');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.playerId || '')) {
        this.playerId = uuid();
        storage.setItem('sky-strike-player-id', this.playerId);
      }
    } catch { this.playerId = uuid(); }
    this.active = false;
    this.started = false;
    this.revision = 0;
    this.inFlight = null;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.sync();
    this.timer = this.clock.setInterval(() => this.sync(), 15000);
  }
  payload(active) {
    return {playerId:this.playerId, sessionId:this.sessionId, sequence:++this.sequence, active};
  }
  sync() {
    if (!this.endpoint) return;
    const playing = this.isPlaying();
    const changed = playing !== this.active;
    this.active = playing;
    // Send transitions immediately; steady-state polling never overlaps a request.
    if (this.inFlight && !changed) return this.inFlight;
    const revision = ++this.revision;
    const options = playing || changed ? {
      method:'POST', headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:JSON.stringify(this.payload(playing)), keepalive:!playing,
    } : {};
    const controller = new AbortController();
    const timeout = this.clock.setTimeout(() => controller.abort(), 8000);
    const operation = Promise.resolve().then(() => this.fetcher(this.endpoint + (options.method ? '/presence' : '/stats'), {
      ...options, signal:controller.signal, cache:'no-store', credentials:'omit',
    })).then(async response => {
      if (!response.ok) throw new Error('Statistics unavailable');
      const data = await response.json();
      if (!Number.isSafeInteger(data.totalPlayers) || data.totalPlayers < 0 ||
          !Number.isSafeInteger(data.onlinePlayers) || data.onlinePlayers < 0) throw new Error('Invalid statistics');
      if (revision === this.revision) this.render(data);
    }).catch(() => {
      if (revision === this.revision) this.render(null);
    }).finally(() => {
      this.clock.clearTimeout(timeout);
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }
  leave() {
    if (!this.endpoint || !this.active) return;
    this.active = false;
    ++this.revision;
    const data = JSON.stringify(this.payload(false));
    // text/plain allows cross-origin beacon without an unload-time preflight.
    if (!this.beacon(this.endpoint + '/presence', data)) {
      this.fetcher(this.endpoint + '/presence', {method:'POST', body:data, keepalive:true, credentials:'omit'}).catch(() => {});
    }
  }
}

if (typeof document !== 'undefined') {
  const endpoint = document.querySelector('meta[name="sky-strike-stats-api"]')?.content || '';
  const total = document.getElementById('total-players');
  const online = document.getElementById('online-players');
  const status = document.getElementById('stats-status');
  const format = new Intl.NumberFormat('zh-CN');
  const stats = new PlayerStats({
    endpoint,
    isPlaying:() => window.skyStrikeIsPlaying() && !document.hidden,
    storage:{getItem:key => localStorage.getItem(key), setItem:(key, value) => localStorage.setItem(key,value)},
    uuid:() => crypto.randomUUID(), fetcher:(...args) => fetch(...args),
    beacon:(...args) => navigator.sendBeacon(...args),
    render:data => {
      total.textContent = data ? format.format(data.totalPlayers) : '—';
      online.textContent = data ? format.format(data.onlinePlayers) : '—';
      status.textContent = data ? '15 秒刷新 · 45 秒无心跳视为离线' : '统计暂不可用，游戏可正常游玩';
      status.dataset.state = data ? 'connected' : 'offline';
    },
  });
  window.addEventListener('sky-strike-state', () => stats.sync());
  document.addEventListener('visibilitychange', () => document.hidden ? stats.leave() : stats.sync());
  window.addEventListener('pagehide', () => stats.leave());
  window.addEventListener('pageshow', () => stats.sync());
  window.addEventListener('online', () => stats.sync());
  stats.start();
  if (!endpoint) status.textContent = '统计服务待连接';
}
