'use strict'

// The app's policy and its command handling, with a stand-in for the MDK client.
// The real client is exercised by running mdk/start.js against the simulator.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { plan, wakeCommand, wasteRank, breakevenPrice, priceLevelFor, nextPriceLevel, LEVEL, DEFAULTS, CurtailmentResponder } = require('../mdk/curtailment')

const miner = (id, powerW, hashThs, asleep = false) => ({ id, powerW, hashThs, asleep })
const base = { marginKw: 5, slept: new Map(), pending: new Map() }
// The older tests are about choosing miners, so they skip eco mode and the staged return.
const SLEEP_ONLY = { throttle: false, clearHoldMs: 0, rampIntervalMs: 0, rampStepKw: Infinity }

test('does nothing while the site is under its limit', () => {
  const result = plan({ ...base, powerKw: 50, limitKw: 100, miners: [miner('a', 3000, 100)] })
  assert.deepEqual(result, { throttle: [], sleep: [], wake: [], restore: [] })
})

test('sheds only enough, least efficient first', () => {
  const miners = [
    miner('efficient', 3000, 200),
    miner('middling', 3000, 150),
    miner('wasteful', 3000, 100),
    miner('worst', 3000, 80)
  ]
  const { sleep, wake } = plan({ ...base, powerKw: 12, limitKw: 11, marginKw: 1, miners })
  assert.deepEqual(sleep, ['worst', 'wasteful'].slice(0, 1))
  assert.deepEqual(wake, [])
  const more = plan({ ...base, powerKw: 12, limitKw: 8, marginKw: 1, miners })
  assert.deepEqual(more.sleep, ['worst', 'wasteful'])
})

test('a miner burning power for no hashrate goes first', () => {
  assert.equal(wasteRank(miner('hung', 3000, 0)), Infinity)
  const miners = [miner('bad', 3000, 50), miner('hung', 3000, 0)]
  assert.deepEqual(plan({ ...base, powerKw: 6, limitKw: 4, marginKw: 1, miners }).sleep, ['hung'])
})

test('counts unconfirmed commands, so it doesn’t shed twice', () => {
  const miners = [miner('a', 3000, 100), miner('b', 3000, 100)]
  const pending = new Map([['a', { action: 'sleep', kw: 3 }]])
  assert.deepEqual(plan({ ...base, powerKw: 6, limitKw: 5, marginKw: 1, miners, pending }).sleep, [])
})

test('never commands a miner that already has a command pending', () => {
  const miners = [miner('a', 3000, 100), miner('b', 3000, 100)]
  const pending = new Map([['a', { action: 'wake', kw: 3 }]])
  const { sleep } = plan({ ...base, powerKw: 20, limitKw: 5, marginKw: 1, miners, pending })
  assert.deepEqual(sleep, ['b'])
})

test('sheds what it can when the fleet can’t reach the target', () => {
  const miners = [miner('a', 3000, 100), miner('b', 3000, 100, true)]
  assert.deepEqual(plan({ ...base, powerKw: 40, limitKw: 5, marginKw: 1, miners }).sleep, ['a'])
})

test('wakes only what fits, with a margin to spare', () => {
  const slept = new Map([['a', { kw: 3, rank: 1 }], ['b', { kw: 3, rank: 2 }], ['c', { kw: 3, rank: 3 }]])
  const miners = ['a', 'b', 'c'].map((id) => miner(id, 30, 0, true))
  assert.deepEqual(plan({ ...base, powerKw: 1, limitKw: 18, marginKw: 5, miners, slept }).wake, ['a', 'b'])
  assert.deepEqual(plan({ ...base, powerKw: 1, limitKw: 12, marginKw: 5, miners, slept }).wake, [], 'too close to the limit')
})

test('never wakes a miner it didn’t put to sleep', () => {
  const miners = [miner('someone-elses', 30, 0, true)]
  assert.deepEqual(plan({ ...base, powerKw: 1, limitKw: 100, miners }).wake, [])
})

