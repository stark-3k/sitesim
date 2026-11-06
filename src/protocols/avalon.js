'use strict'

// Avalon A1346 cgminer API, matched to what MDK's AvalonMiner driver parses.
// One request per TCP connection; the device closes the socket after replying.

const CGMINER = 'cgminer 4.11.1'
const HASH_POWER = [0, 1227, 1445, 216, 3151, 1445, 3322]
const CHIPS_PER_BOARD = 120

function status (miner, sim, code, msg, kind = 'S') {
  return `STATUS=${kind},When=${elapsed(miner, sim)},Code=${code},Msg=${msg},Description=${CGMINER}`
}

function elapsed (miner, sim) {
  return Math.max(0, Math.floor(sim.t - miner.bootedAt))
}

// Stable per-chip jitter. This only shapes telemetry, so it stays out of the
// seeded engine streams and reading a miner can never change the simulation.
function chipJitter (index, chip, spread) {
  const x = Math.sin(index * 12.9898 + chip * 78.233) * 43758.5453
  return (x - Math.floor(x) - 0.5) * spread
}

const mhs = (ths) => (ths * 1e6).toFixed(2)

function summary (miner, sim) {
  const t = elapsed(miner, sim)
  const { ema } = miner
  const accepted = miner.pools.reduce((sum, p) => sum + p.accepted, 0)
  const rejected = miner.pools.reduce((sum, p) => sum + p.rejected, 0)
  const stale = miner.pools.reduce((sum, p) => sum + p.stale, 0)
  const total = Math.max(1, accepted + rejected + stale)
  const hw = Math.floor(miner.hwErrors)
  return `${status(miner, sim, 11, 'Summary')}|SUMMARY,Elapsed=${t},MHS av=${mhs(ema.s30)},MHS 30s=${mhs(ema.s30)},MHS 1m=${mhs(ema.m1)},MHS 5m=${mhs(ema.m5)},MHS 15m=${mhs(ema.m15)},Found Blocks=0,Getworks=0,Accepted=${accepted},Rejected=${rejected},Hardware Errors=${hw},Utility=0.00,Discarded=0,Stale=${stale},Get Failures=0,Local Work=0,Remote Failures=0,Network Blocks=0,Total MH=${(ema.s30 * 1e6 * t).toFixed(0)},Work Utility=0.00,Difficulty Accepted=${accepted}.00000000,Difficulty Rejected=${rejected}.00000000,Difficulty Stale=${stale}.00000000,Best Share=0,Device Hardware%=${(100 * hw / Math.max(1, total + hw)).toFixed(4)},Device Rejected%=${(100 * rejected / total).toFixed(4)},Pool Rejected%=${(100 * rejected / total).toFixed(4)},Pool Stale%=${(100 * stale / total).toFixed(4)},Last getwork=0| `
}

// ECHU is matched exactly by the driver: 128 overheating, 513 hashboard.
function errorCode (miner) {
  if (miner.fx.boardsDown > 0) return 513
  if (miner.overheating) return 128
  return 0
}

