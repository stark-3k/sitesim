'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { buildConfig } = require('../src/config')
const Simulation = require('../src/engine/simulation')
const { loadScenarios, normalize, parseTime } = require('../src/engine/scenarios')
const { CATALOG } = require('../src/engine/faults')

const small = (overrides = {}) => buildConfig({
  seed: 42,
  fleet: { containers: 2, minersPerContainer: 10, mix: { avalon: 1 } },
  ...overrides
})

function run (sim, seconds) {
  for (let i = 0; i < seconds; i++) sim.step(1)
}

const fingerprint = (sim) => JSON.stringify({
  t: sim.t,
  miners: sim.miners.map((m) => [m.state, m.chipC, m.ths, m.powerW]),
  eco: sim.economics,
  ambient: sim.env.ambientC,
  faults: sim.faults.map((f) => [f.type, f.target])
})

test('the same seed and inputs replay exactly', () => {
  const play = () => {
    const sim = new Simulation(small())
    sim.setSite({ chaos: { enabled: true, faultsPerMinerDay: 5 } })
    run(sim, 3600)
    sim.injectFault({ type: 'fan_failure', target: 'random:3' })
    run(sim, 3600)
    return fingerprint(sim)
  }
  assert.equal(play(), play())
})

test('a different seed gives a different site', () => {
  const a = new Simulation(small())
  const b = new Simulation(small({ seed: 43 }))
  run(a, 600)
  run(b, 600)
  assert.notEqual(fingerprint(a), fingerprint(b))
})

test('a healthy fleet settles at plausible numbers', () => {
  const sim = new Simulation(small())
  run(sim, 3600)
  const { site } = sim
  assert.equal(sim.fleetCounts().mining, 20)
  assert.ok(site.hashThs > 20 * 105 && site.hashThs < 20 * 115, `hash ${site.hashThs}`)
  assert.ok(site.powerKw > 65 && site.powerKw < site.limitKw, `power ${site.powerKw} of ${site.limitKw}`)
  assert.ok(site.maxChipC > 55 && site.maxChipC < 85, `chips ${site.maxChipC}`)
  assert.ok(site.creditedThs < site.hashThs && site.creditedThs > site.hashThs * 0.98)
})

test('power, heat and earnings are all connected', () => {
  const sim = new Simulation(small())
  run(sim, 1800)
  const before = { power: sim.site.powerKw, heat: sim.containers[0].heatKw, inlet: sim.containers[0].inletC }
  for (const miner of sim.miners) sim.minerCommand(miner.id, 'sleep', undefined, 'quiet')
  const btcBefore = sim.economics.btcEarned
  run(sim, 900)
  assert.ok(sim.site.powerKw < before.power * 0.15, 'site power falls')
  assert.ok(sim.containers[0].heatKw < before.heat * 0.2, 'heat load falls')
  assert.ok(sim.containers[0].inletC < before.inlet, 'inlet cools')
  const btcMid = sim.economics.btcEarned
  run(sim, 600)
  assert.ok(sim.economics.btcEarned - btcMid < (btcMid - btcBefore) * 0.05, 'earnings stop')
})

test('fan loss heats a miner until it throttles, trips, and recovers', () => {
  const sim = new Simulation(small())
  run(sim, 600)
  const miner = sim.miners[0]
  const healthy = miner.ths
  const [fault] = sim.injectFault({ type: 'fan_failure', target: `miner:${miner.id}`, params: { severity: 1 } })

  let throttled = false
  let tripped = false
  for (let i = 0; i < 1800 && !tripped; i++) {
    sim.step(1)
    if (miner.chipC > 90 && miner.ths < healthy) throttled = true
    if (miner.state === 'tripped') tripped = true
  }
  assert.ok(throttled, 'throttles on the way up')
  assert.ok(tripped, 'the cut-out opens')
  assert.ok(sim.events.some((e) => e.message.includes('tripped')), 'logged')

  sim.clearFaults((f) => f.id === fault.id)
  run(sim, 1500)
  assert.equal(miner.state, 'mining')
  assert.ok(miner.ths > healthy * 0.9, 'hashrate returns')
})