test('doesn’t flip back and forth at the boundary', () => {
  const m = [miner('a', 3000, 100), miner('b', 3000, 100)]
  // Just over the target: shed one.
  const first = plan({ ...base, powerKw: 6, limitKw: 6, marginKw: 1, miners: m })
  assert.equal(first.sleep.length, 1)
  // It lands under the target, but waking it again wouldn't leave a margin.
  const slept = new Map([[first.sleep[0], { kw: 3, rank: 1 }]])
  const after = m.map((x) => (x.id === first.sleep[0] ? { ...x, asleep: true, powerW: 30 } : x))
  const second = plan({ ...base, powerKw: 3, limitKw: 6, marginKw: 1, miners: after, slept })
  assert.deepEqual(second, { throttle: [], sleep: [], wake: [], restore: [] })
})

test('each brand wakes with the right command', () => {
  assert.deepEqual(wakeCommand('sealminer'), ['resume', {}])
  for (const brand of ['avalon', 'antminer', 'whatsminer', 'luxos', 'proto']) {
    assert.deepEqual(wakeCommand(brand), ['setPowerMode', { mode: 'normal' }])
  }
})

// A stand-in that behaves like a Kernel: commands change what telemetry reports.
function fakeSite (specs, { reject = new Set(), unreachable = new Set() } = {}) {
  const miners = new Map(specs.map((s) => [s.id, { ...s, status: 'mining' }]))
  const commands = []
  return {
    commands,
    miners,
    client: {
      pullTelemetry: async (id) => {
        if (id === 'meter') {
          const watts = [...miners.values()].reduce((sum, m) => sum + (m.status === 'mining' ? m.power : 40), 0)
          return { metrics: { active_power: watts } }
        }
        if (unreachable.has(id)) throw new Error('ERR_OFFLINE')
        const m = miners.get(id)
        const awake = m.status === 'mining'
        return { metrics: { status: m.status, power: awake ? m.power : 40, hashrate_rt: awake ? m.hash : 0 } }
      },
      sendCommand: async (id, command, params) => {
        commands.push({ id, command, params })
        if (reject.has(id)) return { status: 'REJECTED', error: 'ERR_NOPE' }
        const m = miners.get(id)
        if (params.mode === 'sleep') m.status = m.brand === 'sealminer' ? 'suspended' : 'sleeping'
        else m.status = 'mining'
        return { status: 'QUEUED', commandId: 'x' }
      }
    }
  }
}

const specs = [
  { id: 'a', brand: 'antminer', power: 3000, hash: 180 },
  { id: 'b', brand: 'sealminer', power: 4000, hash: 200 },
  { id: 'c', brand: 'proto', power: 3000, hash: 90 },
  { id: 'd', brand: 'whatsminer', power: 3000, hash: 100 }
]

function responder (site, limit) {
  return new CurtailmentResponder({
    client: site.client,
    miners: specs.map(({ id, brand }) => ({ id, brand })),
    meterId: 'meter',
    marginKw: 1,
    getSignals: async () => ({ limitKw: limit.kw }),
    ...SLEEP_ONLY
  })
}

test('holds a site under a lowered limit, then restores it', async () => {
  const site = fakeSite(specs)
  const limit = { kw: 20 }
  const app = responder(site, limit)

  assert.deepEqual((await app.tick()).sleep, [], 'under the limit')

  limit.kw = 8.5
  const shed = await app.tick()
  assert.deepEqual(shed.sleep, ['c', 'd'], 'worst first')
  assert.equal(site.miners.get('c').status, 'sleeping')
  assert.equal(site.commands[0].params.mode, 'sleep')

  await app.tick()
  assert.equal(app.pending.size, 0, 'telemetry confirmed the commands')
  assert.equal(app.slept.size, 2)

  limit.kw = 20
  const back = await app.tick()
  assert.deepEqual(back.wake.sort(), ['c', 'd'])
  await app.tick()
  assert.equal(app.slept.size, 0)
  assert.ok([...site.miners.values()].every((m) => m.status === 'mining'))
})

