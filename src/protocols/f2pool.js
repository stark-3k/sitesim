'use strict'

const http = require('http')

const MAX_BODY = 64 * 1024
const MAX_SAMPLES = 8640
const SAMPLE_WALL_MS = 30 * 1000
const CURRENCY = 'bitcoin'

const toHs = (ths) => Math.round(ths * 1e12)

// F2Pool API v2 as MDK's pool Worker calls it. The Worker asks for history by
// real time, so samples carry wall-clock stamps whatever the simulation speed.
class F2PoolServer {
  constructor (getSim, stats) {
    this.getSim = getSim
    this.stats = stats
    this.sockets = new Set()
  }

  get pool () {
    const sim = this.getSim()
    return sim.pools.get(sim.cfg.pools.primary.id)
  }

  start () {
    const sim = this.getSim()
    this.server = http.createServer((req, res) => this._onRequest(req, res))
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.timer = setInterval(() => this.sample(), SAMPLE_WALL_MS)
    this.timer.unref()
    this.sample()
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(sim.cfg.ports.pool, sim.cfg.host, resolve)
    })
  }

  sample (now = Date.now()) {
    const { pool } = this
    pool.samples.push({
      timestamp: Math.floor(now / 1000),
      hash_rate: toHs(pool.creditedThs),
      stale_hash_rate: toHs(pool.staleThs || 0),
      delay_hash_rate: 0
    })
    if (pool.samples.length > MAX_SAMPLES) pool.samples.shift()
  }

  _onRequest (req, res) {
    const send = (status, payload) => {
      // Node 24's fetch can crash when reusing a socket on macOS, so don't offer it one.
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify(payload))
    }

    this.stats.record('f2pool', req.url)
    const { pool } = this
    if (pool.fx.apiDown) return send(503, { code: 503, msg: 'service unavailable' })
    if (req.headers['f2p-api-secret'] !== pool.apiSecret) {
      return send(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid or missing API secret' })
    }
    if (req.method !== 'POST') return send(405, { code: 405, msg: 'method not allowed' })

    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        send(413, { code: 413, msg: 'body too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > MAX_BODY) return
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      } catch {
        return send(400, { code: 5001, msg: 'params error: invalid JSON' })
      }
      const { status, payload } = this.route(req.url, body)
      send(status, payload)
    })
    return undefined
  }

  route (url, body) {
    const { pool } = this
    if (body.currency !== CURRENCY) return ok({ code: 5001, msg: `params error: currency="${body.currency ?? ''}"` })
    if (body.mining_user_name !== pool.username) {
      return ok({ code: 5010, msg: `permission denied: permission denied name="${body.mining_user_name}"` })
    }

    switch (url) {
      case '/v2/assets/balance':
        return ok({
          balance_info: {
            balance: pool.btcTotal - pool.btcPaid,
            paid: pool.btcPaid,
            total_income: pool.btcTotal,
            yesterday_income: pool.btcYesterday,
            estimated_today_income: pool.btcToday
          }
        })
      case '/v2/hash_rate/info':
        return ok({ info: { name: body.mining_user_name, ...this._rates() }, currency: CURRENCY })
      case '/v2/hash_rate/history':
        if (!body.start_time || !body.end_time) {
          return ok({ code: 5001, msg: 'params error: start_time and end_time are required' })
        }
        return ok({ hash_rate_list: this._history(body.start_time, body.end_time) })
      case '/v2/hash_rate/worker/list':
        return ok({ workers: this._workers() })
      case '/v2/assets/transactions/list':
        return ok({
          transactions: pool.transactions.filter((tx) => tx.created_at >= body.start_time && tx.created_at <= body.end_time)
        })
      default:
        return { status: 404, payload: { code: 404, msg: 'not found' } }
    }
  }

  _rates () {
    const { pool } = this
    return {
      hash_rate: toHs(pool.creditedThs),
      h1_hash_rate: toHs(pool.ema1h),
      h24_hash_rate: toHs(pool.ema24h),
      h1_stale_hash_rate: toHs(pool.staleEma1h),
      h24_stale_hash_rate: toHs(pool.staleEma24h),
      h24_delay_hash_rate: 0,
      local_hash_rate: toHs(pool.creditedThs),
      h24_local_hash_rate: toHs(pool.ema24h)
    }
  }

  // The Worker takes the last entry as current hashrate, so this always ends
  // with a fresh reading instead of one up to 30 seconds old.
  _history (start, end) {
    const { pool } = this
    const list = pool.samples.filter((s) => s.timestamp >= start && s.timestamp <= end)
    list.push({
      timestamp: Math.min(end, Math.floor(Date.now() / 1000)),
      hash_rate: toHs(pool.creditedThs),
      stale_hash_rate: toHs(pool.staleThs || 0),
      delay_hash_rate: 0
    })
    return list
  }

  _workers () {
    const sim = this.getSim()
    const { pool } = this
    return sim.miners
      .filter((miner) => miner.pools.some((entry) => sim.poolForUrl(entry.url) === pool))
      .map((miner) => {
        const active = miner.activePool >= 0 && sim.poolForUrl(miner.pools[miner.activePool].url) === pool
        const rate = active ? toHs(miner.creditedThs) : 0
        return {
          // The API reports status 0 for an online worker.
          status: active && rate > 0 ? 0 : 1,
          host: `${sim.cfg.host}:${miner.port}`,
          last_share_at: active ? Math.floor(Date.now() / 1000) : 0,
          hash_rate_info: {
            name: miner.id,
            hash_rate: rate,
            h1_hash_rate: rate,
            h24_hash_rate: rate,
            h1_stale_hash_rate: 0,
            h24_stale_hash_rate: 0,
            h24_delay_hash_rate: 0,
            local_hash_rate: rate,
            h24_local_hash_rate: rate
          }
        }
      })
  }

  async stop () {
    clearInterval(this.timer)
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise((resolve) => this.server.close(resolve))
  }
}

function ok (payload) {
  return { status: 200, payload }
}

module.exports = F2PoolServer
