'use strict'

// One entry per MDK-supported miner family. Hashrate and power come from the
// figures in each vendor Worker's own mock, except Avalon, which uses MDK's
// 30 W/TH nominal. They are simulation defaults, not datasheet values.
const MODELS = {
  avalon: {
    id: 'avalon',
    brand: 'Avalon',
    name: 'A1346',
    protocol: 'cgminer API over TCP',
    worker: '@tetherto/mdk-worker-avalon',
    nominalThs: 110,
    nominalW: 3300,
    boards: 3,
    color: '#5fa8d3',
    defaultPools: 3
  },
  antminer: {
    id: 'antminer',
    brand: 'Antminer',
    name: 'S21',
    protocol: 'HTTP CGI with Digest auth',
    worker: 'https://github.com/bitmain-official/antminer-mdk-worker',
    nominalThs: 200,
    nominalW: 3420,
    boards: 3,
    color: '#f7931a',
    defaultPools: 3
  },
  whatsminer: {
    id: 'whatsminer',
    brand: 'Whatsminer',
    name: 'M50S',
    protocol: 'API v3: framed JSON over TCP, with tokens and AES',
    worker: 'https://github.com/whatsminer/whatsminer-mdk-worker',
    nominalThs: 101.4,
    nominalW: 3268,
    boards: 3,
    color: '#4fb477',
    defaultPools: 2
  },
  sealminer: {
    id: 'sealminer',
    brand: 'SealMiner',
    name: 'A2',
    protocol: 'bdminer JSON over TCP',
    worker: 'https://github.com/sealminer/sealminer-mdk-worker',
    nominalThs: 230.6,
    nominalW: 4300,
    boards: 3,
    color: '#a78bda',
    defaultPools: 2
  },
  luxos: {
    id: 'luxos',
    brand: 'LuxOS',
    name: 'S19 XP',
    protocol: 'LuxOS JSON over TCP, with sessions',
    worker: 'https://github.com/LuxorLabs/luxos-mdk-worker',
    nominalThs: 140,
    nominalW: 3010,
    boards: 3,
    color: '#e3b341',
    defaultPools: 2
  },
  proto: {
    id: 'proto',
    brand: 'Proto',
    name: 'R2',
    protocol: 'HTTP REST with JWT bearer auth',
    worker: 'https://github.com/block/proto-tether-mdk-worker',
    nominalThs: 95.5,
    nominalW: 3250,
    boards: 2,
    color: '#e5604d',
    defaultPools: 2
  }
}

// Thermal resistance scales with power, so every model settles at a similar
// chip temperature rather than larger machines simply running hotter.
const REFERENCE_W = 3300

function specFor (modelId, shared) {
  const model = MODELS[modelId]
  if (!model) throw new Error(`ERR_MODEL_INVALID: ${modelId}`)
  const scale = REFERENCE_W / model.nominalW
  return {
    ...shared,
    ...model,
    rBase: shared.rBase * scale,
    rAirflowPenalty: shared.rAirflowPenalty * scale
  }
}

// Turns weights such as { avalon: 1, antminer: 3 } into a model per miner, in
// contiguous blocks, with largest-remainder rounding so the total stays exact.
function allocateFleet (mix, count) {
  const entries = Object.entries(mix || Object.fromEntries(Object.keys(MODELS).map((id) => [id, 1])))
  if (!entries.length) throw new Error('ERR_FLEET_MIX_INVALID: the mix is empty')
  for (const [id, weight] of entries) {
    if (!MODELS[id]) throw new Error(`ERR_MODEL_INVALID: ${id}`)
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`ERR_FLEET_MIX_INVALID: ${id}`)
  }
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  if (total <= 0) throw new Error('ERR_FLEET_MIX_INVALID: the weights add up to zero')

  const shares = entries.map(([id, weight], order) => {
    const exact = count * weight / total
    return { id, order, whole: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = count - shares.reduce((sum, share) => sum + share.whole, 0)
  for (const share of [...shares].sort((a, b) => b.rest - a.rest || a.order - b.order)) {
    if (left-- <= 0) break
    share.whole++
  }
  return shares.flatMap((share) => Array(share.whole).fill(share.id))
}

function publicModels () {
  return Object.values(MODELS).map(({ id, brand, name, protocol, worker, nominalThs, nominalW, color }) => ({
    id, brand, name, protocol, worker, nominalThs, nominalW, color
  }))
}

module.exports = { MODELS, specFor, allocateFleet, publicModels }