test('the most efficient miners wake first', async () => {
  const site = fakeSite(specs)
  const limit = { kw: 8.5 }
  const app = responder(site, limit)
  await app.tick()
  await app.tick()
  // There's room for one: d (30 W/TH) beats c (33 W/TH).
  limit.kw = 13
  assert.deepEqual((await app.tick()).wake, ['d'])
})

test('uses resume for a SealMiner it put to sleep', async () => {
  const site = fakeSite(specs)
  const limit = { kw: 1.5 }
  const app = responder(site, limit)
  await app.tick()
  await app.tick()
  assert.equal(site.miners.get('b').status, 'suspended', 'read as asleep')
  limit.kw = 40
  await app.tick()
  assert.ok(site.commands.some((c) => c.id === 'b' && c.command === 'resume'))
})

test('a rejected command is counted and tried again', async () => {
  const site = fakeSite(specs, { reject: new Set(['c']) })
  const app = responder(site, { kw: 11 })
  await app.tick()
  assert.equal(app.rejected, 1)
  assert.equal(app.slept.has('c'), false)
  assert.equal(app.pending.has('c'), false)
})

test('an unreachable miner is skipped without stopping the rest', async () => {
  const site = fakeSite(specs, { unreachable: new Set(['c']) })
  const { read, sleep } = await responder(site, { kw: 8 }).tick()
  assert.equal(read, 3)
  assert.equal(sleep.includes('c'), false)
  assert.ok(sleep.length > 0)
})

test('falls back to summing the miners if the meter can’t be read', async () => {
  const site = fakeSite(specs)
  const original = site.client.pullTelemetry
  site.client.pullTelemetry = async (id) => {
    if (id === 'meter') throw new Error('ERR_METER')
    return original(id)
  }
  const { powerKw } = await responder(site, { kw: 100 }).tick()
  assert.equal(powerKw, 13)
})

// A fleet behind a meter that only moves in 21.7 kW steps, plus cooling it can't
// see per miner. This is what exposed over-shedding against the real stack.
function coarseSite (count, overheadKw = 20) {
  const list = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, brand: 'antminer', power: 3500, hash: 100 + i }))
  const site = fakeSite(list)
  const original = site.client.pullTelemetry
  site.client.pullTelemetry = async (id) => {
    if (id !== 'meter') return original(id)
    const { metrics } = await original('meter')
    const kw = metrics.active_power / 1000 + overheadKw
    return { metrics: { active_power: Math.round(kw / 21.7) * 21.7 * 1000 } }
  }
  const app = (limit) => new CurtailmentResponder({
    client: site.client,
    miners: list.map(({ id, brand }) => ({ id, brand })),
    meterId: 'meter',
    getSignals: async () => ({ limitKw: limit.kw }),
    ...SLEEP_ONLY
  })
  return { site, app }
}

const asleepCount = (site) => [...site.miners.values()].filter((m) => m.status !== 'mining').length
const trueKw = (site, overheadKw = 20) => [...site.miners.values()]
  .reduce((sum, m) => sum + (m.status === 'mining' ? m.power : 40), 0) / 1000 + overheadKw

test('a coarse meter doesn’t cause shedding on a site within its limit', async () => {
  const { site, app } = coarseSite(100)
  // The site draws 370 kW, 20 kW under its limit: within a meter step of it.
  const responder = app({ kw: 390 })
  for (let i = 0; i < 20; i++) await responder.tick()
  assert.ok(asleepCount(site) <= 1, `${asleepCount(site)} miners were shed for nothing`)
})

test('a coarse meter doesn’t cause overshoot: it lands close to the limit', async () => {
  const { site, app } = coarseSite(100)
  const limit = { kw: 370 }
  const responder = app(limit)
  for (let i = 0; i < 5; i++) await responder.tick()

  limit.kw = 200
  for (let i = 0; i < 15; i++) await responder.tick()
  const kw = trueKw(site)
  assert.ok(kw <= 200, `over the limit at ${kw} kW`)
  assert.ok(kw > 200 - 15 - 15, `overshot, down to ${kw} kW`)
  assert.equal(responder.rejected, 0)
})

