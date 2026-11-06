'use strict'

// Whatsminer API v3 on port 4433, as MDK's Whatsminer Worker uses it. Each
// message is framed with a 4-byte little-endian length. Writes carry
// SHA256(cmd + password + salt + ts), and sensitive parameters are AES-encrypted
// with that digest. The weak construction is the vendor's wire protocol.

const crypto = require('crypto')

const SENSITIVE = new Set(['set.miner.pools', 'set.user.change_passwd'])
const API_PASSWORD = 'super'
const API_ACCOUNT = 'admin'

// Chosen to match the names in the Worker's own table, so it reports the right
// fault. Which of these real firmware sends in each case isn't something we've checked.
const ERROR_CODES = { fan: 120, psu: 210, overheat: 350, board: 530, control: 610 }

const reply = (code, msg, desc) => ({ code, when: Math.floor(Date.now() / 1000), msg, desc })
const round = (value, digits = 3) => Number(value.toFixed(digits))

function saltFor (miner) {
  return crypto.createHash('sha256').update(`salt:${miner.serial}`).digest('base64url').slice(0, 8)
}

function authKey (miner, request) {
  return crypto.createHash('sha256').update(`${request.cmd}${API_PASSWORD}${saltFor(miner)}${request.ts}`).digest()
}

function decryptParam (request, key) {
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
  const text = Buffer.concat([decipher.update(Buffer.from(String(request.param), 'base64')), decipher.final()]).toString('utf8')
  return JSON.parse(text)
}

function errorList (miner) {
  const { fx } = miner
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const out = []
  const add = (code) => out.push({ [code]: at })
  if (fx.fanLoss > 0) add(ERROR_CODES.fan)
  if (fx.psuFailed) add(ERROR_CODES.psu)
  if (miner.overheating) add(ERROR_CODES.overheat)
  if (fx.boardsDown > 0) add(ERROR_CODES.board)
  if (fx.controlBoard) add(ERROR_CODES.control)
  return out
}

function deviceInfo (miner, sim) {
  return {
    network: {
      ip: sim.cfg.host,
      proto: 'dhcp',
      netmask: '255.255.255.0',
      dns: '127.0.0.1',
      gateway: '127.0.0.1',
      hostname: miner.id,
      mac: `00:11:22:33:${(miner.index >> 8).toString(16).padStart(2, '0')}:${(miner.index & 255).toString(16).padStart(2, '0')}`
    },
    miner: { type: miner.spec.name, working: String(miner.state === 'mining'), 'miner-sn': miner.serial, UpfreqSpeed: '2' },
    system: { api: '3.0.3', platform: 'H616', fwversion: '20260819.sim', 'control-board-version': 'CB6V10', ledstatus: miner.led ? 'manual' : 'auto' },
    power: {
      type: 'P221C',
      hwversion: 'R00033',
      swversion: 'P00031',
      model: 'P22-12-3300-C',
      fanspeed: miner.fx.psuFailed ? 0 : 6112,
      iin: round(miner.powerW / 220.5, 1),
      vin: 220.5,
      sn: `PSU${miner.serial}`,
      vendor: '1'
    },
    'error-code': errorList(miner),
    salt: saltFor(miner)
  }
}

function summary (miner, sim) {
  const { ema, spec } = miner
  const power = Math.round(miner.powerW)
  return {
    elapsed: Math.max(0, Math.floor(sim.t - miner.bootedAt)),
    'bootup-time': Math.floor(sim.t),
    'freq-avg': miner.state === 'mining' ? 788 : 0,
    'target-freq': 0,
    'factory-hash': spec.nominalThs,
    'hash-average': round(ema.m5),
    'hash-1min': round(ema.m1),
    'hash-15min': round(ema.m15),
    'hash-realtime': round(miner.ths),
    'power-rate': miner.ths > 1 ? round(power / miner.ths) : 0,
    'power-5min': power,
    'power-on-stats': { 'energy-ws': 0, 'total-ths': 0, 'total-pool-ths': 0, 'reject-percent': 0 },
    'power-realtime': power,
    'environment-temperature': round(miner.inletC, 1),
    'board-temperature': Array(spec.boards).fill(round(miner.chipC - 12, 1)),
    'chip-temp-min': round(miner.chipC - 3, 1),
    'chip-temp-avg': round(miner.chipC, 1),
    'chip-temp-max': round(miner.tMaxC, 1),
    'power-limit': Math.round(spec.nominalW * miner.powerScale),
    'up-freq-finish': 1,
    'fan-speed-in': Math.round(miner.fanPct * (1 - miner.fx.fanLoss) * 62),
    'fan-speed-out': Math.round(miner.fanPct * (1 - miner.fx.fanLoss) * 62)
  }
}

