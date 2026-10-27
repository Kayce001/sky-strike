import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {handle, ONLINE_TTL} from '../backend/worker.mjs';
import {PlayerStats} from '../stats-client.mjs';

const player1 = '00000000-0000-4000-8000-000000000001';
const player2 = '00000000-0000-4000-8000-000000000002';
const session1 = '00000000-0000-4000-8000-000000000011';
const session2 = '00000000-0000-4000-8000-000000000012';
const origin = 'https://kayce001.github.io';
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  return {db, env:{DB:{
    prepare(sql) { return {sql, values:[], bind(...values) { this.values = values; return this; }}; },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({sql,values}) => {
          const statement = db.prepare(sql);
          return {results:sql.trim().startsWith('SELECT') ? statement.all(...values) : (statement.run(...values), [])};
        });
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  }}};
}
async function presence(env, {playerId=player1,sessionId=session1,active=true,sequence=1}={}, now=100000) {
  const request = new Request('https://test/presence',{method:'POST',headers:{Origin:origin},body:JSON.stringify({playerId,sessionId,active,sequence})});
  const response = await handle(request,env,now);
  assert.equal(response.status,200);
  return response.json();
}
async function stats(env, now=100000) { return (await handle(new Request('https://test/stats'),env,now)).json(); }

test('only starts count, replays and refreshes deduplicate; multiple players aggregate', async () => {
  const {env}=database();
  assert.deepEqual(await stats(env),{totalPlayers:0,onlinePlayers:0,onlineTtlMs:ONLINE_TTL});
  assert.equal((await presence(env)).totalPlayers,1);
  assert.equal((await presence(env,{sequence:2})).totalPlayers,1);
  const same = await presence(env,{sessionId:session2});
  assert.equal(same.totalPlayers,1);
  assert.equal(same.onlinePlayers,1);
  const another = await presence(env,{playerId:player2,sessionId:'00000000-0000-4000-8000-000000000013'});
  assert.equal(another.totalPlayers,2);
  assert.equal(another.onlinePlayers,2);
});
test('pause, multi-tab leave, timeout and delayed requests preserve presence', async () => {
  const {env}=database();
  await presence(env);
  await presence(env,{sessionId:session2});
  assert.equal((await presence(env,{active:false,sequence:3})).onlinePlayers,1);
  await presence(env,{active:false,sequence:2,sessionId:session2});
  assert.equal((await presence(env,{active:true,sequence:2})).onlinePlayers,0);
  assert.equal((await presence(env,{active:true,sequence:4})).onlinePlayers,1);
  const expired = await stats(env,100000+ONLINE_TTL);
  assert.equal(expired.onlinePlayers,0);
  assert.equal(expired.totalPlayers,1);
});
test('invalid requests rejected and read-only views never count as players', async () => {
  const {env}=database();
  const disallowed = await handle(new Request('https://test/stats',{headers:{Origin:'https://evil.example'}}),env);
  assert.equal(disallowed.status,403);
  for (const body of ['null','{','{}','x'.repeat(513)]) {
    const response = await handle(new Request('https://test/presence',{method:'POST',body}),env);
    assert.ok([400,413].includes(response.status));
  }
  assert.equal((await presence(env,{active:false})).totalPlayers,0);
});
function clientSetup() {
  let playing=false, reject=false;
  const requests=[], output=[], beacons=[], values=new Map();
  const {env}=database();
  const client = new PlayerStats({endpoint:'https://test',isPlaying:()=>playing,
    storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    uuid:(()=>{let n=10;return ()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;})(),
    fetcher:async(url,options)=>{requests.push({url,options});if(reject) throw Error('offline');return handle(new Request(url,options),env,100000);},
    render:data=>output.push(data),beacon:(url,body)=>{beacons.push({url,body});return true;},
    clock:{setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1},
  });
  return {client,requests,output,beacons,setPlaying:value=>playing=value,setReject:value=>reject=value};
}
test('client only posts after start, replays deduplicate, pause/close clear presence', async () => {
  const c=clientSetup();
  await c.client.sync();
  assert.ok(c.requests[0].url.endsWith('/stats'));
  c.setPlaying(true); await c.client.sync();
  assert.equal(c.output.at(-1).totalPlayers,1);
  await c.client.sync(); assert.equal(c.output.at(-1).totalPlayers,1);
  c.setPlaying(false); await c.client.sync(); assert.equal(c.output.at(-1).onlinePlayers,0);
  c.setPlaying(true); await c.client.sync();
  c.client.leave(); assert.equal(JSON.parse(c.beacons[0].body).active,false);
});
test('client service failures are visible and recover without disrupting gameplay', async () => {
  const c=clientSetup();
  c.setPlaying(true);c.setReject(true);await c.client.sync();
  assert.equal(c.output.at(-1),null);
  c.setReject(false);await c.client.sync();
  assert.equal(c.output.at(-1).onlinePlayers,1);
});
test('storage denied uses a session-only identity without throwing', async () => {
  const c=new PlayerStats({endpoint:'',isPlaying:()=>false,storage:{getItem(){throw Error('blocked');}},uuid:()=>player1});
  assert.equal(c.playerId,player1);
  assert.doesNotThrow(()=>c.sync());
});
test('a delayed online response cannot overwrite a newer pause response', async () => {
  let playing=true;
  const pending=[], output=[];
  const client=new PlayerStats({endpoint:'https://test',isPlaying:()=>playing,
    storage:{getItem:()=>player1},uuid:()=>session1,
    fetcher:()=>new Promise(resolve=>pending.push(resolve)),render:data=>output.push(data),
    clock:{setTimeout:()=>1,clearTimeout:()=>{}},
  });
  const first=client.sync();await Promise.resolve();
  playing=false;
  const pause=client.sync();await Promise.resolve();
  pending[1](Response.json({totalPlayers:1,onlinePlayers:0}));await pause;
  pending[0](Response.json({totalPlayers:1,onlinePlayers:1}));await first;
  assert.deepEqual(output,[{totalPlayers:1,onlinePlayers:0}]);
});
test('corrupted stored identity is replaced, hidden pages do not keep polling', async () => {
  let callback,requests=0,stored;
  const client=new PlayerStats({endpoint:'https://test',isPlaying:()=>false,isVisible:()=>false,
    storage:{getItem:()=>'-'.repeat(36),setItem:(key,value)=>stored=value},uuid:()=>player1,
    fetcher:async()=>{requests++;return Response.json({totalPlayers:0,onlinePlayers:0});},render:()=>{},
    clock:{setTimeout:()=>1,clearTimeout:()=>{},setInterval:fn=>{callback=fn;return 1;}},
  });
  client.start();await client.inFlight;
  callback();await Promise.resolve();
  assert.equal(stored,player1);
  assert.equal(requests,1);
});