test('severe cooling loss overheats one container and leaves the other alone', () => {
  const sim = new Simulation(small())
  run(sim, 600)
  sim.injectFault({ type: 'cooling_failure', target: 'c1', params: { severity: 0.6 } })
  run(sim, 3600)
  const [c1, c2] = sim.containers
  assert.ok(c1.inletC > c2.inletC + 15, `${c1.inletC} vs ${c2.inletC}`)
  assert.ok(c1.miners.some((m) => m.state === 'tripped' || m.overheating), 'c1 is in trouble')
  assert.ok(c2.miners.every((m) => m.state === 'mining'), 'c2 is fine')
})

test('a hung miner draws power but earns nothing, and a reboot clears it', () => {
  const sim = new Simulation(small())
  run(sim, 300)
  const miner = sim.miners[0]
  sim.injectFault({ type: 'firmware_hang', target: `miner:${miner.id}` })
  run(sim, 600)
  assert.equal(miner.ths, 0)
  assert.ok(miner.powerW > 3000, 'still burning power')
  assert.equal(miner.state, 'mining', 'looks alive')

  sim.minerCommand(miner.id, 'reboot')
  assert.equal(sim.faults.length, 0)
  assert.equal(miner.state, 'booting')
  run(sim, 600)
  assert.ok(miner.ths > 90)
})

test('miners fail over between pools and return', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  const f2 = sim.pools.get('f2pool')
  const backup = sim.pools.get('backup')
  assert.equal(backup.workers, 0)

  sim.injectFault({ type: 'pool_outage', target: 'pool:f2pool' })
  run(sim, 10)
  assert.equal(f2.creditedThs, 0)
  assert.equal(backup.workers, 20)
  assert.ok(sim.site.creditedThs > 0, 'earning on the backup')

  sim.clearFaults(() => true)
  run(sim, 10)
  assert.equal(f2.workers, 20)
})

test('with every pool down the fleet burns power and earns nothing', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  sim.injectFault({ type: 'pool_outage', target: 'pool:f2pool' })
  sim.injectFault({ type: 'pool_outage', target: 'pool:backup' })
  run(sim, 10)
  const earned = sim.economics.btcEarned
  const cost = sim.economics.powerCostUsd
  run(sim, 300)
  assert.equal(sim.site.creditedThs, 0)
  assert.equal(sim.economics.btcEarned, earned)
  assert.ok(sim.economics.powerCostUsd > cost)
  assert.ok(sim.site.hashThs > 0, 'machines keep hashing')
})

test('a miner that loses its network still hashes but earns nothing', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  const miner = sim.miners[0]
  sim.injectFault({ type: 'network_loss', target: `miner:${miner.id}` })
  run(sim, 5)
  assert.equal(miner.reachable, false)
  assert.ok(miner.ths > 90)
  assert.equal(miner.creditedThs, 0)
})

test('a switch failure takes a whole container offline', () => {
  const sim = new Simulation(small())
  sim.injectFault({ type: 'switch_failure', target: 'c2' })
  run(sim, 5)
  assert.ok(sim.containers[1].miners.every((m) => !m.reachable))
  assert.ok(sim.containers[0].miners.every((m) => m.reachable))
})

test('a grid outage drops the fleet, and it reboots when power returns', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  sim.injectFault({ type: 'grid_outage', durationSec: 120 })
  run(sim, 5)
  assert.equal(sim.fleetCounts().off, 20)
  assert.ok(sim.site.powerKw < 0.01, `power ${sim.site.powerKw}`)
  assert.equal(sim.site.hashThs, 0)
  assert.equal(sim.meterReading.voltageV, 0)
  run(sim, 120)
  assert.equal(sim.fleetCounts().booting, 20)
  run(sim, 600)
  assert.equal(sim.fleetCounts().mining, 20)
})

test('curtailment costs a penalty only while over the limit', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  sim.injectFault({ type: 'grid_curtailment', params: { limit: 0.5 } })
  run(sim, 600)
  assert.ok(sim.site.overLimit)
  const penalty = sim.economics.penaltyUsd
  assert.ok(penalty > 0)

  for (const miner of sim.miners) sim.minerCommand(miner.id, 'sleep', undefined, 'quiet')
  run(sim, 120)
  assert.equal(sim.site.overLimit, false)
  const settled = sim.economics.penaltyUsd
  run(sim, 600)
  assert.equal(sim.economics.penaltyUsd, settled, 'no more penalties under the limit')
  assert.equal(sim.fleetCounts().sleeping, 20, 'the curtailment itself does not shed load')
})

