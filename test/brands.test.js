'use strict'

// Talks to every miner brand over real sockets, using clients that follow what
// each vendor's MDK Worker does on the wire. These are written from the Workers'
// source. The real Workers run in compat/run.js, which needs them installed.

const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const net = require('net')
const http = require('http')
const { buildConfig } = require('../src/config')
const { Runner } = require('../src/runner')
const { allocateFleet, MODELS, specFor } = require('../src/engine/models')
const Simulation = require('../src/engine/simulation')

const PORTS = { api: 0, minerBase: 44030, meter: 45020, sensorBase: 45021, pool: 48000 }

let runner
let sim

before(async () => {
  runner = new Runner(buildConfig({ seed: 3, fleet: { containers: 2, minersPerContainer: 6 }, ports: PORTS }))
  await runner.startProtocols()
  sim = runner.sim
  advance(300)
})

after(() => runner.stop())

function advance (seconds) {
  for (let i = 0; i < seconds; i++) sim.step(1)
}

const minersOf = (model) => sim.miners.filter((m) => m.model === model)
const clear = () => sim.clearFaults(() => true)

function connectionRefused (port, payload = 'x') {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    socket.on('error', (err) => resolve(err.code))
    socket.on('close', () => resolve('closed'))
    socket.on('data', () => resolve('answered'))
  })
}

describe('fleet mix', () => {
  test('an equal mix gives every model the same share', () => {
    const models = allocateFleet(null, 120)
    for (const id of Object.keys(MODELS)) assert.equal(models.filter((m) => m === id).length, 20, id)
  })

  test('weights are honoured and the total is always exact', () => {
    const models = allocateFleet({ antminer: 3, avalon: 1 }, 10)
    assert.equal(models.length, 10)
    assert.equal(models.filter((m) => m === 'antminer').length, 8)
    assert.equal(allocateFleet({ antminer: 1, avalon: 1, proto: 1 }, 7).length, 7)
  })

  test('bad mixes are refused', () => {
    assert.throws(() => allocateFleet({ nope: 1 }, 10), /ERR_MODEL_INVALID/)
    assert.throws(() => allocateFleet({ avalon: -1 }, 10), /ERR_FLEET_MIX_INVALID/)
    assert.throws(() => allocateFleet({ avalon: 0 }, 10), /ERR_FLEET_MIX_INVALID/)
    assert.throws(() => allocateFleet({}, 10), /ERR_FLEET_MIX_INVALID/)
  })

  test('the power contract and cooling follow the mix', () => {
    const big = buildConfig({ fleet: { mix: { sealminer: 1 } } })
    const small = buildConfig({ fleet: { mix: { luxos: 1 } } })
    assert.ok(big.grid.contractKw > small.grid.contractKw * 1.2)
    const a = new Simulation(big)
    const b = new Simulation(small)
    assert.ok(a.containers[0].capacityKw > b.containers[0].capacityKw * 1.2)
  })

  for (const id of Object.keys(MODELS)) {
    test(`${id} settles near its rated numbers without overheating`, () => {
      const s = new Simulation(buildConfig({ seed: 8, fleet: { containers: 1, minersPerContainer: 10, mix: { [id]: 1 } } }))
      for (let i = 0; i < 3600; i++) s.step(1)
      const spec = specFor(id, s.cfg.miner)
      const hash = s.site.hashThs / 10
      assert.ok(Math.abs(hash - spec.nominalThs) / spec.nominalThs < 0.04, `${hash} TH/s`)
      assert.ok(s.site.maxChipC > 55 && s.site.maxChipC < 85, `${s.site.maxChipC}°C`)
      assert.equal(s.fleetCounts().mining, 10)
    })
  }

  test('faults can target one model', () => {
    const s = new Simulation(buildConfig({ fleet: { containers: 2, minersPerContainer: 6 } }))
    s.injectFault({ type: 'psu_failure', target: 'model:antminer' })
    const hit = s.miners.filter((m) => m.fx.psuFailed)
    assert.equal(hit.length, 2)
    assert.ok(hit.every((m) => m.model === 'antminer'))
    assert.throws(() => s.injectFault({ type: 'psu_failure', target: 'model:nope' }), /ERR_MODEL_INVALID/)
  })

  test('a power limit lowers power by more than hashrate', () => {
    const s = new Simulation(buildConfig({ seed: 8, fleet: { containers: 1, minersPerContainer: 4, mix: { proto: 1 } } }))
    for (let i = 0; i < 1800; i++) s.step(1)
    const before = { w: s.site.itKw, ths: s.site.hashThs }
    for (const m of s.miners) s.minerCommand(m.id, 'powerPct', 60, 'quiet')
    for (let i = 0; i < 1800; i++) s.step(1)
    const powerRatio = s.site.itKw / before.w
    const hashRatio = s.site.hashThs / before.ths
    assert.ok(powerRatio < 0.68, `power ${powerRatio}`)
    assert.ok(hashRatio > powerRatio, `hash ${hashRatio} vs power ${powerRatio}`)
    assert.throws(() => s.minerCommand(s.miners[0].id, 'powerPct', 500), /ERR_POWER_PCT_INVALID/)
  })

  test('every model gets its own listening port', () => {
    const ports = new Set(sim.miners.map((m) => m.port))
    assert.equal(ports.size, sim.miners.length)
    assert.deepEqual([...new Set(sim.miners.map((m) => m.model))].sort(), Object.keys(MODELS).sort())
  })
})

// RFC 2617 Digest, as the Antminer Worker's HTTP client sends it.
class DigestClient {
  constructor (port, password = 'root') {
    this.port = port
    this.password = password
    this.nc = 0
    this.challenge = null
  }