test('with a coarse meter the fleet returns when the limit lifts', async () => {
  const { site, app } = coarseSite(100)
  const limit = { kw: 200 }
  const responder = app(limit)
  for (let i = 0; i < 10; i++) await responder.tick()
  assert.ok(asleepCount(site) > 30)
  limit.kw = 420
  for (let i = 0; i < 10; i++) await responder.tick()
  assert.equal(asleepCount(site), 0)
})

// --- price, alerts, eco mode and the staged return ---------------------------

test('break-even is what a miner earns per kWh, including the load it brings', () => {
  // 100 TH at $0.048/TH/day with no pool fee is $0.20/h, on 2 kW.
  assert.ok(Math.abs(breakevenPrice({ kw: 2, ths: 100 }, 0.048, 0, 0) - 0.1) < 1e-9)
  assert.ok(Math.abs(breakevenPrice({ kw: 2, ths: 100 }, 0.048, 0.25, 0) - 0.08) < 1e-9)
})

test('a price over break-even means eco, and well over it means sleep', () => {
  const opts = { ecoPower: 0.65, ecoHash: 0.8 }
  assert.equal(priceLevelFor(0.05, 0.08, opts), LEVEL.NORMAL)
  assert.equal(priceLevelFor(0.09, 0.08, opts), LEVEL.ECO)
  assert.equal(priceLevelFor(0.25, 0.08, opts), LEVEL.SLEEP)
})

test('a price has to last before miners shed, and fall and stay down before they return', () => {
  const opts = { ...DEFAULTS, priceConfirmMs: 100, clearHoldMs: 500, priceBand: 0.1 }
  const start = { level: 0, aboveSince: null, belowSince: null }
  let entry = nextPriceLevel(start, 0.25, 0.08, 0, opts)
  assert.equal(entry.level, 0, 'not yet confirmed')
  assert.equal(nextPriceLevel(entry, 0.05, 0.08, 50, opts).aboveSince, null, 'a blip resets it')
  entry = nextPriceLevel(entry, 0.25, 0.08, 100, opts)
  assert.equal(entry.level, 2)

  // Just under break-even isn't enough: it needs the band as well.
  assert.equal(nextPriceLevel(entry, 0.078, 0.08, 10000, opts).belowSince, 10000)
  assert.equal(nextPriceLevel(entry, 0.0985, 0.08, 10000, opts).level, 2)
  let down = nextPriceLevel(entry, 0.05, 0.08, 1000, opts)
  assert.equal(down.level, 2, 'still holding')
  down = nextPriceLevel(down, 0.05, 0.08, 1500, opts)
  assert.equal(down.level, 0)
})

const eco = (id, powerW, hashThs, extra = {}) => ({ id, powerW, hashThs, asleep: false, canThrottle: true, ...extra })

test('eco comes first when it’s enough, and takes the least efficient miners', () => {
  const miners = [eco('good', 3000, 200), eco('bad', 3000, 100)]
  const { throttle, sleep } = plan({ ...base, powerKw: 6, limitKw: 6, marginKw: 1, miners, ecoPower: 0.5 })
  assert.deepEqual(throttle, ['bad'])
  assert.deepEqual(sleep, [])
})

test('when eco isn’t enough it sleeps miners too, without counting their saving twice', () => {
  const miners = [eco('a', 3000, 200), eco('b', 3000, 100)]
  const { throttle, sleep } = plan({ ...base, powerKw: 6, limitKw: 3.5, marginKw: 1, miners, ecoPower: 0.5 })
  // Eco on both only reaches 3 kW, short of 2.5. So b sleeps, and a stays on eco.
  assert.deepEqual(sleep, ['b'])
  assert.deepEqual(throttle, ['a'])
})

test('a brand with no eco mode goes straight to sleep', () => {
  const miners = [eco('avalon', 3000, 100, { canThrottle: false })]
  const { throttle, sleep } = plan({ ...base, powerKw: 3, limitKw: 2, marginKw: 0, miners })
  assert.deepEqual(throttle, [])
  assert.deepEqual(sleep, ['avalon'])
})

