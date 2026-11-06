'use strict'

// Talks to the device servers over real sockets. The parsing rules below copy
// what MDK's drivers do, so a format change here would break them too. The real
// drivers run in compat/run.js, which needs an MDK checkout.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const net = require('net')
const { buildConfig } = require('../src/config')
const { Runner } = require('../src/runner')
const { encodePower } = require('../src/protocols/satec')

const PORTS = { api: 0, minerBase: 34030, meter: 35020, sensorBase: 35021, pool: 38000 }

let runner
let sim

before(async () => {
  runner = new Runner(buildConfig({ seed: 5, fleet: { containers: 2, minersPerContainer: 3, mix: { avalon: 1 } }, ports: PORTS }))
  await runner.startProtocols()
  sim = runner.sim
  for (let i = 0; i < 300; i++) sim.step(1)
})

after(() => runner.stop())

const advance = (seconds) => { for (let i = 0; i < seconds; i++) sim.step(1) }

// One request per connection; the reply ends when the device closes the socket.
function cgminer (port, command) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(command))
    let data = ''
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

// As in the driver: split on commas, then on the first '=' pair.
function parseResponse (input) {
  const out = {}
  for (const pair of input.split(',')) {
    const [key, value] = pair.split('=')
    out[key] = value
  }
  return out
}

function parsePools (input) {
  return input.split('|').map(parseResponse).slice(1, -1)
}

function bracket (input, key) {
  const match = input.match(new RegExp(`${key}\\[(.*?)\\]`))
  return match ? match[1] : null
}

test('summary carries hashrate in MH/s', async () => {
  const miner = sim.miners[0]
  const parsed = parseResponse(await cgminer(miner.port, 'summary'))
  assert.ok(Math.abs(parseFloat(parsed['MHS av']) / 1e6 - miner.ema.s30) < 0.01)
  assert.equal(parsed.Elapsed, String(Math.floor(sim.t - miner.bootedAt)))
  assert.ok(parsed['MHS 5m'] && parsed['MHS 15m'] && parsed['Pool Rejected%'])
})

test('estats has every field the driver reads', async () => {
  const miner = sim.miners[0]
  const res = await cgminer(miner.port, 'estats')
  const fields = ['DNA', 'MEMFREE', 'NETFAIL', 'SYSTEMSTATU', 'BOOTBY', 'LW', 'MH', 'HW', 'DH', 'Temp', 'TMax', 'TAvg',
    'Fan1', 'Fan2', 'FanR', 'Vo', 'PS', 'PLL0', 'PLL1', 'PLL2', 'GHSspd', 'GHSmm', 'GHSavg', 'Freq', 'Led', 'MGHS', 'MTmax',
    'MTavg', 'TA', 'PING', 'Core', 'POWS', 'EEPROM', 'HASHS', 'POOLS', 'SoftOFF', 'ECHU', 'ECMM', 'SF0', 'SF1', 'SF2',
    'PVT_T0', 'PVT_T1', 'PVT_T2', 'PVT_V0', 'PVT_V1', 'PVT_V2', 'MW0', 'MW1', 'MW2', 'CRC', 'FACOPTS0', 'FACOPTS1', 'FACOPTS2',
    'ATABD0', 'ATABD1', 'ATABD2', 'ADJ', 'COP', 'MPO', 'MVL', 'WORKMODE']
  for (const field of fields) assert.notEqual(bracket(res, field), null, field)
  assert.equal(bracket(res, 'DNA'), miner.serial)
  assert.equal(bracket(res, 'MPO'), String(Math.round(miner.powerW)))
  assert.equal(bracket(res, 'TAvg'), miner.chipC.toFixed(0))
  assert.equal(bracket(res, 'Temp'), miner.inletC.toFixed(0))
})

test('driver-side error fields stay clear on a healthy miner', async () => {
  const res = await cgminer(sim.miners[0].port, 'estats')
  assert.equal(bracket(res, 'PS').split(' ')[0], '0')
  assert.ok(!bracket(res, 'PS').split(' ').every((p) => p === '0'))
  assert.equal(bracket(res, 'ECHU'), '0')
  assert.equal(bracket(res, 'ECMM'), '0')
  assert.equal(bracket(res, 'POWS'), '0')
  assert.equal(bracket(res, 'POOLS'), '0')
  assert.ok(bracket(res, 'HASHS').split(' ').every((v) => v === '0'))
})