test('an overload opens the breaker, which stays open until reset', () => {
  const sim = new Simulation(small())
  run(sim, 60)
  sim.setSite({ contractKw: 30 })
  run(sim, 59)
  assert.equal(sim.breakerOpen, false)
  run(sim, 5)
  assert.equal(sim.breakerOpen, true)
  assert.equal(sim.fleetCounts().off, 20)

  sim.setSite({ contractKw: 500 })
  run(sim, 600)
  assert.equal(sim.fleetCounts().off, 20, 'stays dark until someone acts')
  assert.equal(sim.resetBreaker(), true)
  run(sim, 400)
  assert.equal(sim.fleetCounts().mining, 20)
})

test('work modes trade hashrate for power', () => {
  const sample = (mode) => {
    const sim = new Simulation(small())
    for (const miner of sim.miners) sim.minerCommand(miner.id, 'mode', mode, 'quiet')
    run(sim, 1800)
    return { hash: sim.site.hashThs, power: sim.site.powerKw, eff: sim.site.itKw * 1000 / sim.site.hashThs }
  }
  const eco = sample('eco')
  const normal = sample('normal')
  const high = sample('high')
  assert.ok(eco.hash < normal.hash && normal.hash < high.hash)
  assert.ok(eco.power < normal.power && normal.power < high.power)
  assert.ok(eco.eff < normal.eff && normal.eff < high.eff, 'eco is the most efficient')
})

test('clearing a fault restores the earlier state', () => {
  const sim = new Simulation(small())
  const miner = sim.miners[0]
  const empty = JSON.stringify(miner.fx)
  const emptySite = JSON.stringify(sim.siteFx)
  sim.injectFault({ type: 'hashboard_failure', target: `miner:${miner.id}`, params: { boards: 2 } })
  sim.injectFault({ type: 'heatwave', params: { deltaC: 10 } })
  sim.injectFault({ type: 'heatwave', params: { deltaC: 5 } })
  assert.equal(sim.siteFx.ambientDeltaC, 15, 'heatwaves add up')
  sim.clearFaults(() => true)
  assert.equal(JSON.stringify(miner.fx), empty)
  assert.equal(JSON.stringify(sim.siteFx), emptySite)
})

test('timed faults expire on their own', () => {
  const sim = new Simulation(small())
  sim.injectFault({ type: 'psu_failure', target: 'random:2', durationSec: 100 })
  assert.equal(sim.faults.length, 2)
  run(sim, 99)
  assert.equal(sim.faults.length, 2)
  run(sim, 2)
  assert.equal(sim.faults.length, 0)
})

test('fault targets resolve, and bad ones are refused', () => {
  const sim = new Simulation(small())
  assert.equal(sim.resolveTargets('miner', 'all').length, 20)
  assert.equal(sim.resolveTargets('miner', 'container:c1').length, 10)
  assert.equal(sim.resolveTargets('miner', 'percent:50').length, 10)
  assert.equal(new Set(sim.resolveTargets('miner', 'random:5')).size, 5)
  assert.equal(sim.resolveTargets('miner', 'random:999').length, 20)
  assert.throws(() => sim.injectFault({ type: 'nope' }), /ERR_FAULT_TYPE_INVALID/)
  assert.throws(() => sim.injectFault({ type: 'psu_failure', target: 'miner:nope' }), /ERR_MINER_NOT_FOUND/)
  assert.throws(() => sim.injectFault({ type: 'pool_outage', target: 'pool:nope' }), /ERR_POOL_NOT_FOUND/)
  assert.throws(() => sim.injectFault({ type: 'cooling_failure', target: 'c9' }), /ERR_CONTAINER_NOT_FOUND/)
  assert.throws(() => sim.injectFault({ type: 'psu_failure', target: 'random:0' }), /ERR_TARGET_INVALID/)
  assert.throws(() => sim.minerCommand(sim.miners[0].id, 'fan', 500), /ERR_FAN_SPEED_INVALID/)
  assert.throws(() => sim.setSite({ contractKw: -1 }), /ERR_CONTRACT_INVALID/)
})

