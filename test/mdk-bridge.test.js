'use strict'

// The bridge's translation, using telemetry captured from the real Workers. The
// bridge with a live Kernel runs through mdk/start.js.

const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { normalizeMiner, normalizeMeter, normalizeSensor, commandFor } = require('../mdk/normalize')
const { MdkBridge } = require('../mdk/bridge')
const fixtures = require('./fixtures/mdk-telemetry.json')

const entry = (model) => ({ id: `${model}-1`, c: 'c1', model, nth: 100, nw: 3000 })
const BRANDS = ['avalon', 'antminer', 'whatsminer', 'sealminer', 'luxos', 'proto']
const load = () => import('../public/mdk-view.mjs')

describe('reading real Worker telemetry', () => {
  for (const brand of BRANDS) {
    test(`${brand}: a healthy miner reads as mining`, () => {
      const m = normalizeMiner(fixtures.healthy[brand], entry(brand))
      assert.equal(m.s, 'mining', 'running means mining too')
      assert.equal(m.net, true)
      assert.ok(m.ths > 50, `hashrate ${m.ths}`)
      assert.ok(m.w > 2000, `power ${m.w}`)
      assert.ok(m.temp > 50 && m.temp < 90, `temp ${m.temp}`)
      assert.ok(m.fan > 50 && m.fan <= 100, `fan ${m.fan}`)
      assert.deepEqual(m.flt, [], 'no faults, and informational entries don’t count')
      assert.equal(m.hot, false)
    })

    test(`${brand}: an unreachable miner is marked, not shown as healthy or zeroed into idle`, () => {
      const failed = Object.fromEntries(Object.keys(fixtures.healthy[brand]).map((k) => [k, { error: 'ERR_CONNECTION' }]))
      const m = normalizeMiner(failed, entry(brand))
      assert.equal(m.net, false)
      assert.equal(m.s, 'unknown')
      assert.equal(m.ths, 0)
      assert.equal(m.w, 0)
    })
  }

  test('no telemetry at all is treated the same way', () => {
    const m = normalizeMiner({}, entry('avalon'))
    assert.equal(m.net, false)
    assert.equal(m.s, 'unknown')
  })

  test('board faults are recognised where the Worker reports them', () => {
    for (const brand of ['antminer', 'whatsminer', 'sealminer', 'luxos']) {
      const raw = fixtures.faults.hashboard_failure[brand]
      const m = normalizeMiner({ ...fixtures.healthy[brand], status: raw.status, errors: raw.errors }, entry(brand))
      assert.ok(m.flt.includes('board'), `${brand}: ${m.flt}`)
    }
  })

  test('fan faults are recognised where the Worker reports them', () => {
    for (const brand of ['antminer', 'luxos']) {
      const raw = fixtures.faults.fan_failure[brand]
      const m = normalizeMiner({ ...fixtures.healthy[brand], status: raw.status, errors: raw.errors }, entry(brand))
      assert.ok(m.flt.includes('fan'), `${brand}: ${m.flt}`)
    }
  })

  test('faults are named however each brand spells them', () => {
    const named = (error) => normalizeMiner({ ...fixtures.healthy.antminer, status: 'error', errors: [error] }, entry('antminer')).flt
    assert.deepEqual(named({ code: 'W_FAN' }), ['fan'])
    assert.deepEqual(named({ code: 'FanFault' }), ['fan'])
    assert.deepEqual(named({ name: 'fan_speed_error' }), ['fan'])
    assert.deepEqual(named({ name: 'hashboard_temp_overheating' }), ['temp'])
    assert.deepEqual(named({ name: 'control_board_exception' }), ['ctrl'])
    assert.deepEqual(named({ code: 'alert.hashboard_offline' }), ['board'])
    assert.deepEqual(named({ name: 'power_error_status' }), ['psu'])
    assert.deepEqual(named({ code: 'PsuFault' }), ['psu'])
    assert.deepEqual(named({ name: 'all_pools_dead' }), ['pool'])
  })

  test('a code MDK reports but doesn’t name still counts as a fault', () => {
    const raw = fixtures.faults.hashboard_failure.proto
    const m = normalizeMiner({ ...fixtures.healthy.proto, status: raw.status, errors: raw.errors }, entry('proto'))
    assert.ok(m.flt.includes('board'), `${m.flt}`)
    const unnamed = normalizeMiner({ ...fixtures.healthy.proto, status: 'error', errors: [{ name: 'firmware_error' }] }, entry('proto'))
    assert.deepEqual(unnamed.flt, ['error'])
  })

  test('the known Avalon blind spot stays visible: a failed board reads as healthy', () => {
    const raw = fixtures.faults.hashboard_failure.avalon
    assert.equal(raw.status, 'mining')
    assert.deepEqual(raw.errors, [])
  })

  test('a stalled fan reads low even if its duty cycle is high', () => {
    const raw = fixtures.faults.fan_failure.luxos
    const m = normalizeMiner({ ...fixtures.healthy.luxos, fans: raw.fans }, entry('luxos'))
    assert.ok(m.fan < 40, `read ${m.fan}%, from ${raw.fans[0].speed_pct}% duty at ${raw.fans[0].rpm} RPM`)
  })

  test('a miner reporting an error but still hashing stays mining, with a mark', () => {
    const m = normalizeMiner({ ...fixtures.healthy.antminer, status: 'error', errors: [{ code: 'W_FAN' }] }, entry('antminer'))
    assert.equal(m.s, 'mining')
    assert.deepEqual(m.flt, ['fan'])
    const stopped = normalizeMiner({ ...fixtures.healthy.antminer, status: 'error', hashrate_rt: 0, hashrate_avg: 0, errors: [{ code: 'W_PSU' }] }, entry('antminer'))
    assert.equal(stopped.s, 'failed')
  })

  test('SealMiner’s own status words are understood', () => {
    const asleep = normalizeMiner({ ...fixtures.healthy.sealminer, status: 'suspended', power: 38, hashrate_rt: 0, hashrate_avg: 0 }, entry('sealminer'))
    assert.equal(asleep.s, 'sleeping')
  })

  test('the meter shows a dead supply as zero volts, and copes with a failed read', () => {
    assert.equal(normalizeMeter(fixtures.meter).dead, false)
    assert.ok(normalizeMeter(fixtures.meter).powerKw > 400)
    assert.equal(normalizeMeter(fixtures.outageMeter).dead, true)
    const failed = normalizeMeter({ voltage: { error: 'x' }, active_power: { error: 'x' } })
    assert.equal(failed.dead, false, 'an unreadable meter isn’t a blackout')
    assert.equal(failed.powerKw, null)
  })

  test('sensors flag the error reading instead of reporting 850°C', () => {
    assert.equal(normalizeSensor(fixtures.sensor).temp, fixtures.sensor.temperature)
    assert.deepEqual(normalizeSensor({ temperature: 850 }), { temp: null, fault: true })
    assert.deepEqual(normalizeSensor({ temperature: { error: 'x' } }), { temp: null, fault: false })
  })
})