test('pools parses into exactly one entry per pool', async () => {
  const pools = parsePools(await cgminer(sim.miners[0].port, 'pools'))
  assert.equal(pools.length, 3)
  assert.ok(pools.every((p) => p.URL && p.User))
  assert.equal(pools[0].Status, 'Alive')
  assert.equal(pools[1].Status, 'Alive')
  assert.equal(pools[2].Status, 'Dead', 'the placeholder never connects')
  assert.equal(pools[0]['Stratum Active'], 'true')
})

test('all_pools_dead can fire: every entry reads Dead when all pools are out', async () => {
  const faults = [...sim.pools.keys()].flatMap((id) => sim.injectFault({ type: 'pool_outage', target: `pool:${id}` }))
  advance(2)
  const miner = sim.miners[0]
  const pools = parsePools(await cgminer(miner.port, 'pools'))
  assert.ok(pools.every((p) => p.Status === 'Dead'), JSON.stringify(pools.map((p) => p.Status)))
  assert.equal(bracket(await cgminer(miner.port, 'estats'), 'POOLS'), '1')
  sim.clearFaults((f) => faults.includes(f))
  advance(2)
})

test('version parses', async () => {
  const parsed = parseResponse(await cgminer(sim.miners[0].port, 'version'))
  assert.equal(parsed.MODEL, '1346-116')
  assert.equal(parsed.CGMiner, '4.11.1')
  assert.ok(parsed.MAC && parsed.VERSION)
})

test('each fault produces the error fields the driver maps to alerts', async () => {
  const miner = sim.miners[1]
  const estats = () => cgminer(miner.port, 'estats')
  const inject = (type, params) => sim.injectFault({ type, target: `miner:${miner.id}`, params })
  const clear = () => sim.clearFaults(() => true)

  inject('hashboard_failure', { boards: 1 })
  advance(2)
  let res = await estats()
  assert.equal(bracket(res, 'ECHU'), '513')
  assert.ok(bracket(res, 'HASHS').split(' ').includes('1'))
  clear()

  inject('control_board_fault')
  assert.equal(bracket(await estats(), 'ECMM'), '1')
  clear()

  inject('psu_failure')
  advance(2)
  res = await estats()
  assert.equal(bracket(res, 'PS').split(' ')[0], '1')
  assert.equal(bracket(res, 'POWS'), '1')
  clear()
  advance(200)

  // With no fan it trips, cools, restarts and trips again, so stop at the first.
  inject('fan_failure', { severity: 1 })
  for (let i = 0; i < 1800 && miner.state !== 'tripped'; i++) sim.step(1)
  assert.equal(miner.state, 'tripped')
  assert.equal(bracket(await estats(), 'ECHU'), '128')
  clear()
  advance(1500)
  assert.equal(miner.state, 'mining')
})

test('softoff reports sleeping without looking like a power fault', async () => {
  const miner = sim.miners[2]
  const parsed = parseResponse(await cgminer(miner.port, 'ascset|0,softoff'))
  assert.ok(['118', '119'].includes(parsed.Code))
  advance(60)
  assert.equal(miner.state, 'sleeping')
  const res = await cgminer(miner.port, 'estats')
  assert.equal(bracket(res, 'SoftOFF'), '1')
  assert.ok(!bracket(res, 'PS').split(' ').every((p) => p === '0'), 'all zeros would read as a dead power link')
  assert.ok(Number(bracket(res, 'MPO')) < 200)
})

test('workmode reads and writes, and rejects bad values', async () => {
  const miner = sim.miners[2]
  const read = parseResponse(await cgminer(miner.port, 'ascset|0,workmode,255'))
  assert.equal(bracket(read.Msg, 'WORKMODE'), '0')
  const write = parseResponse(await cgminer(miner.port, 'ascset|0,workmode,1'))
  assert.equal(write.Code, '118')
  assert.equal(miner.workMode, 1)
  const bad = await cgminer(miner.port, 'ascset|0,workmode,9')
  assert.match(bad, /STATUS=E/)
  await cgminer(miner.port, 'ascset|0,workmode,0')
})