test('fault parameters are clamped to their declared range', () => {
  const sim = new Simulation(small())
  const [fault] = sim.injectFault({ type: 'cooling_failure', target: 'c1', params: { severity: 50 } })
  assert.equal(fault.params.severity, 1)
  assert.throws(() => sim.injectFault({ type: 'cooling_failure', target: 'c1', params: { severity: 'x' } }), /ERR_FAULT_PARAM_INVALID/)
})

test('every fault in the catalog can be injected and cleared', () => {
  for (const [type, def] of Object.entries(CATALOG)) {
    const sim = new Simulation(small())
    const target = { miner: 'random:1', container: 'c1', site: undefined, pool: 'pool:f2pool' }[def.scope]
    sim.injectFault({ type, target })
    run(sim, 30)
    assert.ok(sim.faults.length > 0, type)
    sim.clearFaults(() => true)
    run(sim, 30)
    assert.equal(sim.faults.length, 0, type)
  }
})

test('random failures appear at about the configured rate', () => {
  const sim = new Simulation(small())
  sim.setSite({ chaos: { enabled: true, faultsPerMinerDay: 1 } })
  sim.chaos.repairHours = [1000, 1000]
  run(sim, 86400)
  assert.ok(sim.faults.length >= 8 && sim.faults.length <= 35, `expected about 20, got ${sim.faults.length}`)
})

test('scenario times parse, and bad definitions are refused', () => {
  assert.equal(parseTime('01:30:15'), 5415)
  assert.equal(parseTime(90), 90)
  assert.throws(() => parseTime('soon'), /ERR_SCENARIO_TIME_INVALID/)
  assert.throws(() => normalize({ id: 'x' }), /ERR_SCENARIO_INVALID/)
  assert.throws(() => normalize({ id: 'x', name: 'X', events: [{ at: 0, action: 'explode' }] }), /ERR_SCENARIO_ACTION_INVALID/)
  assert.throws(() => normalize({ id: 'x', name: 'X', events: [{ at: 0, action: 'fault', type: 'nope' }] }), /ERR_FAULT_TYPE_INVALID/)
})

test('every shipped scenario runs to the end and cleans up after itself', () => {
  const scenarios = loadScenarios(path.join(__dirname, '..', 'scenarios'))
  assert.ok(scenarios.size >= 9)
  for (const scenario of scenarios.values()) {
    const sim = new Simulation(small())
    const contract = sim.contractKw
    sim.startScenario(scenario)
    run(sim, scenario.durationSec + 1)
    assert.equal(sim.scenario, null, scenario.id)
    assert.equal(sim.lastScenarioResult.reason, 'finished', scenario.id)
    assert.equal(sim.faults.filter((f) => f.source === 'scenario').length, 0, scenario.id)
    assert.equal(sim.contractKw, contract, scenario.id)
    assert.ok(!sim.events.some((e) => e.message.startsWith('Step failed')), scenario.id)
  }
})

test('the shipped scenarios cause what they claim to', () => {
  const scenarios = loadScenarios(path.join(__dirname, '..', 'scenarios'))
  const during = (id, watch) => {
    const sim = new Simulation(buildConfig({ seed: 42 }))
    sim.startScenario(scenarios.get(id))
    const seen = {}
    while (sim.scenario) {
      sim.step(1)
      watch(sim, seen)
    }
    return { sim, seen }
  }

  const cooling = during('cooling-failure', (sim, seen) => {
    seen.tripped = Math.max(seen.tripped || 0, sim.fleetCounts().tripped)
  })
  assert.ok(cooling.seen.tripped > 0, 'cooling-failure trips machines')

  const heat = during('heatwave', (sim, seen) => {
    seen.maxChip = Math.max(seen.maxChip || 0, sim.site.maxChipC)
  })
  assert.ok(heat.seen.maxChip > 85, `heatwave reaches throttling, peaked at ${heat.seen.maxChip}`)

  const curtail = during('curtailment', () => {})
  assert.ok(curtail.sim.lastScenarioResult.penaltyUsd > 0, 'an ignored curtailment costs money')

  const breaker = during('breaker-trip', (sim, seen) => {
    seen.open = seen.open || sim.breakerOpen
  })
  assert.ok(breaker.seen.open, 'breaker-trip opens the breaker')

  const spike = during('price-spike', (sim, seen) => {
    seen.loss = seen.loss || sim.economics.revenueRateUsdH < sim.economics.costRateUsdH
  })
  assert.ok(spike.seen.loss, 'price-spike makes mining unprofitable')

  const pools = during('total-pool-loss', (sim, seen) => {
    if (sim.site.hashThs > 0 && sim.site.creditedThs === 0) seen.wasted = true
  })
  assert.ok(pools.seen.wasted, 'total-pool-loss wastes hashrate')
})