describe('commands per brand', () => {
  test('sleep works everywhere, and each brand wakes its own way', () => {
    for (const brand of BRANDS) assert.deepEqual(commandFor(brand, 'sleep'), ['setPowerMode', { mode: 'sleep' }])
    assert.deepEqual(commandFor('sealminer', 'wake'), ['resume', {}])
    assert.deepEqual(commandFor('proto', 'wake'), ['setPowerMode', { mode: 'normal' }])
  })

  test('modes map to each Worker’s own names', () => {
    assert.deepEqual(commandFor('antminer', 'mode', 'eco'), ['setPowerMode', { mode: 'low' }])
    assert.deepEqual(commandFor('sealminer', 'mode', 'high'), ['setPowerMode', { mode: 'high_performance' }])
    assert.deepEqual(commandFor('luxos', 'mode', 'eco'), ['setProfile', { profile: '450MHz' }])
    assert.deepEqual(commandFor('proto', 'mode', 'eco'), ['setPerformanceMode', { mode: 'Efficiency' }])
  })

  test('what a Worker can’t do comes back as nothing, rather than a wrong command', () => {
    assert.equal(commandFor('avalon', 'mode', 'eco'), null)
    assert.equal(commandFor('proto', 'mode', 'high'), null)
    assert.equal(commandFor('sealminer', 'led', true), null)
    assert.equal(commandFor('luxos', 'powerPct', 80), null)
    assert.equal(commandFor('antminer', 'selfDestruct'), null)
    assert.equal(commandFor('antminer', 'powerPct', 'lots'), null)
  })

  test('power limits use each Worker’s unit', () => {
    assert.deepEqual(commandFor('whatsminer', 'powerPct', 70), ['setPowerPct', { pct: 70 }])
    assert.deepEqual(commandFor('antminer', 'powerPct', 70), ['setHashratePercent', { pct: 70 }])
    assert.deepEqual(commandFor('proto', 'powerW', 2000), ['setPowerTarget', { watts: 2000 }])
    assert.deepEqual(commandFor('sealminer', 'powerW', 3000), ['setPowerLimit', { watts: 3000 }])
  })
})

