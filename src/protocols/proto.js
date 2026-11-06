'use strict'

// Proto R2 firmware HTTP API v1, as MDK's Proto Worker uses it, with bearer
// tokens from a password login. Logs and firmware update aren't simulated.

const crypto = require('crypto')

const PASSWORD = 'proto-sim-password'
const PREFIX = '/api/v1'
const TARGET_MIN_W = 400
const TARGET_MAX_W = 6000
const FAN_COUNT = 2

const round = (value, digits = 2) => Number(value.toFixed(digits))
const metric = (value, unit, digits = 2) => ({ value: round(value, digits), unit })

// Tokens belong to the device connection, not the model, so they outlive a reset.
const sessions = new Map()

function sessionFor (miner) {
  let session = sessions.get(miner.port)
  if (!session) {
    session = {}
    sessions.set(miner.port, session)
  }
  return session
}

function issue (session) {
  session.access = `sim-access-${crypto.randomBytes(12).toString('hex')}`
  session.refresh = `sim-refresh-${crypto.randomBytes(12).toString('hex')}`
  return { access_token: session.access, refresh_token: session.refresh }
}

function miningStatus (miner) {
  if (miner.suspended || miner.state === 'sleeping') return 'Stopped'
  if (miner.state === 'failed' || miner.state === 'tripped') return 'Error'
  if (miner.state !== 'mining') return 'PoweringOn'
  if (miner.activePool < 0) return 'NoPools'
  if (miner.fx.boardsDown > 0 || miner.overheating) return 'DegradedMining'
  return 'Mining'
}

function errors (miner) {
  const { fx } = miner
  const at = Math.floor(Date.now() / 1000)
  const out = []
  const add = (code, slot) => out.push({ error_code: code, timestamp: at, ...(slot === undefined ? {} : { slot }) })
  if (fx.fanLoss > 0) add('FanFault', 1)
  if (fx.boardsDown > 0) add('HashboardFault', miner.spec.boards)
  if (fx.psuFailed) add('PsuFault', 1)
  if (fx.controlBoard) add('ControlBoardFault')
  if (miner.overheating) add('OverTemperature')
  return out
}

function boards (miner) {
  const { spec, fx } = miner
  const alive = Math.max(0, spec.boards - fx.boardsDown)
  return Array.from({ length: spec.boards }, (_, index) => {
    const share = index < alive && alive ? 1 / alive : 0
    const ths = miner.ths * share
    const watts = miner.powerW * share
    return {
      index,
      serial_number: `${miner.serial}B${index}`,
      hashrate: metric(ths, 'TH/s'),
      temperature: {
        unit: '°C',
        inlet: round(miner.inletC, 1),
        outlet: round(miner.tMaxC, 1),
        average: round(miner.chipC, 1)
      },
      power: metric(watts, 'W', 0),
      efficiency: metric(ths > 1 ? watts / ths : 0, 'J/TH'),
      voltage: metric(share ? 12.1 : 0, 'V'),
      current: metric(watts / 12.1, 'A')
    }
  })
}

function telemetry (miner) {
  return {
    miner: {
      hashrate: metric(miner.ths, 'TH/s'),
      temperature: metric(miner.chipC, '°C', 1),
      power: metric(miner.powerW, 'W', 0),
      efficiency: metric(miner.ths > 1 ? miner.powerW / miner.ths : 0, 'J/TH')
    },
    hashboards: boards(miner)
  }
}

function poolRows (miner, sim) {
  return miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    const live = pool && !pool.fx.down && !miner.fx.netDown
    return {
      url: entry.url,
      user: entry.user,
      accepted: entry.accepted,
      rejected: entry.rejected,
      status: index === miner.activePool ? 'Active' : live ? 'Idle' : 'Dead'
    }
  })
}

function target (miner) {
  return {
    power_target_watts: Math.round(miner.spec.nominalW * miner.powerScale),
    power_target_min_watts: TARGET_MIN_W,
    power_target_max_watts: TARGET_MAX_W,
    performance_mode: miner.mode.name === 'eco' ? 'Efficiency' : 'MaximumHashrate'
  }
}