test('price and alert floors apply even with power to spare', () => {
  const miners = [eco('a', 3000, 100), eco('b', 3000, 100), eco('c', 3000, 100)]
  const floors = new Map([['a', LEVEL.SLEEP], ['b', LEVEL.ECO]])
  const { throttle, sleep } = plan({ ...base, powerKw: 9, limitKw: 100, miners, floors })
  assert.deepEqual(sleep, ['a'])
  assert.deepEqual(throttle, ['b'])
})

test('a miner isn’t brought back above what its floor allows', () => {
  const slept = new Map([['a', { kw: 3, rank: 1 }]])
  const throttled = new Map([['b', { kw: 3, rank: 1 }]])
  const miners = [eco('a', 30, 0, { asleep: true }), eco('b', 2000, 80)]
  const floors = new Map([['a', LEVEL.SLEEP], ['b', LEVEL.ECO]])
  const { wake, restore } = plan({ ...base, powerKw: 2, limitKw: 100, miners, slept, throttled, floors })
  assert.deepEqual(wake, [])
  assert.deepEqual(restore, [])
})

test('the return is limited per step, and sleepers go before eco miners', () => {
  const slept = new Map([['a', { kw: 3, rank: 1 }], ['b', { kw: 3, rank: 2 }], ['c', { kw: 3, rank: 3 }]])
  const throttled = new Map([['d', { kw: 3, rank: 1 }]])
  const miners = [...['a', 'b', 'c'].map((id) => eco(id, 30, 0, { asleep: true })), eco('d', 2000, 80)]
  const step = (rampKw, over = {}) => plan({ ...base, powerKw: 2, limitKw: 100, miners, slept, throttled, rampKw, ...over })
  assert.deepEqual(step(6.5).wake, ['a', 'b'])
  assert.deepEqual(step(6.5).restore, [], 'c didn’t fit, so eco miners wait')
  assert.deepEqual(step(10).wake, ['a', 'b', 'c'])
  assert.deepEqual(step(10).restore, ['d'])
  assert.deepEqual(step(100, { rampOpen: false }), { throttle: [], sleep: [], wake: [], restore: [] })
})

// A site with a clock, price and alerts under the test's control. Woken miners take
// their time, and eco mode really does change what telemetry reports.
function liveSite (count = 10) {
  const list = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, brand: 'antminer', power: 3000, hash: 180 + i, status: 'mining', mode: 'normal', temp: 70 }))
  const miners = new Map(list.map((m) => [m.id, m]))
  const signals = { nowMs: 0, limitKw: 1000, priceUsdKwh: 0.05, hashpriceUsdThDay: 0.05, gridAlert: false }
  const site = {
    miners,
    signals,
    commands: [],
    bootsHeld: false,
    dark: false,
    client: {
      pullTelemetry: async (id) => {
        if (id === 'meter') {
          const watts = [...miners.values()].reduce((sum, m) => sum + draw(m), 0)
          return { metrics: { active_power: site.dark ? 0 : watts, voltage: site.dark ? 0 : 30000 } }
        }
        if (site.dark) return { metrics: { status: { error: 'ERR_TELEMETRY_FAILED' } } }
        const m = miners.get(id)
        return { metrics: { status: m.status, power: draw(m), hashrate_rt: hash(m), temperature: m.temp } }
      },
      sendCommand: async (id, command, params) => {
        site.commands.push({ id, command, params })
        const m = miners.get(id)
        if (params.mode === 'sleep') m.status = 'sleeping'
        else if (params.mode === 'low') m.mode = 'low'
        else {
          m.mode = 'normal'
          if (m.status === 'sleeping') m.status = site.bootsHeld ? 'booting' : 'mining'
        }
        return { status: 'QUEUED' }
      }
    }
  }
  function draw (m) {
    if (m.status === 'mining') return m.mode === 'low' ? m.power * 0.65 : m.power
    return 40
  }
  function hash (m) {
    if (m.status !== 'mining') return 0
    return m.mode === 'low' ? m.hash * 0.8 : m.hash
  }
  site.count = (test) => [...miners.values()].filter(test).length
  site.asleep = () => site.count((m) => m.status === 'sleeping')
  site.onEco = () => site.count((m) => m.mode === 'low')
  site.app = (opts = {}) => new CurtailmentResponder({
    client: site.client,
    miners: list.map(({ id, brand }) => ({ id, brand })),
    meterId: 'meter',
    marginKw: 1,
    pendingMs: 0,
    getSignals: async () => ({ ...signals }),
    ...opts
  })
  return site
}