describe('MDK’s view of the site', () => {
  const minerOf = (over) => ({ id: 'm1', c: 'c1', model: 'antminer', nth: 200, nw: 3400, s: 'mining', ths: 200, w: 3500, temp: 72, fan: 80, mode: 'normal', net: true, flt: [], hot: false, ...over })
  const state = (miners) => ({
    t: 100,
    clock: { day: 1, hour: 10, minute: 0 },
    miners,
    containers: [{ id: 'c1', name: 'Container 1', capacityKw: 200, availableKw: 150, inletC: 99, exhaustC: 99, heatKw: 999, fx: { coolingLoss: 0.5, pduOff: true, netDown: false, sensorFault: false } }],
    site: { limitKw: 468, breakerOpen: true, gridDown: false, powerKw: 999, breakerKw: 500, counts: {} }
  })
  const viewOf = (miners, over = {}) => ({ at: 1000, slowestMs: 50, miners, sensors: { c1: { inlet: { temp: 30, fault: false }, exhaust: { temp: 55, fault: false } } }, meter: { powerKw: 400, voltageV: 31000, dead: false }, containers: [{ id: 'c1', capacityKw: 200 }], ...over })

  test('nothing MDK could report leaks through from the simulator', async () => {
    const { mergeView } = await load()
    const merged = mergeView(state([minerOf()]), viewOf([minerOf({ ths: 111 })]), {}, 1000)
    assert.equal(merged.source, 'mdk')
    assert.equal(merged.miners[0].ths, 111)
    assert.equal(merged.site.powerKw, 400, 'from the meter')
    assert.equal(merged.containers[0].inletC, 30, 'from the sensor')
    assert.equal(merged.containers[0].exhaustC, 55)
    assert.ok(Math.abs(merged.containers[0].heatKw - 3.5) < 1e-9, 'added up from the miners')
    assert.equal(merged.site.limitKw, null, 'a utility limit isn’t an MDK reading')
    assert.equal(merged.site.breakerOpen, false, 'nor is the breaker')
    assert.equal(merged.containers[0].fx.coolingLoss, 0, 'nor is a cooling fault')
    assert.equal(merged.containers[0].fx.pduOff, false)
    assert.deepEqual(merged.clock, { day: 1, hour: 10, minute: 0 }, 'the clock stays with the panel')
  })

  test('zero volts means no grid, and every miner reads as off', async () => {
    const { mergeView } = await load()
    const view = viewOf([minerOf({ net: false, s: 'unknown', ths: 0, w: 0 })], { meter: { powerKw: 0, voltageV: 0, dead: true } })
    const merged = mergeView(state([minerOf()]), view, {}, 1000)
    assert.equal(merged.site.gridDown, true)
    assert.equal(merged.miners[0].s, 'off')
    assert.equal(merged.containers[0].fx.netDown, false, 'that’s the supply, not the network')
  })

  test('a dead supply overrides miners still reading as mining from a Worker cache', async () => {
    const { mergeView } = await load()
    const view = viewOf([minerOf({ id: 'c1-m001', s: 'mining', ths: 200, w: 3500 }), minerOf({ id: 'c1-m002', net: false, s: 'unknown', ths: 0, w: 0 })], { meter: { powerKw: 0, voltageV: 0, dead: true } })
    const { site, miners, containers } = mergeView(state(view.miners), view, {}, 1000)
    assert.equal(site.hashThs, 0)
    assert.equal(site.itKw, 0)
    assert.equal(containers[0].heatKw, 0)
    assert.equal(site.counts.mining, 0)
    assert.equal(site.counts.off, 2)
    assert.equal(site.counts.unreachable, 0)
    assert.ok(miners.every((m) => m.s === 'off'))
  })

  test('a silent container with a live supply can only be called unreachable', async () => {
    const { mergeView } = await load()
    const merged = mergeView(state([minerOf()]), viewOf([minerOf({ net: false, s: 'unknown', ths: 0, w: 0 })]), {}, 1000)
    assert.equal(merged.site.gridDown, false)
    assert.equal(merged.containers[0].fx.netDown, true)
    assert.equal(merged.site.counts.unreachable, 1)
  })

  test('with no meter it adds up the miners, and a lost sensor keeps its last value', async () => {
    const { mergeView } = await load()
    const memory = {}
    mergeView(state([minerOf()]), viewOf([minerOf()]), memory, 1000)
    const merged = mergeView(state([minerOf()]), viewOf([minerOf()], { meter: null, sensors: {} }), memory, 1000)
    assert.equal(merged.site.powerKw, 3.5)
    assert.equal(merged.containers[0].inletC, 30)
  })

  test('old readings are flagged', async () => {
    const { mergeView } = await load()
    assert.equal(mergeView(state([minerOf()]), viewOf([minerOf()]), {}, 2000).stale, false)
    assert.equal(mergeView(state([minerOf()]), viewOf([minerOf()]), {}, 9000).stale, true)
  })

  test('a sensor error shows on its container', async () => {
    const { mergeView } = await load()
    const merged = mergeView(state([minerOf()]), viewOf([minerOf()], { sensors: { c1: { inlet: { temp: null, fault: true } } } }), {}, 1000)
    assert.equal(merged.containers[0].fx.sensorFault, true)
  })

  test('the comparison finds each kind of difference, and nothing else', async () => {
    const { compareMiners } = await load()
    const same = compareMiners([minerOf()], [minerOf({ ths: 195, temp: 75 })])
    assert.equal(same.agree, 1, 'small gaps are normal')

    const why = (real, seen) => compareMiners([minerOf(real)], [minerOf(seen)]).diffs[0]?.why
    assert.match(why({ flt: ['board'] }, {}), /fault not reported: board/)
    assert.match(why({ ths: 200 }, { ths: 100 }), /hashrate 100 vs really 200/)
    assert.match(why({ temp: 95 }, { temp: 70 }), /temperature 70 vs really 95/)
    assert.match(why({ s: 'sleeping' }, {}), /MDK says mining, really sleeping/)
    assert.match(why({ s: 'tripped' }, {}), /really down/)
    assert.match(why({}, { net: false, s: 'unknown' }), /no answer, really mining/)
    assert.equal(why({ net: false, flt: ['net'] }, { net: false, s: 'unknown', flt: [] }), undefined, 'both agree it’s away')
    assert.match(compareMiners([minerOf()], []).diffs[0].why, /not in MDK/)
  })

  test('a changed fleet is noticed', async () => {
    const { viewMatchesFleet } = await load()
    const s = state([minerOf()])
    assert.equal(viewMatchesFleet(s, viewOf([minerOf()])), true)
    assert.equal(viewMatchesFleet(s, viewOf([minerOf({ id: 'other' })])), false)
    assert.equal(viewMatchesFleet(s, viewOf([])), false)
  })
})