function estats (miner, sim) {
  const t = elapsed(miner, sim)
  const { fx } = miner
  const chipAvg = miner.chipC
  const chipMax = miner.tMaxC
  const mining = miner.state === 'mining'
  const freq = mining ? (500 * miner.mode.hash * (miner.ths > 0 ? 1 : 0)).toFixed(2) : '0.00'
  const ghs = (miner.ths * 1000).toFixed(2)
  const boardGhs = [0, 1, 2].map((b) => (b < 3 - fx.boardsDown ? miner.ths * 1000 / Math.max(1, 3 - fx.boardsDown) : 0).toFixed(2))
  const boardFlags = [0, 1, 2].map((b) => (b >= 3 - fx.boardsDown ? 1 : 0))

  const chips = (board, base, spread) => mining
    ? Array.from({ length: CHIPS_PER_BOARD }, (_, chip) => (base + chipJitter(miner.index + board, chip, spread)).toFixed(0)).join('  ')
    : ''

  // PS must stay non-zero: the driver reads all zeros as a dead power link and
  // a non-zero first field as a PSU fault. A sleeping miner has neither.
  const ps = HASH_POWER.map((value, i) => (i === 0 ? (fx.psuFailed ? 1 : 0) : value)).join(' ')
  const fan = Math.round(miner.fanPct * (1 - fx.fanLoss) * 62)

  return `${status(miner, sim, 70, 'CGMiner stats')}|STATS=0,ID=AVA100,Elapsed=${t},Calls=0,Wait=0.000000,Max=0.000000,Min=0.000000,MM ID0=Ver[1346-116-23042501_6d4cd98_d3a493a] DNA[${miner.serial}] MEMFREE[2059656.2059656] NETFAIL[0 0 0 0 0 0 0 0] SYSTEMSTATU[Work: ${miner.suspended ? 'In Idle' : 'In Work'}, Hash Board: ${3 - fx.boardsDown} ] Elapsed[${t}] BOOTBY[${miner.bootBy}] LW[0] MH[0 0 0] DHW[0] HW[${Math.floor(miner.hwErrors)}] DH[0.000%] Temp[${miner.inletC.toFixed(0)}] TMax[${chipMax.toFixed(0)}] TAvg[${chipAvg.toFixed(0)}] Fan1[${fan}] Fan2[${fan}] FanR[${Math.round(miner.fanPct)}%] Vo[0] PS[${ps}] PLL0[2384 1150 2381 10885] PLL1[3931 3590 4443 4836] PLL2[2731 1555 2981 9533] GHSspd[${ghs}] DHspd[0.000%] GHSmm[${ghs}] GHSavg[${ghs}] WU[0.00] Freq[${freq}] Led[${miner.led ? '1' : '0'}] MGHS[${boardGhs.join(' ')}] MTmax[${[0, 1, 2].map(() => chipMax.toFixed(1)).join(' ')}] MTavg[${[0, 1, 2].map(() => chipAvg.toFixed(1)).join(' ')}] TA[${CHIPS_PER_BOARD * 3}] Core[A3200C] PING[0] POWS[${fx.psuFailed ? 1 : 0}] EEPROM[120 120 120] HASHS[${boardFlags.join(' ')}] POOLS[${miner.activePool < 0 && !fx.netDown ? 1 : 0}] SoftOFF[${miner.suspended ? '1' : '0'}] ECHU[${errorCode(miner)}] ECMM[${fx.controlBoard ? 1 : 0}] SF0[100 100 100 100] SF1[100 100 100 100] SF2[100 100 100 100] PVT_T0[${chips(0, chipAvg, 4)}] PVT_T1[${chips(1, chipAvg, 4)}] PVT_T2[${chips(2, chipAvg, 4)}] PVT_V0[${chips(0, 318, 8)}] PVT_V1[${chips(1, 318, 8)}] PVT_V2[${chips(2, 318, 8)}] MW[ 0 0 0] MW0[] MW1[] MW2[] CRC[0 0 0] FACOPTS0[] FACOPTS1[] FACOPTS2[] ATAOPTS0[--avalon10-freq 448:468:488:508 --avalon10-voltage-level 1272 --hash-asic 120] ATAOPTS1[--avalon10-freq 560:580:600:620 --avalon10-voltage-level 1303 --hash-asic 120] ATAOPTS2[--avalon10-freq 560:580:600:620 --avalon10-voltage-level 1303 --hash-asic 120 --power-level 0] ADJ[1] COP[0 0 0] MPO[${Math.round(miner.powerW)}] MVL[87] ATABD0[560 580 600 620] ATABD1[560 580 600 620] ATABD2[560 580 600 620] WORKMODE[${miner.workMode}],MM Count=0,Smart Speed=1,Voltage Level Offset=0,Nonce Mask=0| `
}

// Real cgminer format: `STATUS|POOL=0,...|POOL=1,...|`. The driver drops the
// first and last split entries, so stray separators would leave blank pools
// behind and all_pools_dead could never fire.
function pools (miner, sim) {
  const body = miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    const alive = pool && !pool.fx.down && !miner.fx.netDown
    const total = Math.max(1, entry.accepted + entry.rejected + entry.stale)
    return `POOL=${index},URL=${entry.url},Status=${alive ? 'Alive' : 'Dead'},Priority=${index},Quota=1,Long Poll=N,Getworks=0,Accepted=${entry.accepted},Rejected=${entry.rejected},Works=0,Discarded=0,Stale=${entry.stale},Get Failures=0,Remote Failures=0,User=${entry.user},Last Share Time=0,Diff1 Shares=0,Proxy Type=,Proxy=,Difficulty Accepted=0.00000000,Difficulty Rejected=0.00000000,Difficulty Stale=0.00000000,Last Share Difficulty=0.00000000,Work Difficulty=0.00000000,Has Stratum=true,Stratum Active=${index === miner.activePool},Stratum URL=,Stratum Difficulty=${sim.cfg.pools.shareDifficulty}.00000000,Has Vmask=false,Has GBT=false,Best Share=0,Pool Rejected%=${(100 * entry.rejected / total).toFixed(4)},Pool Stale%=${(100 * entry.stale / total).toFixed(4)},Bad Work=0,Current Block Height=0,Current Block Version=0`
  })
  return `${status(miner, sim, 7, `${miner.pools.length} Pool(s)`)}|${body.join('|')}|`
}