const MIN = 60000
// Runs the app for a span of the site's time, a tick a minute.
async function run (site, app, minutes) {
  for (let i = 0; i < minutes; i++) {
    site.signals.nowMs += MIN
    await app.tick()
  }
}

test('a price spike sheds the whole fleet, then it returns in steps', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 3)
  assert.equal(site.asleep(), 0, 'profitable at $0.05')

  site.signals.priceUsdKwh = 0.25
  await run(site, app, 3)
  assert.equal(site.asleep(), 0, 'waits to see if the spike lasts')
  await run(site, app, 4)
  assert.equal(site.asleep(), 10)

  site.signals.priceUsdKwh = 0.05
  await run(site, app, 10)
  assert.equal(site.asleep(), 10, 'holds while the price proves itself')

  // A tenth of the fleet per step, five minutes apart.
  await run(site, app, 6)
  assert.equal(site.asleep(), 9)
  await run(site, app, 5)
  assert.equal(site.asleep(), 8)
  await run(site, app, 45)
  assert.equal(site.asleep(), 0)
  assert.equal(app.status().state, 'normal')
})

test('a spike during the return stops it and sheds again', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  site.signals.priceUsdKwh = 0.05
  await run(site, app, 22)
  const midway = site.asleep()
  assert.ok(midway > 0 && midway < 10)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  assert.equal(site.asleep(), 10)
})

test('a modest price rise means eco mode rather than sleep, and eco ends afterwards', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  const { breakevenUsdKwh } = (await app.tick(), app.status())
  site.signals.priceUsdKwh = breakevenUsdKwh * 1.1
  await run(site, app, 8)
  assert.equal(site.asleep(), 0)
  assert.equal(site.onEco(), 10)

  site.signals.priceUsdKwh = 0.03
  await run(site, app, 80)
  assert.equal(site.onEco(), 0)
})

test('a grid alert drops to eco at once and holds any return until well after it ends', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.gridAlert = true
  await run(site, app, 1)
  assert.equal(site.onEco(), 10)
  assert.equal(app.status().rampBlock, 'grid alert active')

  await run(site, app, 20)
  site.signals.gridAlert = false
  await run(site, app, 25)
  assert.equal(site.onEco(), 10, 'still within the hold')
  await run(site, app, 80)
  assert.equal(site.onEco(), 0)
})

test('an emergency limit sleeps miners straight away, despite the hold on returning', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.gridAlert = true
  site.signals.limitKw = 8
  await run(site, app, 1)
  assert.ok(site.asleep() >= 7, `only ${site.asleep()} asleep`)
})

test('the site’s own cap applies alongside a utility limit, and can change while running', async () => {
  const site = liveSite()
  const app = site.app({ capKw: 21 })
  await run(site, app, 2)
  const total = () => [...site.miners.values()].reduce((sum, m) => sum + (m.status === 'mining' ? m.power * (m.mode === 'low' ? 0.65 : 1) : 40), 0) / 1000
  assert.ok(total() <= 21, `${total()} kW over a 21 kW cap`)
  assert.equal(site.asleep(), 0, 'eco alone was enough')
  assert.equal(app.status().limitKw, 21)

  app.setCap(null)
  assert.equal(app.capKw, null)
  await run(site, app, 80)
  assert.equal(site.onEco(), 0)
  assert.throws(() => app.setCap(-5), /positive/)
  assert.throws(() => app.setCap('300'), /positive/)
})