test('reboot closes without a reply, then refuses connections until booted', async () => {
  const miner = sim.miners[2]
  assert.equal(await cgminer(miner.port, 'ascset|0,reboot,0'), '')
  assert.equal(miner.state, 'booting')
  await assert.rejects(cgminer(miner.port, 'version'), /ECONNRESET|socket hang up/)
  advance(200)
  assert.equal(miner.state, 'mining')
  assert.ok(await cgminer(miner.port, 'version'))
})

test('setpool needs the right password and then changes the pool', async () => {
  const miner = sim.miners[0]
  const denied = parseResponse(await cgminer(miner.port, 'ascset|0,setpool,root,wrong,0,stratum+tcp://x.sim:1,a,b'))
  assert.equal(denied.Code, '120')
  assert.notEqual(miner.pools[0].url, 'stratum+tcp://x.sim:1')

  const url = 'stratum+tcp://new.pool.sim:3333'
  const ok = parseResponse(await cgminer(miner.port, `ascset|0,setpool,root,root,1,${url},acct,x`))
  assert.equal(ok.Code, '119')
  assert.equal(miner.pools[1].url, url)
  assert.equal(miner.pools[1].user, 'acct')
  await cgminer(miner.port, 'pools')
  assert.ok(sim.pools.has('new.pool.sim'))
})

test('led, fan, password and unknown commands behave', async () => {
  const miner = sim.miners[0]
  assert.equal(parseResponse(await cgminer(miner.port, 'ascset|0,led,0-1')).Code, '118')
  assert.equal(miner.led, true)
  await cgminer(miner.port, 'ascset|0,led,0-0')
  assert.equal(parseResponse(await cgminer(miner.port, 'ascset|0,fan-spd,70')).Code, '119')
  assert.equal(miner.manualFanPct, 70)
  miner.manualFanPct = null
  assert.match(await cgminer(miner.port, 'ascset|0,fan-spd,500'), /STATUS=E/)
  assert.match(await cgminer(miner.port, 'ascset|0,password,wrong,new'), /STATUS=E/)
  assert.equal(await cgminer(miner.port, 'nonsense'), '')
})

test('a miner with no network resets connections', async () => {
  const miner = sim.miners[0]
  sim.injectFault({ type: 'network_loss', target: `miner:${miner.id}` })
  await assert.rejects(cgminer(miner.port, 'version'), /ECONNRESET|socket hang up/)
  sim.clearFaults(() => true)
  assert.ok(await cgminer(miner.port, 'version'))
})

test('a slow network delays the reply', async () => {
  const miner = sim.miners[0]
  sim.injectFault({ type: 'network_latency', target: `miner:${miner.id}`, params: { delayMs: 300 } })
  const started = Date.now()
  await cgminer(miner.port, 'version')
  assert.ok(Date.now() - started >= 280)
  sim.clearFaults(() => true)
})

// Same request framing as MDK's Modbus client, which subtracts one from the
// address it is given.
function modbusRead (port, register, quantity, unitId = 1, fc = 3) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const req = Buffer.alloc(12)
      req.writeUInt16BE(77, 0)
      req.writeUInt16BE(0, 2)
      req.writeUInt16BE(6, 4)
      req.writeUInt8(unitId, 6)
      req.writeUInt8(fc, 7)
      req.writeUInt16BE(register - 1, 8)
      req.writeUInt16BE(quantity, 10)
      socket.write(req)
    })
    socket.once('data', (data) => {
      socket.destroy()
      resolve(data)
    })
    socket.on('error', reject)
  })
}

test('SATEC reads return the 38 bytes the driver concatenates', async () => {
  const { meter } = PORTS
  const parts = await Promise.all([modbusRead(meter, 257, 6), modbusRead(meter, 272, 7), modbusRead(meter, 296, 6)])
  for (const part of parts) {
    assert.equal(part.readUInt16BE(0), 77, 'echoes the transaction id')
    assert.equal(part.readUInt8(7), 3)
  }
  const data = Buffer.concat(parts.map((part) => part.subarray(9)))
  assert.equal(data.length, 38)

  // The driver's decoding.
  const step = 217365.12 / 9999
  const kw = (data.readInt16BE(20) * step) - 108682.56
  assert.ok(Math.abs(kw - sim.meterReading.powerKw) <= step, `${kw} vs ${sim.meterReading.powerKw}`)
  const volts = data.readInt16BE(0) * 45360 / 9999
  assert.ok(Math.abs(volts - sim.meterReading.voltageV) < 10)
  const pf = data.readInt16BE(12) * 2 / 9999 - 1
  assert.ok(Math.abs(pf - 0.98) < 0.001)
})

