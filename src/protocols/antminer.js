'use strict'

// Antminer stock-firmware CGI API, as MDK's Antminer Worker uses it, behind
// RFC 2617 HTTP Digest auth. Log download and firmware upload aren't simulated.

const crypto = require('crypto')

const REALM = 'antMiner Configuration'
const MAX_NONCES = 256
const FAN_COUNT = 4
const CHIPS_PER_BOARD = 70

// Values reported by stats.cgi and written through set_miner_conf.cgi.
const WORK_MODE = { normal: 0, sleep: 1, high: 2, eco: 3 }

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex')
const round = (value, digits = 2) => Number(value.toFixed(digits))

function parseAuthorization (header) {
  if (typeof header !== 'string' || !/^Digest\s/i.test(header)) return null
  const params = {}
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g
  let match
  while ((match = re.exec(header))) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3]
  }
  return params
}

// Tracks issued nonces and the nc values used with each, which rejects replays.
class DigestAuth {
  constructor () {
    this.nonces = new Map()
  }

  challenge () {
    const nonce = crypto.randomBytes(8).toString('hex')
    this.nonces.set(nonce, new Set())
    if (this.nonces.size > MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value)
    return `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${crypto.randomBytes(4).toString('hex')}", algorithm=MD5, stale=FALSE`
  }

  verify (req, username, password) {
    const auth = parseAuthorization(req.headers.authorization)
    if (!auth || auth.username !== username || !auth.nonce || !auth.response || !auth.uri) return false
    const seen = this.nonces.get(auth.nonce)
    if (!seen) return false
    const nc = parseInt(auth.nc || '0', 16)
    if (!Number.isFinite(nc) || nc === 0 || seen.has(nc)) return false
    if ((auth.algorithm || 'MD5').toUpperCase() !== 'MD5') return false
    const ha1 = md5(`${username}:${auth.realm}:${password}`)
    const ha2 = md5(`${req.method}:${auth.uri}`)
    const expected = auth.qop
      ? md5(`${ha1}:${auth.nonce}:${auth.nc}:${auth.cnonce}:${auth.qop}:${ha2}`)
      : md5(`${ha1}:${auth.nonce}:${ha2}`)
    if (auth.response !== expected) return false
    seen.add(nc)
    return true
  }
}

function header (msg, miner) {
  return {
    STATUS: { STATUS: 'S', when: Math.floor(Date.now() / 1000), Msg: msg, api_version: '1.0.0' },
    INFO: { miner_version: 'cminer 1.0.0', CompileTime: 'FD-1.5(sim)', type: `Antminer ${miner.spec.name}`, miner_type_enum: 1 }
  }
}

function elapsed (miner, sim) {
  return Math.max(0, Math.floor(sim.t - miner.bootedAt))
}

function warnings (miner) {
  const { fx } = miner
  const out = []
  const add = (code, cause, suggestion) => out.push({ code, cause, suggestion, timestamp: new Date().toISOString() })
  if (fx.fanLoss > 0) add('W_FAN', 'Fan speed is below the expected range', 'Check the fans')
  if (fx.boardsDown > 0) add('W_BOARD', 'A hashboard is not hashing', 'Check the hashboards')
  if (fx.psuFailed) add('W_PSU', 'The power supply reported a fault', 'Check the power supply')
  if (miner.overheating) add('W_TEMP', 'Chip temperature is above the limit', 'Check cooling and airflow')
  if (fx.controlBoard) add('W_CTRL', 'The control board reported an exception', 'Check the control board')
  return out
}

function statusSections (miner) {
  const { fx } = miner
  const section = (type, bad, msg) => ({ type, status: bad ? 'e' : 's', code: bad ? 1 : 0, msg: bad ? msg : '' })
  return [
    section('rate', fx.boardsDown > 0, 'hashrate is below target'),
    section('network', miner.activePool < 0 && miner.state === 'mining', 'no pool is reachable'),
    section('fans', fx.fanLoss > 0, 'fan fault'),
    section('temp', miner.overheating, 'over temperature')
  ]
}

function rates (miner, sim) {
  const ghs = (ths) => round(ths * 1000)
  return {
    elapsed: elapsed(miner, sim),
    rate_5s: ghs(miner.ths),
    rate_30m: ghs(miner.ema.m15),
    rate_avg: ghs(miner.ema.m5),
    rate_ideal: ghs(miner.spec.nominalThs * miner.mode.hash * miner.powerScale ** 0.85),
    rate_unit: 'GH/s'
  }
}