test('it waits for woken miners to come back, and reports any that don’t', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  site.signals.priceUsdKwh = 0.05
  site.bootsHeld = true
  await run(site, app, 16)
  assert.equal(site.count((m) => m.status === 'booting'), 1)

  await run(site, app, 5)
  assert.equal(site.count((m) => m.status === 'booting'), 1, 'no next step yet')
  assert.match(app.status().rampBlock, /waiting for 1/)

  await run(site, app, 6)
  assert.equal(app.status().notBack.length, 1)
  site.bootsHeld = false
  await run(site, app, 8)
  assert.ok(site.asleep() < 9, 'the rest carry on')
})

test('nothing comes back while the fleet runs hot', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  site.signals.priceUsdKwh = 0.05
  for (const m of site.miners.values()) m.temp = 92
  await run(site, app, 60)
  assert.equal(site.asleep(), 10)
  assert.match(app.status().rampBlock, /92°C/)
  for (const m of site.miners.values()) m.temp = 70
  await run(site, app, 10)
  assert.ok(site.asleep() < 10)
})

test('with the signals lost it keeps what’s shed, and returns nothing', async () => {
  const site = liveSite()
  let lost = false
  const signals = async () => {
    if (lost) throw new Error('feed down')
    return { ...site.signals }
  }
  const app = site.app({ getSignals: signals, tickMs: 1 })
  await run(site, app, 2)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  assert.equal(site.asleep(), 10)

  lost = true
  site.signals.priceUsdKwh = 0.05
  await app.tick()
  assert.equal(app.status().signalsLost, true)
  for (let i = 0; i < 40; i++) await app.tick()
  assert.equal(site.asleep(), 10)
  assert.equal(app.status().rampBlock, 'signals lost')
})

test('with no power it sends nothing, and holds after the supply returns', async () => {
  const site = liveSite()
  const app = site.app()
  await run(site, app, 2)
  site.signals.limitKw = 15
  await run(site, app, 2)
  const asleep = site.asleep()
  assert.ok(asleep > 0)
  site.signals.limitKw = 1000
  site.dark = true
  const sent = site.commands.length
  await run(site, app, 5)
  assert.equal(site.commands.length, sent)
  site.dark = false
  await run(site, app, 20)
  assert.equal(site.asleep(), asleep, 'still inside the hold after the outage')
  await run(site, app, 90)
  assert.equal(site.asleep(), 0)
})

test('a stuck read doesn’t stop it shedding', async () => {
  const site = liveSite()
  const original = site.client.pullTelemetry
  site.client.pullTelemetry = (id, query) => (id === 'm5' ? new Promise(() => {}) : original(id, query))
  const app = site.app({ readTimeoutMs: 20 })
  await run(site, app, 2)
  site.signals.limitKw = 10
  await run(site, app, 2)
  assert.ok(site.asleep() >= 5)
  assert.equal(site.miners.get('m5').status, 'mining', 'unreadable, so not commanded')
})

test('it leaves alone miners someone else put to sleep', async () => {
  const site = liveSite()
  site.miners.get('m3').status = 'sleeping'
  const app = site.app()
  await run(site, app, 2)
  site.signals.priceUsdKwh = 0.25
  await run(site, app, 8)
  site.signals.priceUsdKwh = 0.05
  await run(site, app, 90)
  assert.equal(site.miners.get('m3').status, 'sleeping')
  assert.equal(site.asleep(), 1)
})

test('it notices when someone else wakes a miner it had shed', async () => {
  const site = liveSite()
  const app = site.app({ clearHoldMs: 1000 * MIN })
  await run(site, app, 2)
  site.signals.limitKw = 15
  await run(site, app, 2)
  const id = [...app.slept.keys()][0]
  site.miners.get(id).status = 'mining'
  site.signals.limitKw = 1000
  await run(site, app, 1)
  assert.equal(app.slept.has(id), false)
})

test('a clock that goes backwards, as a reset does, doesn’t freeze it', async () => {
  const site = liveSite()
  const app = site.app()
  site.signals.nowMs = 500 * MIN
  await run(site, app, 2)
  site.signals.limitKw = 15
  await run(site, app, 2)
  site.signals.limitKw = 1000
  site.signals.nowMs = 0
  await run(site, app, 60)
  assert.equal(site.asleep(), 0)
})