describe('the bridge', () => {
  const siteMap = {
    containers: [{ id: 'c1', name: 'Container 1', capacityKw: 200 }],
    miners: [
      { id: 'c1-m001', c: 'c1', model: 'avalon', brand: 'Avalon', serial: 'AV1', nth: 110, nw: 3300 },
      { id: 'c1-m002', c: 'c1', model: 'antminer', brand: 'Antminer', serial: 'AN1', nth: 200, nw: 3420 },
      { id: 'c1-m003', c: 'c1', model: 'proto', brand: 'Proto', serial: 'PR1', nth: 95, nw: 3250 },
      { id: 'c1-m004', c: 'c1', model: 'luxos', brand: 'LuxOS', serial: 'LX1', nth: 140, nw: 3010 }
    ],
    sensors: [{ serial: 'SEN-c1-inlet', container: 'c1', channel: 'inlet' }],
    meter: { serial: 'METER' }
  }
  const workers = [
    { workerId: 'sim-avalon', deviceIds: ['uuid-av'] },
    { workerId: 'sim-antminer', deviceIds: ['c1-m002'] },
    { workerId: 'sim-proto', deviceIds: ['c1-m003'] },
    { workerId: 'sim-luxos', deviceIds: ['c1-m004'] },
    { workerId: 'sim-seneca', deviceIds: ['uuid-sen'] },
    { workerId: 'sim-satec', deviceIds: ['uuid-met'] },
    { workerId: 'sim-f2pool', deviceIds: ['sim-f2pool'] }
  ]
  const listings = {
    'uuid-av': [{ id: 'uuid-av', info: { serialNum: 'AV1' } }],
    'uuid-sen': [{ id: 'uuid-sen', info: { serialNum: 'SEN-c1-inlet' } }],
    'uuid-met': [{ id: 'uuid-met', info: { serialNum: 'METER' } }]
  }
  const metrics = {
    'uuid-av': fixtures.healthy.avalon,
    'c1-m002': fixtures.healthy.antminer,
    'c1-m003': fixtures.healthy.proto,
    'c1-m004': fixtures.healthy.luxos,
    'uuid-sen': fixtures.sensor,
    'uuid-met': fixtures.meter
  }
  const sent = []
  let outcome = { status: 'SUCCESS' }
  let offline = new Set()
  const client = {
    pullTelemetry: async (id, query) => {
      if (query === 'list') {
        if (!listings[id]) throw new Error('ERR_NOT_SUPPORTED')
        return { things: listings[id] }
      }
      if (offline.has(id)) throw new Error('ERR_OFFLINE')
      return { metrics: metrics[id] }
    },
    sendCommand: async (id, command, params) => {
      sent.push({ id, command, params })
      return { commandId: 'c1', status: 'QUEUED' }
    },
    getCommandStatus: async () => outcome
  }
  let bridge
  const ORIGIN = 'http://127.0.0.1:8080'

  before(async () => {
    bridge = new MdkBridge({ client, workers, siteMap, allowOrigins: [ORIGIN] })
    await bridge.resolveDevices()
    await bridge.poll()
    await bridge.listen(0)
  })
  after(() => bridge.stop())

  function request (method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port: bridge.port, method, path, agent: false, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null })
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  test('Worker-generated IDs are matched back to the site map by serial number', () => {
    assert.equal(bridge.minerDevice.get('c1-m001'), 'uuid-av')
    assert.equal(bridge.minerDevice.get('c1-m002'), 'c1-m002')
    assert.equal(bridge.devices.get('uuid-sen').kind, 'sensor')
    assert.equal(bridge.devices.get('uuid-met').kind, 'meter')
  })

  test('the view has every miner in one format, plus sensors and the meter', async () => {
    const { status, body } = await request('GET', '/view')
    assert.equal(status, 200)
    assert.deepEqual(body.miners.map((m) => m.id), ['c1-m001', 'c1-m002', 'c1-m003', 'c1-m004'])
    assert.ok(body.miners.every((m) => m.s === 'mining' && m.net))
    assert.equal(body.sensors.c1.inlet.temp, fixtures.sensor.temperature)
    assert.ok(body.meter.powerKw > 400)
  })

  test('a miner that stops answering is reported, keeping its last temperature', async () => {
    offline = new Set(['c1-m002'])
    const view = await bridge.poll()
    const m = view.miners.find((x) => x.id === 'c1-m002')
    assert.equal(m.net, false)
    assert.equal(m.temp, fixtures.healthy.antminer.temperature)
    assert.equal(view.miners.filter((x) => x.net).length, 3, 'the others carry on')
    offline = new Set()
    await bridge.poll()
  })

  test('one stuck device doesn’t hold up the others, and goes quiet by itself', async () => {
    const hanging = new Set(['c1-m003'])
    let reads = 0
    const slowClient = {
      ...client,
      pullTelemetry: async (id, query) => {
        if (query === 'metrics' && id === 'c1-m003') reads++
        if (query === 'metrics' && hanging.has(id)) return new Promise(() => {})
        return client.pullTelemetry(id, query)
      }
    }
    const b = new MdkBridge({ client: slowClient, workers, siteMap, allowOrigins: [], staleMs: 150, pullTimeoutMs: 60 })
    await b.resolveDevices()
    hanging.clear()
    await b.poll()
    assert.ok(b.view.miners.every((m) => m.net), 'all answered at first')

    hanging.add('c1-m003')
    // A pass over the healthy devices doesn't wait for the stuck one.
    const started = Date.now()
    const pass = b._readAll()
    const view = b._buildView()
    assert.equal(view.miners.find((m) => m.id === 'c1-m002').net, true)
    assert.ok(Date.now() - started < 50, 'the view is built without waiting')
    await pass

    // One slow read says nothing about the device, so the last reading stands...
    assert.equal(b._buildView().miners.find((m) => m.id === 'c1-m003').net, true)
    // ...until it's too old to trust.
    const later = Date.now() + 500
    assert.equal(b._buildView(later).miners.find((m) => m.id === 'c1-m003').net, false)

    // Reads that are still stuck don't pile up.
    const before = reads
    b.readings.get('c1-m003').pending = true
    await b._readAll()
    assert.equal(reads, before)
    b.readings.get('c1-m003').pending = false
  })

  test('a read that fails outright marks the device unreachable at once', async () => {
    const failing = new Set()
    const flaky = {
      ...client,
      pullTelemetry: async (id, query) => {
        if (query === 'metrics' && failing.has(id)) throw new Error('ERR_WORKER_GONE')
        return client.pullTelemetry(id, query)
      }
    }
    const b = new MdkBridge({ client: flaky, workers, siteMap, allowOrigins: [] })
    await b.resolveDevices()
    await b.poll()
    failing.add('c1-m003')
    await b.poll()
    assert.equal(b.view.miners.find((m) => m.id === 'c1-m003').net, false)
    assert.equal(b.view.miners.find((m) => m.id === 'c1-m002').net, true)
  })

  test('a reading that stops updating eventually counts as unreachable', async () => {
    const b = new MdkBridge({ client, workers, siteMap, allowOrigins: [], staleMs: 1000 })
    await b.resolveDevices()
    await b.poll()
    const now = Date.now()
    assert.equal(b._buildView(now + 500).miners[0].net, true)
    assert.equal(b._buildView(now + 5000).miners[0].net, false)
    assert.equal(b._buildView(now + 5000).meter, null, 'nor is an old meter reading trusted')
  })

  test('commands go to the right device, with that brand’s command, and report the outcome', async () => {
    sent.length = 0
    const ok = await request('POST', '/command', { body: { id: 'c1-m001', action: 'sleep' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(sent[0], { id: 'uuid-av', command: 'setPowerMode', params: { mode: 'sleep' } })

    outcome = { status: 'FAILED', error: 'ERR_DEVICE_BUSY' }
    const failed = await request('POST', '/command', { body: { id: 'c1-m002', action: 'reboot' } })
    assert.equal(failed.status, 400)
    assert.match(failed.body.error, /ERR_DEVICE_BUSY/, 'being queued doesn’t mean it worked')
    outcome = { status: 'SUCCESS' }
  })

  test('a power limit in percent becomes watts for Workers that take watts', async () => {
    sent.length = 0
    await request('POST', '/command', { body: { id: 'c1-m003', action: 'powerPct', value: 50 } })
    assert.deepEqual(sent[0].params, { watts: 1625 })
  })

  test('commands a Worker doesn’t have, and unknown miners, are refused plainly', async () => {
    const none = await request('POST', '/command', { body: { id: 'c1-m001', action: 'mode', value: 'eco' } })
    assert.equal(none.status, 400)
    assert.match(none.body.error, /Avalon's MDK Worker has no command for mode eco/)
    assert.equal((await request('POST', '/command', { body: { id: 'nope', action: 'sleep' } })).status, 404)
  })

  test('only the panel may read it from a browser, and other sites get nothing', async () => {
    const allowed = await request('GET', '/view', { headers: { origin: ORIGIN } })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN)
    const other = await request('GET', '/view', { headers: { origin: 'https://evil.example' } })
    assert.equal(other.status, 403)
    assert.equal(other.headers['access-control-allow-origin'], undefined)
    const posted = await request('POST', '/command', { body: { id: 'c1-m001', action: 'reboot' }, headers: { origin: 'https://evil.example' } })
    assert.equal(posted.status, 403)
  })

  test('DNS rebinding and form posts are refused too', async () => {
    assert.equal((await request('GET', '/view', { headers: { host: 'evil.example' } })).status, 403)
    const form = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: '/command', agent: false, headers: { 'content-type': 'text/plain' } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end('{"id":"c1-m001","action":"reboot"}')
    })
    assert.equal(form, 403)
  })

  test('the panel’s browser preflight passes', async () => {
    const res = await request('OPTIONS', '/command', { headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
    assert.equal(res.status, 204)
    assert.match(res.headers['access-control-allow-headers'], /content-type/)
  })
})