function chains (miner) {
  const { spec, fx } = miner
  const alive = Math.max(0, spec.boards - fx.boardsDown)
  return Array.from({ length: spec.boards }, (_, index) => {
    const up = index < alive
    const share = up && alive ? 1 / alive : 0
    const chip = Math.round(miner.chipC)
    return {
      index,
      freq_avg: up && miner.state === 'mining' ? 575 : 0,
      rate_ideal: round(spec.nominalThs * 1000 / spec.boards),
      rate_real: round(miner.ths * 1000 * share),
      asic_num: up ? CHIPS_PER_BOARD : 0,
      asic: (up ? 'o' : 'x').repeat(CHIPS_PER_BOARD),
      temp_pic: [Math.round(miner.inletC + 10), Math.round(miner.inletC + 11)],
      temp_pcb: [chip - 20, chip - 17],
      temp_chip: [chip - 6, chip, Math.round(miner.tMaxC)],
      temp_in: [],
      temp_out: [],
      hw: Math.floor(miner.hwErrors / spec.boards),
      eeprom_loaded: true,
      sn: `${miner.serial}B${index}`,
      hwp: 0,
      eeprom_level: 7000,
      eeprom_vol: 1234,
      eeprom_freq: 575,
      eeprom_bin: 2,
      eeprom_ft: '20260101',
      tpl: []
    }
  })
}

function poolRows (miner, sim) {
  return miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    return {
      index,
      url: entry.url,
      user: entry.user,
      status: entry.url && pool && !pool.fx.down && !miner.fx.netDown ? 'Alive' : 'Dead',
      priority: index,
      getworks: 0,
      accepted: entry.accepted,
      rejected: entry.rejected,
      discarded: 0,
      stale: entry.stale,
      diff: String(sim.cfg.pools.shareDifficulty),
      diffa: entry.accepted * sim.cfg.pools.shareDifficulty,
      diffr: entry.rejected * sim.cfg.pools.shareDifficulty,
      diffs: entry.stale * sim.cfg.pools.shareDifficulty,
      lsdiff: String(sim.cfg.pools.shareDifficulty),
      lstime: '1970-01-01 00:00:00'
    }
  })
}

function workMode (miner) {
  if (miner.suspended) return WORK_MODE.sleep
  return WORK_MODE[miner.mode.name] ?? WORK_MODE.normal
}

function networkInfo (miner, sim) {
  const mac = `aa:bb:cc:dd:${(miner.index >> 8).toString(16).padStart(2, '0')}:${(miner.index & 255).toString(16).padStart(2, '0')}`
  return {
    nettype: 'DHCP',
    netdevice: 'eth0',
    macaddr: mac,
    ipaddress: sim.cfg.host,
    netmask: '255.255.255.0',
    conf_nettype: 'DHCP',
    conf_hostname: miner.id,
    conf_ipaddress: sim.cfg.host,
    conf_netmask: '255.255.255.0',
    conf_gateway: '127.0.0.1',
    conf_dnsservers: '127.0.0.1'
  }
}

function minerConf (miner) {
  return {
    pools: miner.pools.map((p) => ({ url: p.url, user: p.user, pass: p.password })),
    'bitmain-user-ip-cat': false,
    'bitmain-fan-ctrl': miner.manualFanPct !== null,
    'bitmain-fan-pwm': miner.manualFanPct ?? 100,
    'bitmain-freq': 575,
    'bitmain-voltage': 14,
    'bitmain-work-mode': workMode(miner),
    'bitmain-freq-level': Math.round(miner.powerScale * 100),
    'bitmain-chip-temp-threshold': 95,
    'bitmain-drop-freq-scale': 100,
    'bitmain-power-off-delay': 0
  }
}

function applyMinerConf (miner, sim, parsed) {
  const source = 'antminer'
  if (parsed.pools !== undefined) {
    if (!Array.isArray(parsed.pools) || parsed.pools.length !== 3) return 'invalid pools'
  }
  const mode = parsed['bitmain-work-mode']
  if (mode !== undefined && !Object.values(WORK_MODE).includes(mode)) return 'invalid work mode'

  if (parsed.pools !== undefined) {
    const list = parsed.pools.map((p) => ({ url: p.url, user: p.user, password: p.pass }))
    const same = list.every((p, i) => p.url === miner.pools[i]?.url && p.user === miner.pools[i]?.user)
    // The Worker sends the whole conf with every write. Unchanged pools must
    // keep their share counters.
    if (!same) sim.setMinerPools(miner.id, list, source)
  }
  if (mode !== undefined && mode !== workMode(miner)) {
    if (mode === WORK_MODE.sleep) {
      sim.minerCommand(miner.id, 'sleep', undefined, source)
    } else {
      const name = Object.keys(WORK_MODE).find((key) => WORK_MODE[key] === mode)
      if (miner.suspended) sim.minerCommand(miner.id, 'wake', undefined, source)
      sim.minerCommand(miner.id, 'mode', name, source)
    }
  }
  const level = parsed['bitmain-freq-level']
  if (level !== undefined && level !== Math.round(miner.powerScale * 100)) {
    sim.minerCommand(miner.id, 'powerPct', level, source)
  }
  return null
}

const auths = new Map()