function version (miner, sim) {
  const mac = `b4a2eb${(miner.index + 1).toString(16).padStart(6, '0')}`
  return `${status(miner, sim, 22, 'CGMiner versions')}|VERSION,CGMiner=4.11.1,API=3.7,STM8=20.08.01,PROD=AvalonMiner 1346-116,MODEL=1346-116,HWTYPE=MM4v1_X3,SWTYPE=MM317,VERSION=23042501_6d4cd98_d3a493a,LOADER=d0d779de.00,DNA=${miner.serial},MAC=${mac},UPAPI=2| `
}

const setOk = (miner, sim) => `${status(miner, sim, 119, 'ASC 0 set OK')}| `
const setFailed = (miner, sim, why = '') => `${status(miner, sim, 119, `ASC 0 set failed: ${why}`, 'E')}| `
const setInfo = (miner, sim, info) => `${status(miner, sim, 118, `ASC 0 set info: ${info}`, 'I')}| `

function ascset (miner, sim, req) {
  const parts = req.split(',')
  const action = parts[1]
  const args = parts.slice(2)
  switch (action) {
    case 'softoff':
      sim.minerCommand(miner.id, 'sleep', undefined, 'cgminer')
      return setOk(miner, sim)
    case 'softon':
      sim.minerCommand(miner.id, 'wake', undefined, 'cgminer')
      return setOk(miner, sim)
    case 'reboot':
      sim.minerCommand(miner.id, 'reboot', undefined, 'cgminer')
      return null // the device drops the connection as it restarts
    case 'workmode':
      if (args[0] === '255') return setInfo(miner, sim, `WORKMODE[${miner.workMode}] success`)
      if (args.length === 1 && ['0', '1', '2'].includes(args[0])) {
        sim.minerCommand(miner.id, 'mode', args[0], 'cgminer')
        return setInfo(miner, sim, `WORKMODE[${miner.workMode}] success`)
      }
      return setFailed(miner, sim)
    case 'fan-spd': {
      const speed = Number(args[0])
      if (args.length === 1 && Number.isInteger(speed) && speed >= 0 && speed <= 100) {
        sim.minerCommand(miner.id, 'fan', speed, 'cgminer')
        return setOk(miner, sim)
      }
      return setFailed(miner, sim)
    }
    case 'led':
      if (args[0] === '1-255') return setInfo(miner, sim, `LED[${miner.led ? '1' : '0'}]`)
      if (args[0] === '0-0' || args[0] === '0-1') {
        sim.minerCommand(miner.id, 'led', args[0] === '0-1', 'cgminer')
        return setInfo(miner, sim, `LED[${miner.led}]`)
      }
      return setFailed(miner, sim)
    case 'hashpower':
      return setInfo(miner, sim, `PS[${HASH_POWER.join(' ')}]`)
    case 'bootby':
      return setInfo(miner, sim, `BOOTBY[${miner.bootBy}]`)
    case 'setpool': {
      const [user, pass, slot, url, worker, workerPass] = args
      if (args.length !== 6 || user !== miner.username || pass !== miner.password) {
        return `${status(miner, sim, 120, 'ASC 0 set failed: Auth Failed! password invalid!', 'E')}| `
      }
      const index = Number(slot)
      if (!Number.isInteger(index) || index < 0 || index >= miner.pools.length) return setFailed(miner, sim)
      Object.assign(miner.pools[index], { url, user: worker, password: workerPass })
      sim.log('info', 'cgminer', `pool ${index} set to ${url} on ${miner.id}`)
      return setOk(miner, sim)
    }
    case 'password':
      if (args[0] === 'default') {
        miner.password = 'root'
        return setOk(miner, sim)
      }
      if (args.length === 2 && args[0] === miner.password && args[1]) {
        miner.password = args[1]
        return setOk(miner, sim)
      }
      return setFailed(miner, sim, 'Auth Failed! password invalid!')
    case 'restore':
    case 'ip':
    case 'dns':
      return setOk(miner, sim)
    default:
      return setFailed(miner, sim)
  }
}

// Returns the reply, or null when the device closes without answering.
function respond (miner, sim, rawRequest) {
  const req = rawRequest.replace(/\0/g, '').trim()
  if (req.startsWith('ascset')) return ascset(miner, sim, req)
  switch (req) {
    case 'summary': return summary(miner, sim)
    case 'estats': return estats(miner, sim)
    case 'pools': return pools(miner, sim)
    case 'version': return version(miner, sim)
    default: return null
  }
}

module.exports = { respond }