function systemInfo (miner, sim) {
  return {
    model: miner.spec.name,
    cb_sn: miner.serial,
    product_name: 'Proto R2 Rig',
    manufacturer: 'Proto',
    uptime_seconds: Math.floor(sim.t),
    os: { version: 'sim' },
    mining_driver_sw: { name: 'mining-driver', version: 'sim' },
    pool_interface_sw: { name: 'pool-interface', version: 'sim' },
    web_server: { name: 'web-server', version: 'sim' },
    web_dashboard: { name: 'web-dashboard', version: 'sim' },
    hashboard_firmware: { version: 'sim' },
    board: { revision: 'rev-c' },
    soc: { model: 'soc-model' },
    sw_update_status: { status: 'Idle' }
  }
}

function network (miner, sim) {
  return {
    mac: `02:00:00:00:${(miner.index >> 8).toString(16).padStart(2, '0')}:${(miner.index & 255).toString(16).padStart(2, '0')}`,
    hostname: miner.id,
    dhcp: true,
    ip: sim.cfg.host,
    netmask: '255.255.255.0',
    gateway: '127.0.0.1'
  }
}

function handle (miner, sim, req, rawBody) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null
  const json = (status, body) => ({ status, body: JSON.stringify(body) })
  if (path === null) return json(404, { error: 'not found' })

  let body = null
  if (rawBody.length) {
    try {
      body = JSON.parse(rawBody.toString())
    } catch {
      return json(400, { error: 'invalid json' })
    }
  }

  const session = sessionFor(miner)
  if (req.method === 'POST' && path === '/auth/login') {
    if (body?.password !== PASSWORD) return json(401, { error: 'unauthorized' })
    return json(200, issue(session))
  }
  if (req.method === 'POST' && path === '/auth/refresh') {
    if (!session.refresh || body?.refresh_token !== session.refresh) return json(401, { error: 'unauthorized' })
    return json(200, issue(session))
  }
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!token || token !== session.access) return json(401, { error: 'unauthorized' })

  const source = 'proto'
  const route = `${req.method} ${path}`
  switch (route) {
    case 'GET /mining':
      return json(200, {
        'mining-status': {
          status: miningStatus(miner),
          reboot_uptime_s: Math.max(0, Math.floor(sim.t - miner.bootedAt)),
          power_usage_watts: Math.round(miner.powerW),
          power_efficiency_jth: miner.ths > 1 ? round(miner.powerW / miner.ths) : 0
        }
      })
    case 'GET /mining/target':
      return json(200, target(miner))
    case 'PUT /mining/target': {
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) return json(400, { error: 'bad request' })
      const { power_target_watts: watts, performance_mode: mode } = body
      if (watts !== undefined) {
        if (!Number.isSafeInteger(watts) || watts < TARGET_MIN_W || watts > TARGET_MAX_W) return json(400, { error: 'bad request' })
      }
      if (mode !== undefined && !['MaximumHashrate', 'Efficiency'].includes(mode)) return json(400, { error: 'bad request' })
      if (watts !== undefined) {
        const pct = Math.min(120, Math.max(10, watts / miner.spec.nominalW * 100))
        sim.minerCommand(miner.id, 'powerPct', pct, source)
      }
      if (mode !== undefined) sim.minerCommand(miner.id, 'mode', mode === 'Efficiency' ? 'eco' : 'normal', source)
      return json(200, target(miner))
    }
    case 'POST /mining/start':
      sim.minerCommand(miner.id, 'wake', undefined, source)
      return json(200, { status: 'Mining' })
    case 'POST /mining/stop':
      sim.minerCommand(miner.id, 'sleep', undefined, source)
      return json(200, { status: 'Stopped' })
    case 'GET /telemetry':
      return json(200, telemetry(miner))
    case 'GET /pools':
      return json(200, { pools: poolRows(miner, sim) })
    case 'POST /pools': {
      if (!Array.isArray(body)) return json(400, { error: 'bad request' })
      sim.setMinerPools(miner.id, body.map((p) => ({ url: p.url, user: p.username, password: p.password || '' })), source)
      return json(200, { pools: poolRows(miner, sim) })
    }
    case 'GET /errors':
      return json(200, errors(miner))
    case 'GET /cooling':
      return json(200, {
        'cooling-status': {
          fan_mode: 'Auto',
          speed_percentage: Math.round(miner.fanPct),
          fans: Array.from({ length: FAN_COUNT }, (_, i) => ({
            slot: i + 1,
            rpm: Math.round(miner.fanPct * (1 - miner.fx.fanLoss) * 62),
            percentage: Math.round(miner.fanPct)
          }))
        }
      })
    case 'GET /hardware/psus':
      return json(200, {
        'psus-info': [{
          psu_sn: `PSU${miner.serial}`,
          slot: 1,
          manufacturer: 'Simulator',
          hw_revision: 'sim-1',
          model: 'Sim PSU',
          vendor: 'Simulator',
          firmware: { app_version: 'sim-1', bootloader_version: 'sim-1' },
          power: {
            input_voltage_mv: 240000,
            output_voltage_mv: miner.fx.psuFailed ? 0 : 12100,
            input_current_ma: Math.round(miner.powerW / 240 * 1000),
            output_current_ma: Math.round(miner.powerW / 12.1 * 1000),
            input_power_mw: Math.round(miner.powerW * 1000),
            output_power_mw: Math.round(miner.powerW * 968)
          },
          temperatures: [{ temperature_type: 'hotspot', temperature_c: Math.round(miner.inletC + 15) }]
        }]
      })
    case 'GET /hashboards':
      return json(200, {
        'hashboards-info': Array.from({ length: miner.spec.boards }, (_, i) => ({
          hb_sn: `${miner.serial}B${i}`, slot: i + 1, board: 'B4_192', mining_asic: 'MC3', mining_asic_count: 2
        }))
      })
    case 'GET /network':
      return json(200, { 'network-info': network(miner, sim) })
    case 'PUT /network':
      return json(200, { 'network-info': network(miner, sim) })
    case 'GET /system':
      return json(200, { 'system-info': systemInfo(miner, sim) })
    case 'POST /system/reboot':
      sim.minerCommand(miner.id, 'reboot', undefined, source)
      return json(200, { rebooting: true })
    case 'POST /system/locate': {
      const enable = url.searchParams.get('enable') === 'true'
      sim.minerCommand(miner.id, 'led', enable, source)
      return json(200, { locating: enable })
    }
    default:
      break
  }

  const board = /^\/hashboards\/([^/]+)$/.exec(path)
  if (req.method === 'GET' && board) {
    const serial = decodeURIComponent(board[1])
    const index = Array.from({ length: miner.spec.boards }, (_, i) => `${miner.serial}B${i}`).indexOf(serial)
    if (index < 0) return json(404, { error: 'not found' })
    const alive = index < miner.spec.boards - miner.fx.boardsDown
    return json(200, {
      'hashboard-stats': {
        hb_sn: serial,
        slot: index + 1,
        status: alive ? 'Running' : 'Error',
        asics: Array.from({ length: 2 }, (_, i) => ({
          index: i,
          id: `A${i}`,
          row: 0,
          column: i,
          freq_mhz: alive ? 650 : 0,
          temp_c: round(miner.chipC + i * 0.5, 1),
          voltage_mv: 308.5,
          hashrate_ghs: alive ? round(miner.ths * 500 / miner.spec.boards) : 0,
          ideal_hashrate_ghs: round(miner.spec.nominalThs * 500 / miner.spec.boards),
          error_rate: round(miner.fx.chipLoss, 3)
        }))
      }
    })
  }
  return json(404, { error: 'not found' })
}

module.exports = { handle, PASSWORD }