function handle (miner, sim, req, body) {
  const auth = auths.get(miner.port) || new DigestAuth()
  auths.set(miner.port, auth)
  if (!auth.verify(req, miner.username, miner.password)) {
    return { status: 401, headers: { 'WWW-Authenticate': auth.challenge() }, body: '' }
  }

  const json = (payload) => ({ status: 200, body: JSON.stringify(payload) })
  const url = req.url.split('?')[0]
  const route = `${req.method} ${url}`
  const parse = () => {
    try {
      return JSON.parse(body.toString() || '{}')
    } catch {
      return null
    }
  }

  switch (route) {
    case 'GET /cgi-bin/summary.cgi':
      return json({
        ...header('summary', miner),
        SUMMARY: [{ ...rates(miner, sim), hw_all: Math.floor(miner.hwErrors), bestshare: 0, safe_mode: false, status: statusSections(miner) }]
      })
    case 'GET /cgi-bin/stats.cgi':
      return json({
        ...header('stats', miner),
        STATS: [{
          ...rates(miner, sim),
          rate_sale: Math.round(miner.spec.nominalThs * 1000),
          chain_num: miner.spec.boards,
          fan_num: FAN_COUNT,
          fan: Array(FAN_COUNT).fill(Math.round(miner.fanPct * (1 - miner.fx.fanLoss) * 62)),
          hwp_total: 0,
          'miner-mode': workMode(miner),
          'freq-level-mode': true,
          'freq-level-min': 50,
          'freq-level': Math.round(miner.powerScale * 100),
          watt: Math.round(miner.powerW),
          jt: miner.ths > 1 ? round(miner.powerW / miner.ths) : 0,
          ambient_temp: round(miner.inletC, 1),
          chain: chains(miner)
        }]
      })
    case 'GET /cgi-bin/pools.cgi':
      return json({ ...header('pools', miner), POOLS: poolRows(miner, sim) })
    case 'GET /cgi-bin/warning.cgi':
      return json({ ...header('warning', miner), WARNING: warnings(miner) })
    case 'GET /cgi-bin/get_system_info.cgi': {
      const net = networkInfo(miner, sim)
      return json({
        minertype: `Antminer ${miner.spec.name}`,
        nettype: net.nettype,
        netdevice: net.netdevice,
        macaddr: net.macaddr,
        hostname: miner.id,
        ipaddress: net.ipaddress,
        netmask: net.netmask,
        gateway: net.conf_gateway,
        dnsservers: net.conf_dnsservers,
        system_mode: 'GNU/Linux',
        system_kernel_version: '5.15.0',
        system_filesystem_version: 'FD-1.5(sim)',
        firmware_type: 'Release',
        serinum: miner.serial
      })
    }
    case 'GET /cgi-bin/miner_type.cgi':
      return json({ miner_type: miner.spec.name, subtype: 'AMLCtrl_A3HB70XXX', product_type: '', fw_version: 'sim' })
    case 'GET /cgi-bin/get_miner_conf.cgi':
      return json(minerConf(miner))
    case 'GET /cgi-bin/get_adjustment_params.cgi':
      return json({
        hashrate_percent_support: true,
        hashrate_percent_min: 50,
        hashrate_percent_max: 110,
        chip_temp_threshold_support: true,
        chip_temp_threshold_slider_min: 80,
        chip_temp_threshold_slider_max: 98,
        drop_freq_scale_support: true,
        drop_freq_scale_slider_min: 80,
        drop_freq_scale_slider_max: 100,
        power_off_delay_support: true,
        hem_mode: true,
        lem_mode: true
      })
    case 'GET /cgi-bin/get_blink_status.cgi':
      return json({ blink: miner.led })
    case 'GET /cgi-bin/dlog.cgi':
      return json({ dlog: true, log_list: [] })
    case 'GET /cgi-bin/get_network_info.cgi':
      return json(networkInfo(miner, sim))
    case 'GET /cgi-bin/reboot.cgi':
      sim.minerCommand(miner.id, 'reboot', undefined, 'antminer')
      return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' }
    case 'POST /cgi-bin/blink.cgi': {
      const parsed = parse()
      if (typeof parsed?.blink !== 'boolean') return json({ code: 'B001', msg: 'invalid blink' })
      sim.minerCommand(miner.id, 'led', parsed.blink, 'antminer')
      return json({ code: parsed.blink ? 'B000' : 'B100', msg: '' })
    }
    case 'POST /cgi-bin/set_miner_conf.cgi': {
      const parsed = parse()
      if (!parsed) return json({ stats: 'error', code: 'M001', msg: 'Illegal request!' })
      const problem = applyMinerConf(miner, sim, parsed)
      if (problem) return json({ stats: 'error', code: 'M001', msg: problem })
      return json({ stats: 'success', code: 'M000', msg: 'OK!' })
    }
    case 'POST /cgi-bin/set_network_conf.cgi':
      return json({ stats: 'success', code: 'N000', msg: 'OK!' })
    default:
      return { status: 404, body: JSON.stringify({ error: 'ERR_NOT_FOUND' }) }
  }
}

module.exports = { handle }