test('SATEC zero power decodes as zero', () => {
  const kw = Math.max(encodePower(0) * (217365.12 / 9999) - 108682.56, 0)
  assert.equal(kw, 0)
})

test('Modbus refuses unmapped addresses and unsupported functions', async () => {
  const unmapped = await modbusRead(PORTS.meter, 1000, 2)
  assert.equal(unmapped.readUInt8(7), 0x83)
  assert.equal(unmapped.readUInt8(8), 2)
  const unsupported = await modbusRead(PORTS.meter, 257, 1, 1, 6)
  assert.equal(unsupported.readUInt8(7), 0x86)
  assert.equal(unsupported.readUInt8(8), 1)
})

test('Modbus handles requests split across reads and joined in one', async () => {
  const frame = (tid) => {
    const req = Buffer.alloc(12)
    req.writeUInt16BE(tid, 0)
    req.writeUInt16BE(6, 4)
    req.writeUInt8(1, 6)
    req.writeUInt8(3, 7)
    req.writeUInt16BE(256, 8)
    req.writeUInt16BE(1, 10)
    return req
  }
  const replies = await new Promise((resolve, reject) => {
    const socket = net.connect(PORTS.meter, '127.0.0.1')
    const chunks = []
    socket.on('data', (data) => {
      chunks.push(data)
      if (Buffer.concat(chunks).length >= 33) {
        socket.destroy()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.on('error', reject)
    socket.write(frame(1).subarray(0, 5))
    setTimeout(() => socket.write(Buffer.concat([frame(1).subarray(5), frame(2), frame(3)])), 30)
  })
  assert.deepEqual([0, 11, 22].map((at) => replies.readUInt16BE(at)), [1, 2, 3])
})

test('Seneca channels read in tenths of a degree, per container', async () => {
  const [c1] = sim.containers
  const value = async (register) => (await modbusRead(c1.sensorPort, register, 1, 0)).subarray(9).readUInt16BE(0) / 10
  assert.ok(Math.abs(await value(3) - c1.inletC) <= 0.1)
  assert.ok(Math.abs(await value(4) - c1.exhaustC) <= 0.1)
  assert.ok(Math.abs(await value(5) - sim.env.ambientC) <= 0.1)
})

test('a Seneca fault reads 850.0, which the driver treats as an error', async () => {
  const [c1, c2] = sim.containers
  sim.injectFault({ type: 'sensor_fault', target: c1.id })
  const raw = (await modbusRead(c1.sensorPort, 3, 1, 0)).subarray(9).readUInt16BE(0)
  assert.equal(raw / 10, 850)
  const other = (await modbusRead(c2.sensorPort, 3, 1, 0)).subarray(9).readUInt16BE(0)
  assert.ok(other < 1000, 'the other container is unaffected')
  sim.clearFaults(() => true)
})

const secret = 'secret-key'
const account = 'haven7346'

async function f2 (path, body = {}, headers = { 'F2P-API-SECRET': secret }) {
  const res = await fetch(`http://127.0.0.1:${PORTS.pool}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ mining_user_name: account, currency: 'bitcoin', ...body })
  })
  return { status: res.status, body: await res.json() }
}

test('the pool API requires its secret', async () => {
  const { status } = await f2('/v2/assets/balance', {}, {})
  assert.equal(status, 401)
})

test('the pool API refuses unknown accounts and currencies', async () => {
  assert.equal((await f2('/v2/assets/balance', { mining_user_name: 'stranger' })).body.code, 5010)
  assert.equal((await f2('/v2/assets/balance', { currency: 'doge' })).body.code, 5001)
})

test('balance reflects what the site has earned', async () => {
  advance(600)
  const { body } = await f2('/v2/assets/balance')
  const pool = sim.pools.get('f2pool')
  assert.ok(body.balance_info.total_income > 0)
  assert.equal(body.balance_info.total_income, pool.btcTotal)
  for (const field of ['paid', 'yesterday_income', 'estimated_today_income']) {
    assert.equal(typeof body.balance_info[field], 'number', field)
  }
})

test('history ends with current hashrate in H/s, within the requested range', async () => {
  const end = Math.floor(Date.now() / 1000)
  const { body } = await f2('/v2/hash_rate/history', { start_time: end - 3600, end_time: end })
  const list = body.hash_rate_list
  assert.ok(list.length >= 1)
  const latest = list[list.length - 1]
  const pool = sim.pools.get('f2pool')
  assert.ok(Math.abs(latest.hash_rate - pool.creditedThs * 1e12) < 1e12)
  assert.ok(latest.hash_rate > 1e14, 'in H/s, not TH/s')
  assert.ok(list.every((item) => item.timestamp >= end - 3600 && item.timestamp <= end))
})

test('history needs a time range', async () => {
  assert.equal((await f2('/v2/hash_rate/history')).body.code, 5001)
})

test('worker list reports each miner, using the API status convention', async () => {
  const { body } = await f2('/v2/hash_rate/worker/list')
  assert.equal(body.workers.length, sim.miners.length)
  const worker = body.workers.find((w) => w.hash_rate_info.name === sim.miners[1].id)
  assert.equal(worker.status, 0, 'status 0 means online')
  assert.ok(worker.hash_rate_info.hash_rate > 0)
  assert.ok(worker.host)

  const miner = sim.miners[1]
  sim.injectFault({ type: 'network_loss', target: `miner:${miner.id}` })
  advance(2)
  const after = (await f2('/v2/hash_rate/worker/list')).body.workers.find((w) => w.hash_rate_info.name === miner.id)
  assert.equal(after.status, 1)
  assert.equal(after.hash_rate_info.hash_rate, 0)
  sim.clearFaults(() => true)
})

test('a pool outage with its API down answers 503', async () => {
  sim.injectFault({ type: 'pool_outage', target: 'pool:f2pool', params: { apiDown: 1 } })
  assert.equal((await f2('/v2/assets/balance')).status, 503)
  sim.clearFaults(() => true)
  assert.equal((await f2('/v2/assets/balance')).status, 200)
})

test('settled days appear as transactions the Worker can query by real time', async () => {
  advance(86400)
  const end = Math.floor(Date.now() / 1000) + 1
  const { body } = await f2('/v2/assets/transactions/list', { start_time: end - 86400, end_time: end })
  assert.ok(body.transactions.length >= 1)
  assert.ok(body.transactions[0].changed_balance > 0)
  const balance = (await f2('/v2/assets/balance')).body.balance_info
  assert.ok(balance.yesterday_income > 0)
  assert.ok(balance.paid > 0)
})

test('connections are counted, and a reset keeps the servers working', async () => {
  const seen = runner.stats.view()
  assert.ok(seen.avalon.requests > 0 && seen.satec.requests > 0 && seen.seneca.requests > 0 && seen.f2pool.requests > 0)

  runner.reset()
  sim = runner.sim
  assert.equal(sim.t, 0)
  assert.ok(await cgminer(sim.miners[0].port, 'version'))
  assert.equal((await modbusRead(PORTS.meter, 257, 6)).readUInt8(7), 3)
})

test('the MDK config lists every device at a port that answers', async () => {
  const config = runner.mdkConfig()
  assert.equal(config.avalon.seedDevices.length, sim.miners.length)
  assert.equal(config.seneca.seedDevices.length, sim.containers.length * 4)
  for (const device of config.avalon.seedDevices) {
    assert.ok(device.opts.address && device.opts.password && device.info.serialNum)
    assert.ok(await cgminer(device.opts.port, 'version'))
  }
  for (const device of config.seneca.seedDevices) {
    const reply = await modbusRead(device.opts.port, device.opts.register, 1, device.opts.unitId)
    assert.equal(reply.readUInt8(7), 3)
  }
  assert.equal(config.f2pool.accounts[0], account)
  assert.equal(config.f2pool.apiSecret, secret)
})