  _raw (method, path, body, authorization) {
    return new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json' }
      if (authorization) headers.authorization = authorization
      if (body !== undefined) headers['content-length'] = Buffer.byteLength(body)
      const req = http.request({ host: '127.0.0.1', port: this.port, method, path, headers, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  _authorize (method, path) {
    const md5 = (text) => crypto.createHash('md5').update(text).digest('hex')
    const { realm, nonce, qop, opaque } = this.challenge
    const nc = (++this.nc).toString(16).padStart(8, '0')
    const cnonce = crypto.randomBytes(8).toString('hex')
    const response = md5(`${md5(`root:${realm}:${this.password}`)}:${nonce}:${nc}:${cnonce}:${qop}:${md5(`${method}:${path}`)}`)
    return `Digest username="root", realm="${realm}", nonce="${nonce}", uri="${path}", algorithm=MD5, response="${response}", opaque="${opaque}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  }

  async request (method, path, payload) {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    if (this.challenge) {
      const res = await this._raw(method, path, body, this._authorize(method, path))
      if (res.status !== 401) return res
    }
    const first = await this._raw(method, path, body)
    if (first.status !== 401) return first
    const params = {}
    for (const m of first.headers['www-authenticate'].matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) params[m[1]] = m[2] ?? m[3]
    this.challenge = params
    this.nc = 0
    return this._raw(method, path, body, this._authorize(method, path))
  }

  async json (path) {
    const res = await this.request('GET', path)
    assert.equal(res.status, 200, path)
    return JSON.parse(res.text)
  }
}

describe('Antminer', () => {
  let miner
  let client

  before(() => {
    miner = minersOf('antminer')[0]
    client = new DigestClient(miner.port)
  })

  test('requests without valid Digest auth are refused', async () => {
    const res = await new DigestClient(miner.port)._raw('GET', '/cgi-bin/summary.cgi')
    assert.equal(res.status, 401)
    assert.match(res.headers['www-authenticate'], /^Digest realm="antMiner Configuration"/)
    const wrong = await new DigestClient(miner.port, 'wrong').request('GET', '/cgi-bin/summary.cgi')
    assert.equal(wrong.status, 401)
  })

  test('a replayed Digest header is refused', async () => {
    await client.json('/cgi-bin/summary.cgi')
    const header = client._authorize('GET', '/cgi-bin/summary.cgi')
    assert.equal((await client._raw('GET', '/cgi-bin/summary.cgi', undefined, header)).status, 200)
    assert.equal((await client._raw('GET', '/cgi-bin/summary.cgi', undefined, header)).status, 401)
  })

  test('summary and stats carry engine values in GH/s', async () => {
    const { SUMMARY: [s] } = await client.json('/cgi-bin/summary.cgi')
    assert.equal(s.rate_unit, 'GH/s')
    assert.ok(Math.abs(s.rate_5s / 1000 - miner.ths) < 0.5)
    assert.ok(s.status.every((x) => x.status === 's'))
    const { STATS: [st] } = await client.json('/cgi-bin/stats.cgi')
    assert.ok(Math.abs(st.watt - miner.powerW) <= 40)
    assert.equal(st.chain.length, 3)
    assert.equal(st.fan.length, 4)
    assert.equal(st['miner-mode'], 0)
    assert.equal(st.chain[0].asic_num, 70)
  })

  test('every read endpoint the Worker uses answers', async () => {
    for (const path of ['pools', 'warning', 'get_system_info', 'miner_type', 'get_miner_conf', 'get_adjustment_params', 'get_blink_status', 'dlog', 'get_network_info']) {
      await client.json(`/cgi-bin/${path}.cgi`)
    }
    const conf = await client.json('/cgi-bin/get_miner_conf.cgi')
    assert.equal(conf.pools.length, 3, 'the Worker expects exactly three slots')
    assert.equal((await client.request('GET', '/cgi-bin/nope.cgi')).status, 404)
  })

  test('faults appear as warnings and error sections', async () => {
    sim.injectFault({ type: 'hashboard_failure', target: `miner:${miner.id}` })
    advance(5)
    const { WARNING } = await client.json('/cgi-bin/warning.cgi')
    assert.ok(WARNING.some((w) => w.code === 'W_BOARD'))
    const { SUMMARY: [s] } = await client.json('/cgi-bin/summary.cgi')
    assert.equal(s.status.find((x) => x.type === 'rate').status, 'e')
    clear()
    advance(5)
    assert.deepEqual((await client.json('/cgi-bin/warning.cgi')).WARNING, [])
  })

  test('work modes map onto the engine, including sleep', async () => {
    const post = (conf) => client.request('POST', '/cgi-bin/set_miner_conf.cgi', conf)
    assert.equal(JSON.parse((await post({ 'bitmain-work-mode': 1 })).text).code, 'M000')
    advance(60)
    assert.equal(miner.state, 'sleeping')
    assert.equal((await client.json('/cgi-bin/stats.cgi')).STATS[0]['miner-mode'], 1)
    assert.ok(minersOf('antminer')[0].powerW < 200)

    await post({ 'bitmain-work-mode': 2 })
    advance(2)
    assert.equal(miner.state, 'mining')
    assert.equal(miner.mode.name, 'high')
    await post({ 'bitmain-work-mode': 0 })
    assert.equal(miner.mode.name, 'normal')
    assert.equal(JSON.parse((await post({ 'bitmain-work-mode': 9 })).text).code, 'M001')
  })

  test('hashrate percent and pools are applied, and resending them changes nothing', async () => {
    const post = (conf) => client.request('POST', '/cgi-bin/set_miner_conf.cgi', conf)
    await post({ 'bitmain-freq-level': 80 })
    assert.equal(miner.powerScale, 0.8)
    await post({ 'bitmain-freq-level': 100 })

    const slots = [
      { url: 'stratum+tcp://custom.pool.sim:3333', user: 'a.1', pass: 'x' },
      { url: 'stratum+tcp://backup.pool.sim:3333', user: 'a.1', pass: 'x' },
      { url: '', user: '', pass: '' }
    ]
    await post({ pools: slots })
    assert.equal(miner.pools[0].url, slots[0].url)
    advance(30)
    const accepted = miner.pools[0].accepted
    await post({ pools: slots })
    assert.equal(miner.pools[0].accepted, accepted, 'an unchanged list keeps its counters')
    assert.equal((await client.json('/cgi-bin/pools.cgi')).POOLS[2].status, 'Dead', 'an empty slot never connects')
    assert.equal(JSON.parse((await post({ pools: slots.slice(0, 2) })).text).code, 'M001')
  })

  test('LED and reboot work, and a rebooting miner refuses connections', async () => {
    assert.equal(JSON.parse((await client.request('POST', '/cgi-bin/blink.cgi', { blink: true })).text).code, 'B000')
    assert.equal(miner.led, true)
    assert.equal(JSON.parse((await client.request('POST', '/cgi-bin/blink.cgi', { blink: false })).text).code, 'B100')

    assert.equal((await client.request('GET', '/cgi-bin/reboot.cgi')).text, 'OK')
    assert.equal(miner.state, 'booting')
    await assert.rejects(client.json('/cgi-bin/summary.cgi'), /ECONNRESET|socket hang up/)
    advance(200)
    assert.ok((await client.json('/cgi-bin/summary.cgi')).SUMMARY[0].elapsed > 0)
  })
})

function lux (port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(JSON.stringify(request)))
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString().replace(/\0+$/, ''))))
    socket.on('error', reject)
  })
}

describe('LuxOS', () => {
  let miner
  const SNAPSHOT = 'version+config+summary+devs+pools+temps+fans+power+events'

  before(() => { miner = minersOf('luxos')[0] })

  const session = async (fn) => {
    const { SESSION: [{ SessionID: id }] } = await lux(miner.port, { command: 'logon' })
    assert.ok(id)
    try {
      return await fn(id)
    } finally {
      await lux(miner.port, { command: 'logoff', parameter: id })
    }
  }

  test('the Worker’s combined snapshot answers every section successfully', async () => {
    const body = await lux(miner.port, { command: SNAPSHOT })
    for (const name of SNAPSHOT.split('+')) {
      assert.equal(body[name][0].STATUS[0].STATUS, 'S', name)
    }
    const summary = body.summary[0].SUMMARY[0]
    assert.ok(Math.abs(summary['GHS 5s'] / 1000 - miner.ths) < 0.5)
    assert.equal(typeof summary.Elapsed, 'number')
    const devs = body.devs[0].DEVS
    assert.equal(devs.length, 3)
    assert.ok(devs.every((d) => typeof d['Nominal MHS'] === 'number' && d.Status === 'Alive'))
    assert.ok(Math.abs(body.power[0].POWER[0].Watts - miner.powerW) <= 40)
    assert.deepEqual(body.events[0].EVENTS, [])
    assert.equal(body.config[0].CONFIG[0].CurtailMode, 'None')
  })

  test('a multi-command request cannot take parameters', async () => {
    assert.equal((await lux(miner.port, { command: 'version+config', parameter: 'x' })).STATUS[0].STATUS, 'E')
    assert.equal((await lux(miner.port, { command: 'nope' })).STATUS[0].STATUS, 'E')
    assert.equal((await lux(miner.port, {})).STATUS[0].STATUS, 'E')
  })

  test('session commands need the active session, and only one can be open', async () => {
    assert.equal((await lux(miner.port, { command: 'rebootdevice', parameter: 'bogus' })).STATUS[0].STATUS, 'E')
    assert.equal(miner.state, 'mining')
    await session(async () => {
      const second = await lux(miner.port, { command: 'logon' })
      assert.equal(second.STATUS[0].STATUS, 'E')
    })
  })

  test('curtail sleeps and wakes, and shows as the Worker expects', async () => {
    await session((id) => lux(miner.port, { command: 'curtail', parameter: `${id},sleep` }))
    advance(60)
    assert.equal(miner.state, 'sleeping')
    assert.equal((await lux(miner.port, { command: 'config' })).CONFIG[0].CurtailMode, 'Sleep')
    await session((id) => lux(miner.port, { command: 'curtail', parameter: `${id},wakeup` }))
    advance(2)
    assert.equal(miner.state, 'mining')
  })

  test('profiles change the engine’s work mode', async () => {
    const names = (await lux(miner.port, { command: 'profiles' })).PROFILES.map((p) => p['Profile Name'])
    assert.deepEqual(names.sort(), ['450MHz', '750MHz', 'default'])
    await session((id) => lux(miner.port, { command: 'profileset', parameter: `${id},450MHz` }))
    assert.equal(miner.mode.name, 'eco')
    assert.equal((await lux(miner.port, { command: 'config' })).CONFIG[0].Profile, '450MHz')
    await session((id) => lux(miner.port, { command: 'profileset', parameter: `${id},default` }))
    await session(async (id) => {
      assert.equal((await lux(miner.port, { command: 'profileset', parameter: `${id},nope` })).STATUS[0].STATUS, 'E')
    })
  })

  test('the Worker’s add-then-remove pool swap leaves only the new pools', async () => {
    const before = (await lux(miner.port, { command: 'pools' })).POOLS
    await lux(miner.port, { command: 'addpool', parameter: 'stratum+tcp://lux.pool.sim:700,acct.w,x' })
    let list = (await lux(miner.port, { command: 'pools' })).POOLS
    assert.equal(list.length, before.length + 1)
    assert.ok(list.every((p, i) => p.POOL === i), 'IDs are list positions')
    for (let id = before.length - 1; id >= 0; id--) await lux(miner.port, { command: 'removepool', parameter: String(id) })
    list = (await lux(miner.port, { command: 'pools' })).POOLS
    assert.equal(list.length, 1)
    assert.equal(list[0].URL, 'stratum+tcp://lux.pool.sim:700')
    assert.equal((await lux(miner.port, { command: 'removepool', parameter: '9' })).STATUS[0].STATUS, 'E')
    advance(5)
    assert.equal(miner.activePool, 0)
  })

  test('faults appear as events, which the Worker reads as errors', async () => {
    sim.injectFault({ type: 'psu_failure', target: `miner:${miner.id}` })
    advance(3)
    const { EVENTS } = await lux(miner.port, { command: 'events' })
    assert.ok(EVENTS.some((e) => e.Code === 'PSU_FAILURE' && e.Severity.toLowerCase() !== 'info'))
    clear()
    advance(200)
    assert.equal(miner.state, 'mining')
  })

  test('reboot through a session, then the miner refuses connections', async () => {
    await session((id) => lux(miner.port, { command: 'rebootdevice', parameter: id }).catch(() => {})).catch(() => {})
    assert.equal(miner.state, 'booting')
    assert.equal(await connectionRefused(miner.port, '{}'), 'ECONNRESET')
    advance(200)
    miner.luxSession = null
    assert.ok((await lux(miner.port, { command: 'version' })).VERSION[0].LUXminer)
  })
})

// The SealMiner Worker half-closes its side once the request is written.
function seal (port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(JSON.stringify(request)))
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString().replace(/\0+$/, '').trim()
      resolve(JSON.parse(text))
    })
    socket.on('error', reject)
  })
}

describe('SealMiner', () => {
  let miner

  before(() => { miner = minersOf('sealminer')[0] })

  const ascset = (sub, args) => seal(miner.port, {
    command: 'ascset',
    parameter: args ? `0,${sub},${JSON.stringify(args)}` : `0,${sub}`
  })

  test('reads answer in the captured firmware shape', async () => {
    const stats = (await seal(miner.port, { command: 'stats' })).STATS[0]
    assert.equal(stats['PM State'], 'Running')
    assert.equal(stats['Mining Mode'], 'Normal')
    assert.equal(stats.Model, 'A2')
    assert.equal(stats['Board Count'], 3)
    assert.equal(stats['Fan Count'], 4)
    assert.equal(stats['Error Code'], '')
    assert.ok(Math.abs(stats['MHS(30s)'] / 1e6 - miner.ema.s30) < 0.5)
    assert.equal(stats['0 Online'], true)
    assert.equal(typeof stats['0 Temp 3'], 'number')
    assert.equal(stats['PSU Error'], '0x00000000')
    assert.ok(Math.abs(stats['PSU Input Power'] - miner.powerW) <= 40)

    for (const [command, section] of [['version', 'VERSION'], ['summary', 'SUMMARY'], ['config', 'CONFIG'], ['devs', 'DEVS'], ['pools', 'POOLS'], ['devdetails', 'DEVDETAILS'], ['coin', 'COIN']]) {
      const body = await seal(miner.port, { command })
      assert.equal(body.id, 1, 'id 0 would mean a truncated reply')
      assert.ok(Array.isArray(body[section]), section)
    }
    assert.equal((await seal(miner.port, { command: 'nope' })).STATUS[0].STATUS, 'E')
  })

  test('suspend and resume work, and suspend is not a fault', async () => {
    await ascset('suspend')
    advance(60)
    assert.equal(miner.state, 'sleeping')
    const stats = (await seal(miner.port, { command: 'stats' })).STATS[0]
    assert.equal(stats['PM State'], 'Suspended')
    assert.equal(stats['PSU Error'], '0x00000040')
    assert.equal(stats['Error Code'], '')
    assert.equal(stats['0 Speed'], 0)
    await ascset('resume')
    advance(2)
    assert.equal(miner.state, 'mining')
  })

  test('values must be JSON strings, as on real firmware', async () => {
    assert.match((await ascset('powerlimit', { value: 3000 })).STATUS[0].Msg, /Missing "value"/)
    assert.equal((await ascset('powerlimit', { value: '3000' })).STATUS[0].STATUS, 'S')
    assert.ok(Math.abs(miner.powerScale - 3000 / 4300) < 0.001)
    assert.equal((await seal(miner.port, { command: 'stats' })).STATS[0]['Power Limit'], 3000)
    await ascset('powerlimit', { value: '4300' })
    assert.equal(miner.powerScale, 1)
    assert.match((await ascset('workmode', { mode: 1 })).STATUS[0].Msg, /Missing "mode"/)
    assert.equal((await ascset('workmode', { mode: 'nope' })).STATUS[0].STATUS, 'E')
  })

  test('work modes map to the firmware’s labels', async () => {
    await ascset('workmode', { mode: 'high_performance' })
    assert.equal(miner.mode.name, 'high')
    assert.equal((await seal(miner.port, { command: 'stats' })).STATS[0]['Mining Mode'], 'High Performance')
    await ascset('workmode', { mode: 'low_power' })
    assert.equal((await seal(miner.port, { command: 'stats' })).STATS[0]['Mining Mode'], 'Low Power')
    await ascset('workmode', { mode: 'normal' })
    await ascset('workmode', { mode: 'sleep' })
    advance(2)
    assert.equal(miner.state, 'sleeping')
    await ascset('resume')
    advance(2)
  })

  test('help lists the commands, and settings without physics are accepted', async () => {
    const help = await ascset('help')
    assert.equal(help.STATUS[0].STATUS, 'I')
    assert.match(help.STATUS[0].Msg, /resume/)
    assert.equal((await ascset('timezone', { value: 'UTC' })).STATUS[0].STATUS, 'S')
    assert.equal((await ascset('nope')).STATUS[0].STATUS, 'E')
    assert.equal((await seal(miner.port, { command: 'ascset', parameter: '0,workmode,{bad' })).STATUS[0].Code, 23)
  })

  test('updatepools replaces the list, and rejects bad input', async () => {
    const parameter = JSON.stringify({ pools: [{ url: 'stratum+tcp://seal.pool.sim:3333', user: 'u.1', pass: 'x' }] })
    assert.equal((await seal(miner.port, { command: 'updatepools', parameter })).STATUS[0].STATUS, 'S')
    assert.equal(miner.pools.length, 1)
    advance(3)
    const pools = (await seal(miner.port, { command: 'pools' })).POOLS
    assert.equal(pools[0].URL, 'stratum+tcp://seal.pool.sim:3333')
    assert.equal(pools[0]['Stratum Active'], true)
    assert.equal((await seal(miner.port, { command: 'updatepools', parameter: '{"pools":[]}' })).STATUS[0].Code, 8)
    assert.equal((await seal(miner.port, { command: 'updatepools', parameter: 'bad' })).STATUS[0].Code, 23)
  })

  test('faults appear in the fields the Worker’s health check reads', async () => {
    sim.injectFault({ type: 'hashboard_failure', target: `miner:${miner.id}` })
    advance(5)
    let stats = (await seal(miner.port, { command: 'stats' })).STATS[0]
    assert.equal(stats['2 Online'], false)
    assert.equal(stats['2 Low Hash'], true)
    assert.ok(stats['Error Code'])
    clear()

    sim.injectFault({ type: 'psu_failure', target: `miner:${miner.id}` })
    advance(5)
    stats = (await seal(miner.port, { command: 'stats' })).STATS[0]
    assert.equal(stats['PSU Error'], '0x00000080')
    clear()
    advance(200)
  })

  test('reboot answers, then the miner refuses connections', async () => {
    assert.equal((await seal(miner.port, { command: 'reboot' })).STATUS, 'REBOOT')
    assert.equal(miner.state, 'booting')
    assert.equal(await connectionRefused(miner.port, '{}'), 'ECONNRESET')
    advance(200)
  })
})

function frame (payload) {
  const body = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function wm (port, request, { split = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const packet = frame(request)
      if (!split) return socket.write(packet)
      socket.write(packet.subarray(0, 2))
      setTimeout(() => socket.write(packet.subarray(2)), 20)
    })
    let buffer = Buffer.alloc(0)
    socket.on('data', (c) => {
      buffer = Buffer.concat([buffer, c])
      if (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        resolve(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString()))
        socket.destroy()
      }
    })
    socket.on('error', reject)
  })
}

describe('Whatsminer', () => {
  let miner
  let salt

  before(async () => {
    miner = minersOf('whatsminer')[0]
    salt = (await wm(miner.port, { cmd: 'get.device.info', param: 'salt' })).msg.salt
  })

  // SHA256(cmd + password + salt + ts); the first 8 Base64 characters are the
  // token and the full digest is the AES key.
  const write = (cmd, param, { password = 'super', sensitive = false, account = 'admin' } = {}) => {
    const ts = Math.floor(Date.now() / 1000)
    const key = crypto.createHash('sha256').update(`${cmd}${password}${salt}${ts}`).digest()
    const request = { cmd, ts, token: key.toString('base64').substring(0, 8), account }
    if (sensitive) {
      const cipher = crypto.createCipheriv('aes-256-ecb', key, null)
      request.param = Buffer.concat([cipher.update(JSON.stringify(param)), cipher.final()]).toString('base64')
    } else if (param !== undefined) {
      request.param = param
    }
    return wm(miner.port, request)
  }

  test('reads answer with engine values, including split frames', async () => {
    assert.ok(salt)
    const { code, msg } = await wm(miner.port, { cmd: 'get.miner.status', param: 'summary+pools' }, { split: true })
    assert.equal(code, 0)
    assert.ok(Math.abs(msg.summary['hash-realtime'] - miner.ths) < 0.5)
    assert.ok(Math.abs(msg.summary['power-realtime'] - miner.powerW) <= 40)
    assert.equal(msg.pools[0].status, 'alive')
    assert.equal(msg.summary['board-temperature'].length, 3)

    const edevs = (await wm(miner.port, { cmd: 'get.miner.status', param: 'edevs' })).msg.edevs
    assert.equal(edevs.length, 3)
    assert.equal((await wm(miner.port, { cmd: 'get.miner.setting' })).msg['power-mode'], 'normal')
    assert.deepEqual((await wm(miner.port, { cmd: 'get.device.info', param: 'error-code' })).msg['error-code'], [])
    assert.equal((await wm(miner.port, { cmd: 'get.nope' })).code, -2)
  })

  test('writes need a valid token', async () => {
    assert.equal((await write('set.miner.service', 'stop', { password: 'wrong' })).code, -4)
    assert.equal((await write('set.miner.service', 'stop', { account: '' })).code, -4)
    assert.equal((await wm(miner.port, { cmd: 'set.miner.service', param: 'stop' })).code, -4)
    assert.equal(miner.suspended, false)
  })

  test('service stop and start sleep and wake the miner', async () => {
    assert.equal((await write('set.miner.service', 'stop')).code, 0)
    advance(60)
    assert.equal(miner.state, 'sleeping')
    // The Worker reads zero hashrate with no errors as sleeping.
    const { msg } = await wm(miner.port, { cmd: 'get.miner.status', param: 'summary' })
    assert.ok(msg.summary['power-realtime'] < 200)
    assert.equal(msg.summary['hash-average'], 0)
    assert.equal((await write('set.miner.service', 'start')).code, 0)
    advance(2)
    assert.equal(miner.state, 'mining')
    assert.equal((await write('set.miner.service', 'explode')).code, -1)
  })

  test('power mode and percent reach the engine', async () => {
    await write('set.miner.power_mode', 'low')
    assert.equal(miner.mode.name, 'eco')
    assert.equal((await wm(miner.port, { cmd: 'get.miner.setting' })).msg['power-mode'], 'low')
    await write('set.miner.power_mode', 'normal')
    assert.equal((await write('set.miner.power_mode', 'nope')).code, -1)

    assert.equal((await write('set.miner.power_percent', { percent: 70, mode: 'normal' })).code, -1, 'the firmware wants a string')
    assert.equal((await write('set.miner.power_percent', { percent: '70', mode: 'normal' })).code, 0)
    assert.equal(miner.powerScale, 0.7)
    await write('set.miner.power_percent', { percent: '100', mode: 'normal' })
  })

  test('pools must be encrypted with the per-command key', async () => {
    const pools = [{ pool: 'stratum+tcp://wm.pool.sim:3333', worker: 'a.1', passwd: 'x' }]
    assert.equal((await write('set.miner.pools', pools)).code, -1, 'plain text is refused')
    assert.equal((await write('set.miner.pools', pools, { sensitive: true })).code, 0)
    assert.equal(miner.pools[0].url, 'stratum+tcp://wm.pool.sim:3333')
    assert.equal(miner.pools[0].user, 'a.1')
    advance(3)
    assert.equal(miner.activePool, 0)
  })

  test('faults appear in the error list', async () => {
    sim.injectFault({ type: 'hashboard_failure', target: `miner:${miner.id}` })
    const { msg } = await wm(miner.port, { cmd: 'get.device.info', param: 'error-code' })
    assert.equal(msg['error-code'].length, 1)
    assert.ok(Number.isInteger(Number(Object.keys(msg['error-code'][0])[0])))
    clear()
  })

  test('LED and reboot work', async () => {
    await write('set.system.led', { color: 'red', period: 500, duration: 200, start: 0 })
    assert.equal(miner.led, true)
    await write('set.system.led', 'auto')
    assert.equal(miner.led, false)
    assert.equal((await write('set.system.reboot')).code, 0)
    assert.equal(miner.state, 'booting')
    assert.equal(await connectionRefused(miner.port), 'ECONNRESET')
    advance(200)
  })

  test('an oversized frame closes the connection', async () => {
    const result = await new Promise((resolve) => {
      const socket = net.connect(miner.port, '127.0.0.1', () => {
        const header = Buffer.alloc(4)
        header.writeUInt32LE(50 * 1024 * 1024, 0)
        socket.write(header)
      })
      socket.on('close', () => resolve('closed'))
      socket.on('data', () => resolve('answered'))
      socket.on('error', () => {})
    })
    assert.equal(result, 'closed')
  })
})

describe('Proto', () => {
  let miner
  let token

  before(() => { miner = minersOf('proto')[0] })

  async function call (method, path, body, auth = token) {
    const res = await fetch(`http://127.0.0.1:${miner.port}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json() }
  }

  test('login gives a token, and everything else requires one', async () => {
    assert.equal((await call('GET', '/mining', undefined, null)).status, 401)
    assert.equal((await call('POST', '/auth/login', { password: 'wrong' }, null)).status, 401)
    const { status, body } = await call('POST', '/auth/login', { password: 'proto-sim-password' }, null)
    assert.equal(status, 200)
    token = body.access_token
    assert.ok(body.refresh_token)
    assert.equal((await call('GET', '/mining')).status, 200)
  })

  test('refresh rotates tokens and revokes the old one', async () => {
    const login = await call('POST', '/auth/login', { password: 'proto-sim-password' }, null)
    const refreshed = await call('POST', '/auth/refresh', { refresh_token: login.body.refresh_token }, null)
    assert.equal(refreshed.status, 200)
    assert.equal((await call('GET', '/mining', undefined, login.body.access_token)).status, 401)
    assert.equal((await call('POST', '/auth/refresh', { refresh_token: 'stale' }, null)).status, 401)
    token = refreshed.body.access_token
  })

  test('reads carry engine values with the units the Worker checks', async () => {
    const { 'mining-status': mining } = (await call('GET', '/mining')).body
    assert.equal(mining.status, 'Mining')
    assert.ok(Math.abs(mining.power_usage_watts - miner.powerW) <= 40)
    assert.equal(typeof mining.reboot_uptime_s, 'number')

    const telemetry = (await call('GET', '/telemetry?level=hashboard')).body
    assert.equal(telemetry.miner.hashrate.unit, 'TH/s')
    assert.ok(Math.abs(telemetry.miner.hashrate.value - miner.ths) < 0.5)
    assert.equal(telemetry.hashboards.length, 2, 'the R2 has two boards')
    assert.equal(telemetry.hashboards[0].temperature.unit, '°C')

    assert.equal((await call('GET', '/mining/target')).body.power_target_watts, 3250)
    assert.equal((await call('GET', '/pools')).body.pools[0].status, 'Active')
    assert.deepEqual((await call('GET', '/errors')).body, [])
    for (const [path, key] of [['/cooling', 'cooling-status'], ['/hardware/psus', 'psus-info'], ['/hashboards', 'hashboards-info'], ['/network', 'network-info'], ['/system', 'system-info']]) {
      assert.ok((await call('GET', path)).body[key], path)
    }
    const serial = (await call('GET', '/hashboards')).body['hashboards-info'][0].hb_sn
    assert.equal((await call('GET', `/hashboards/${serial}`)).body['hashboard-stats'].status, 'Running')
    assert.equal((await call('GET', '/hashboards/nope')).status, 404)
    assert.equal((await call('GET', '/nope')).status, 404)
  })

  test('start and stop change the mining status', async () => {
    await call('POST', '/mining/stop')
    advance(60)
    assert.equal(miner.state, 'sleeping')
    assert.equal((await call('GET', '/mining')).body['mining-status'].status, 'Stopped')
    await call('POST', '/mining/start')
    advance(2)
    assert.equal((await call('GET', '/mining')).body['mining-status'].status, 'Mining')
  })

  test('the power target drives the engine, within the firmware’s range', async () => {
    assert.equal((await call('PUT', '/mining/target', { power_target_watts: 2000 })).status, 200)
    assert.ok(Math.abs(miner.powerScale - 2000 / 3250) < 0.001)
    advance(600)
    assert.ok(miner.powerW < 2500)
    assert.equal((await call('GET', '/mining/target')).body.power_target_watts, 2000)
    await call('PUT', '/mining/target', { power_target_watts: 3250 })
    assert.equal((await call('PUT', '/mining/target', { power_target_watts: 99 })).status, 400)
    assert.equal((await call('PUT', '/mining/target', {})).status, 400)
    await call('PUT', '/mining/target', { performance_mode: 'Efficiency' })
    assert.equal(miner.mode.name, 'eco')
    await call('PUT', '/mining/target', { performance_mode: 'MaximumHashrate' })
    assert.equal((await call('PUT', '/mining/target', { performance_mode: 'Nope' })).status, 400)
  })

  test('pools replace the list', async () => {
    const { status } = await call('POST', '/pools', [{ url: 'stratum+tcp://proto.pool.sim:3333', username: 'u.1', password: 'x', name: 'main', priority: 0 }])
    assert.equal(status, 200)
    assert.equal(miner.pools.length, 1)
    advance(3)
    assert.equal((await call('GET', '/pools')).body.pools[0].status, 'Active')
    assert.equal((await call('POST', '/pools', { nope: 1 })).status, 400)
  })

  test('faults appear as errors and a degraded status', async () => {
    sim.injectFault({ type: 'hashboard_failure', target: `miner:${miner.id}` })
    advance(3)
    assert.equal((await call('GET', '/mining')).body['mining-status'].status, 'DegradedMining')
    assert.equal((await call('GET', '/errors')).body[0].error_code, 'HashboardFault')
    clear()
    advance(3)
    for (const id of sim.pools.keys()) sim.injectFault({ type: 'pool_outage', target: `pool:${id}` })
    advance(3)
    assert.equal((await call('GET', '/mining')).body['mining-status'].status, 'NoPools')
    clear()
    advance(3)
  })

  test('locate and reboot work, and tokens survive the reboot', async () => {
    assert.equal((await call('POST', '/system/locate?enable=true')).body.locating, true)
    assert.equal(miner.led, true)
    await call('POST', '/system/locate?enable=false')
    assert.equal((await call('POST', '/system/reboot')).body.rebooting, true)
    assert.equal(miner.state, 'booting')
    await assert.rejects(call('GET', '/mining'))
    advance(200)
    assert.equal((await call('GET', '/mining')).status, 200)
  })
})

describe('across brands', () => {
  test('simulated HTTP devices don’t offer connections for reuse', async () => {
    const statusOf = (port, path) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        res.resume()
        resolve(res.headers.connection)
      }).on('error', reject)
    })
    assert.equal(await statusOf(minersOf('proto')[1].port, '/api/v1/mining'), 'close')
    assert.equal(await statusOf(minersOf('antminer')[1].port, '/cgi-bin/summary.cgi'), 'close')
    assert.equal(await statusOf(PORTS.pool, '/v2/assets/balance'), 'close')
  })

  test('a miner with no network resets connections on every protocol', async () => {
    for (const model of Object.keys(MODELS)) {
      const miner = minersOf(model)[1]
      sim.injectFault({ type: 'network_loss', target: `miner:${miner.id}` })
      assert.equal(await connectionRefused(miner.port, '{}'), 'ECONNRESET', model)
    }
    clear()
  })

  test('a slow network delays replies on every protocol', async () => {
    const probes = {
      avalon: (m) => new Promise((resolve) => {
        const s = net.connect(m.port, '127.0.0.1', () => s.write('version'))
        s.on('data', () => {})
        s.on('end', resolve)
      }),
      antminer: (m) => new DigestClient(m.port)._raw('GET', '/cgi-bin/summary.cgi'),
      luxos: (m) => lux(m.port, { command: 'version' }),
      sealminer: (m) => seal(m.port, { command: 'version' }),
      whatsminer: (m) => wm(m.port, { cmd: 'get.miner.setting' }),
      proto: (m) => fetch(`http://127.0.0.1:${m.port}/api/v1/mining`)
    }
    for (const [model, probe] of Object.entries(probes)) {
      const miner = minersOf(model)[1]
      sim.injectFault({ type: 'network_latency', target: `miner:${miner.id}`, params: { delayMs: 200 } })
      const started = Date.now()
      await probe(miner)
      assert.ok(Date.now() - started >= 180, model)
    }
    clear()
  })

  test('a site-wide outage takes every brand down, and they all return', async () => {
    sim.injectFault({ type: 'grid_outage' })
    advance(5)
    for (const model of Object.keys(MODELS)) {
      assert.equal(await connectionRefused(minersOf(model)[1].port, '{}'), 'ECONNRESET', model)
    }
    clear()
    advance(300)
    assert.equal(sim.fleetCounts().mining + sim.fleetCounts().sleeping, sim.miners.length)
  })

  test('connections are counted by brand', () => {
    const seen = runner.stats.view()
    for (const model of Object.keys(MODELS)) assert.ok(seen[model]?.requests > 0, model)
  })

  test('writes are logged under the protocol that sent them', () => {
    const sources = new Set(sim.events.map((e) => e.source))
    for (const source of ['antminer', 'luxos', 'sealminer', 'whatsminer', 'proto']) assert.ok(sources.has(source), source)
  })

  test('the MDK config lists every brand at a port that answers', async () => {
    const config = runner.mdkConfig()
    const expected = { antminer: 2, whatsminer: 2, sealminer: 2, luxos: 2, proto: 2 }
    for (const [model, count] of Object.entries(expected)) {
      assert.equal(config[model].devices.length, count, model)
      assert.ok(config[model].worker, model)
      for (const device of config[model].devices) {
        assert.equal(device.deviceId, sim.miners.find((m) => m.port === device.config.port).id)
      }
    }
    assert.equal(config.avalon.seedDevices.length, 2)
    assert.equal(config.whatsminer.devices[0].config.apiVersion, '3.0.3')
    const proto = config.proto.devices[0].config
    const login = await fetch(`http://127.0.0.1:${proto.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: proto.password })
    })
    assert.equal(login.status, 200, 'the published password works')
  })
})

describe('changing the fleet with devices running', () => {
  const FLEET_PORTS = { api: 0, minerBase: 46030, meter: 47020, sensorBase: 47021, pool: 49000 }
  let live

  const ping = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })

  before(async () => {
    live = new Runner(buildConfig({ seed: 5, fleet: { containers: 1, minersPerContainer: 3, mix: { avalon: 1 } }, ports: FLEET_PORTS }))
    await live.startProtocols()
  })

  after(() => live.stop())

  test('new miners and sensors answer on their new ports, and removed ones stop', async () => {
    assert.equal(await ping(46033), false)
    await live.applyFleet({ containers: 2, minersPerContainer: 2, counts: { antminer: 2, luxos: 2 } })
    for (const miner of live.sim.miners) assert.equal(await ping(miner.port), true, miner.id)
    assert.equal(await ping(47022), true, 'the second container has a sensor')
    assert.equal(live.sim.miners[0].model, 'antminer')
    const reply = await new DigestClient(live.sim.miners[0].port)._raw('GET', '/cgi-bin/summary.cgi')
    assert.equal(reply.status, 401, 'port 46030 now speaks Antminer')
    assert.equal((await lux(live.sim.miners[2].port, { command: 'version' })).VERSION.length, 1)

    await live.applyFleet({ containers: 1, minersPerContainer: 1, counts: { proto: 1 } })
    assert.equal(await ping(46031), false)
    assert.equal(await ping(47022), false)
    assert.equal(await ping(FLEET_PORTS.meter), true, 'the meter stays up')
    assert.equal(await ping(FLEET_PORTS.pool), true, 'the pool API stays up')
  })

  test('if a port is taken, the old fleet comes back and still answers', async () => {
    await live.applyFleet({ containers: 1, minersPerContainer: 2, counts: { avalon: 2 } })
    const before = live.generation
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen(46033, '127.0.0.1', resolve))
    try {
      await assert.rejects(
        live.applyFleet({ containers: 1, minersPerContainer: 6, counts: { proto: 6 } }),
        /ERR_FLEET_PORT_IN_USE: port 46033/
      )
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
    assert.equal(live.generation, before)
    assert.equal(live.sim.miners.length, 2)
    assert.equal(live.sim.miners[0].model, 'avalon')
    assert.equal(live.fleetView().counts.avalon, 2)
    assert.equal(await ping(46030), true)
    assert.equal(await ping(46034), false, 'the attempted fleet left nothing behind')
  })

  test('only one fleet change runs at a time', async () => {
    const results = await Promise.allSettled([
      live.applyFleet({ containers: 1, minersPerContainer: 1, counts: { luxos: 1 } }),
      live.applyFleet({ containers: 1, minersPerContainer: 2, counts: { proto: 2 } })
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.match(results[1].reason.message, /ERR_FLEET_CHANGE_IN_PROGRESS/)
    assert.equal(live.sim.miners.length, 1)
  })

  test('a config with its own settings keeps them across a change', async () => {
    const custom = new Runner(buildConfig({ seed: 77, fleet: { containers: 1, minersPerContainer: 2 }, grid: { contractKw: 123 }, environment: { pricePeak: 0.5 } }))
    await custom.applyFleet({ containers: 1, minersPerContainer: 4, counts: { avalon: 4 } })
    assert.equal(custom.cfg.seed, 77)
    assert.equal(custom.cfg.grid.contractKw, 123)
    assert.equal(custom.cfg.environment.pricePeak, 0.5)
    assert.equal(custom.sim.miners.length, 4)
  })

  test('without device servers, a change only rebuilds the model', async () => {
    const quiet = new Runner(buildConfig({ fleet: { containers: 1, minersPerContainer: 2 }, ports: { minerBase: 46500 } }))
    await quiet.applyFleet({ containers: 1, minersPerContainer: 3, counts: { proto: 3 } })
    assert.equal(quiet.sim.miners.length, 3)
    assert.equal(await ping(quiet.sim.miners[0].port), false)
  })
})