function pools (miner, sim) {
  return miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    const total = entry.accepted + entry.rejected + entry.stale
    return {
      id: index + 1,
      url: entry.url,
      status: pool && !pool.fx.down && !miner.fx.netDown ? 'alive' : 'dead',
      account: entry.user,
      'stratum-active': index === miner.activePool,
      'reject-percent': total ? round(entry.rejected / total * 100, 2) : 0,
      'last-share-time': Math.floor(Date.now() / 1000)
    }
  })
}

function edevs (miner) {
  const { spec, fx, ema } = miner
  const alive = Math.max(0, spec.boards - fx.boardsDown)
  return Array.from({ length: spec.boards }, (_, id) => {
    const share = id < alive && alive ? 1 / alive : 0
    return {
      id,
      slot: id,
      'hash-average': round(ema.m5 * share),
      'factory-hash': round(spec.nominalThs / spec.boards),
      freq: id < alive ? 785 : 0,
      'effective-chips': id < alive ? 70 : 0,
      'chip-temp-min': round(miner.chipC - 3, 1),
      'chip-temp-avg': round(miner.chipC, 1),
      'chip-temp-max': round(miner.tMaxC, 1)
    }
  })
}

function setting (miner) {
  const names = { normal: 'normal', high: 'high', eco: 'low' }
  return {
    'power-mode': names[miner.mode.name] || 'normal',
    'power-limit': Math.round(miner.spec.nominalW * miner.powerScale),
    'upfreq-speed': 2,
    'target-freq': 0,
    power: 0,
    'power-percent': Math.round(miner.powerScale * 100),
    'fast-hash': 'disable'
  }
}

function applyWrite (miner, sim, cmd, param) {
  const source = 'whatsminer'
  switch (cmd) {
    case 'set.miner.service':
      if (param === 'stop') sim.minerCommand(miner.id, 'sleep', undefined, source)
      else if (param === 'start') sim.minerCommand(miner.id, 'wake', undefined, source)
      else if (param === 'restart') sim.minerCommand(miner.id, 'reboot', undefined, source)
      else return 'invalid service action'
      return null
    case 'set.miner.power_mode': {
      const modes = { low: 'eco', normal: 'normal', high: 'high' }
      if (!modes[param]) return 'invalid power mode'
      sim.minerCommand(miner.id, 'mode', modes[param], source)
      return null
    }
    case 'set.miner.power_percent': {
      // The firmware reads this as a string, whatever its documentation says.
      if (typeof param?.percent !== 'string') return 'percent must be a string'
      const pct = Number(param.percent)
      if (!Number.isFinite(pct) || pct < 10 || pct > 120) return 'percent out of range'
      sim.minerCommand(miner.id, 'powerPct', pct, source)
      return null
    }
    case 'set.system.led':
      sim.minerCommand(miner.id, 'led', param !== 'auto', source)
      return null
    case 'set.system.reboot':
      sim.minerCommand(miner.id, 'reboot', undefined, source)
      return null
    case 'set.miner.pools':
      if (!Array.isArray(param)) return 'invalid pools'
      sim.setMinerPools(miner.id, param.map((p) => ({ url: p.pool, user: p.worker, password: p.passwd || '' })), source)
      return null
    case 'set.system.hostname':
    case 'set.system.net_config':
    case 'set.user.change_passwd':
      return null
    default:
      return 'unsupported'
  }
}

function respond (miner, sim, request) {
  const cmd = String(request?.cmd || '')
  let { param } = request || {}

  if (cmd === 'get.device.info') {
    const info = deviceInfo(miner, sim)
    return reply(0, param === undefined ? info : { [param]: info[param] }, cmd)
  }
  if (cmd === 'get.miner.setting') return reply(0, setting(miner), cmd)
  if (cmd === 'get.miner.status') {
    const msg = {}
    for (const section of String(param || '').split('+')) {
      if (section === 'summary') msg.summary = summary(miner, sim)
      if (section === 'pools') msg.pools = pools(miner, sim)
      if (section === 'edevs') msg.edevs = edevs(miner)
    }
    return reply(0, msg, cmd)
  }

  if (cmd.startsWith('set.')) {
    if (!request.ts || !request.token || request.account !== API_ACCOUNT) return reply(-4, 'no permission', cmd)
    const key = authKey(miner, request)
    if (request.token !== key.toString('base64').substring(0, 8)) return reply(-4, 'no permission', cmd)
    if (SENSITIVE.has(cmd)) {
      try {
        param = decryptParam(request, key)
      } catch {
        return reply(-1, 'invalid encrypted param', cmd)
      }
    }
    const problem = applyWrite(miner, sim, cmd, param)
    return problem ? reply(-1, problem, cmd) : reply(0, 'ok', cmd)
  }

  return reply(-2, 'invalid command', cmd)
}

module.exports = { respond, API_PASSWORD, API_ACCOUNT, saltFor }