test('history downsampling keeps spikes and the time order', () => {
  const sim = new Simulation(small())
  run(sim, 3600)
  sim.injectFault({ type: 'fan_failure', target: 'random:3' })
  run(sim, 3600)
  const full = sim.historyWindow(0, 100000)
  const small100 = sim.historyWindow(0, 100)
  assert.ok(small100.length <= 110 && small100.length > 50, `${small100.length} points`)
  const peak = Math.max(...full.map((s) => s.chipMax))
  assert.equal(Math.max(...small100.map((s) => s.chipMax)), peak)
  assert.ok(small100.every((s, i) => i === 0 || s.t > small100[i - 1].t))
  assert.ok(sim.historyWindow(600).every((s) => s.t >= sim.t - 600))
})

test('a stopped miner reports zero hashrate within a minute, averages included', () => {
  const sim = new Simulation(small())
  run(sim, 600)
  const miner = sim.miners[0]
  sim.minerCommand(miner.id, 'sleep', undefined, 'quiet')
  run(sim, 60)
  assert.equal(miner.state, 'sleeping')
  assert.equal(miner.ths, 0)
  assert.deepEqual(miner.ema, { s30: 0, m1: 0, m5: 0, m15: 0 })
})

test('hung firmware fades like a working miner, so it can look alive for a while', () => {
  const sim = new Simulation(small())
  run(sim, 600)
  const miner = sim.miners[0]
  sim.injectFault({ type: 'firmware_hang', target: `miner:${miner.id}` })
  run(sim, 60)
  assert.equal(miner.state, 'mining')
  assert.ok(miner.ths > 1, `${miner.ths}`)
  assert.ok(miner.ema.m5 > 50, `${miner.ema.m5}`)
})

test('a new site is fully readable before its first step', () => {
  const sim = new Simulation(small())
  const { site, env, economics, containers, t } = sim.snapshot()
  assert.equal(t, 0)
  assert.equal(site.limitKw, sim.contractKw)
  assert.ok(site.hashThs > 0 && site.creditedThs > 0 && site.powerKw > 0)
  assert.ok(site.maxChipC > 0 && site.avgChipC > 0)
  assert.ok(env.ambientC > 0 && env.priceUsdKwh > 0)
  assert.ok(economics.revenueRateUsdH > 0 && economics.costRateUsdH > 0)
  assert.equal(economics.energyKwh, 0)
  assert.equal(economics.btcEarned, 0)
  assert.ok(containers.every((c) => c.heatKw > 0 && c.availableKw > 0))
  assert.equal(sim.fleetCounts().mining, 20)
})

test('building one config does not change the next', () => {
  const tiny = buildConfig({ fleet: { containers: 1, minersPerContainer: 2 } })
  const full = buildConfig({})
  assert.ok(full.grid.contractKw > tiny.grid.contractKw * 10, `${full.grid.contractKw} vs ${tiny.grid.contractKw}`)
  assert.equal(buildConfig({ fleet: { containers: 1, minersPerContainer: 2 } }).grid.contractKw, tiny.grid.contractKw)
})

test('oversized fleets are refused, and port ranges must not collide', () => {
  assert.throws(() => buildConfig({ fleet: { containers: 100, minersPerContainer: 100 } }), /ERR_FLEET_TOO_LARGE/)
  assert.throws(() => buildConfig({ fleet: { containers: 0 } }), /ERR_FLEET_SIZE_INVALID/)
  assert.throws(() => buildConfig({ fleet: { containers: 20, minersPerContainer: 60 } }), /ERR_PORT_OVERLAP/)
})
