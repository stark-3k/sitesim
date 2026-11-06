'use strict'

const net = require('net')
const http = require('http')
const avalon = require('./avalon')
const luxos = require('./luxos')
const sealminer = require('./sealminer')
const whatsminer = require('./whatsminer')
const antminer = require('./antminer')
const proto = require('./proto')

const MAX_REQUEST_BYTES = 1024 * 1024
const FRAME_HEADER = 4

function encodeFrame (payload) {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(FRAME_HEADER)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

// Each protocol's framing: how a request is recognised on the socket, and how
// the reply is written. All of them answer once per connection, then close.
const TCP = {
  // One chunk is one request.
  avalon: {
    open (chunks) {
      return Buffer.concat(chunks).toString()
    },
    respond: (miner, sim, text) => avalon.respond(miner, sim, text),
    encode: (reply) => reply
  },
  // Complete once the bytes parse as JSON.
  luxos: {
    open (chunks) {
      try {
        return JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        return undefined
      }
    },
    respond: (miner, sim, request) => luxos.respond(miner, sim, request),
    encode: (reply) => `${JSON.stringify(reply)}\0`
  },
  // The client half-closes to end its request.
  sealminer: {
    halfClose: true,
    parse (buffer) {
      try {
        return JSON.parse(buffer.toString().replace(/\0+$/, '').trim())
      } catch {
        return null
      }
    },
    respond: (miner, sim, request) => sealminer.respond(miner, sim, request),
    encode: (reply) => JSON.stringify(reply)
  },
  // Length-prefixed frames.
  whatsminer: {
    open (chunks) {
      const buffer = Buffer.concat(chunks)
      if (buffer.length < FRAME_HEADER) return undefined
      const length = buffer.readUInt32LE(0)
      if (length === 0 || length > MAX_REQUEST_BYTES) throw new Error('ERR_FRAME_LENGTH_INVALID')
      if (buffer.length < FRAME_HEADER + length) return undefined
      try {
        return JSON.parse(buffer.subarray(FRAME_HEADER, FRAME_HEADER + length).toString())
      } catch {
        return null
      }
    },
    respond: (miner, sim, request) => whatsminer.respond(miner, sim, request),
    encode: (reply) => encodeFrame(JSON.stringify(reply))
  }
}

const HTTP = { antminer, proto }

// One listener per miner, as on a real network where each has its own address.
// Listeners stay bound throughout. An unreachable miner resets each connection,
// which is how a client sees a device that has gone away.
class MinerServers {
  constructor (getSim, stats) {
    this.getSim = getSim
    this.stats = stats
    this.servers = []
    this.sockets = new Set()
  }

  async start () {
    const sim = this.getSim()
    // Wait for every listener to settle, so a failed start can be stopped cleanly.
    const results = await Promise.allSettled(sim.miners.map((miner) => this._listen(miner, sim.cfg.host)))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  _listen (miner, host) {
    const { index, port, model } = miner
    const server = HTTP[model]
      ? this._createHttp(index, model)
      : net.createServer({ allowHalfOpen: Boolean(TCP[model].halfClose) }, (socket) => this._onTcp(socket, index, model))
    this.servers.push(server)
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
  }

  _track (socket) {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
  }

  _onTcp (socket, index, model) {
    this._track(socket)
    const miner = this.getSim().miners[index]
    if (!miner || !miner.reachable) {
      socket.resetAndDestroy()
      return
    }
    const framing = TCP[model]
    const chunks = []
    let size = 0
    let done = false

    const finish = (request) => {
      done = true
      this._answer(socket, index, framing, request)
    }

    socket.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        socket.destroy()
        return
      }
      chunks.push(chunk)
      if (framing.halfClose) return
      try {
        const request = framing.open(chunks)
        if (request !== undefined) finish(request)
      } catch {
        socket.destroy()
      }
    })
    if (framing.halfClose) {
      socket.once('end', () => {
        if (!done) finish(framing.parse(Buffer.concat(chunks)))
      })
    }
  }

  _answer (socket, index, framing, request) {
    const sim = this.getSim()
    const miner = sim.miners[index]
    this.stats.record(miner?.model || 'unknown', miner?.id)
    if (!miner || !miner.reachable) {
      socket.resetAndDestroy()
      return
    }
    let reply = null
    try {
      reply = framing.respond(miner, sim, request)
    } catch (err) {
      sim.log('error', miner.model, `${miner.id}: ${err.message}`)
    }
    const send = () => {
      if (socket.destroyed) return
      if (reply === null) socket.end()
      else socket.end(framing.encode(reply))
    }
    if (miner.fx.netDelayMs > 0) setTimeout(send, miner.fx.netDelayMs)
    else send()
  }

  _createHttp (index, model) {
    const server = http.createServer((req, res) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_REQUEST_BYTES) {
          res.writeHead(413)
          res.end()
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > MAX_REQUEST_BYTES) return
        this._answerHttp(req, res, index, model, Buffer.concat(chunks))
      })
    })
    server.on('connection', (socket) => {
      this._track(socket)
      const miner = this.getSim().miners[index]
      if (!miner || !miner.reachable) socket.resetAndDestroy()
    })
    return server
  }

  _answerHttp (req, res, index, model, body) {
    const sim = this.getSim()
    const miner = sim.miners[index]
    this.stats.record(model, miner?.id)
    // A kept-alive connection can outlive the miner going offline.
    if (!miner || !miner.reachable) {
      req.socket.resetAndDestroy()
      return
    }
    let result
    try {
      result = HTTP[model].handle(miner, sim, req, body)
    } catch (err) {
      sim.log('error', model, `${miner.id}: ${err.message}`)
      result = { status: 500, body: JSON.stringify({ error: 'internal error' }) }
    }
    const send = () => {
      if (res.destroyed) return
      // Node 24's fetch can crash when reusing a socket on macOS, so don't offer it one.
      res.writeHead(result.status, { 'content-type': 'application/json', connection: 'close', ...result.headers })
      res.end(result.body)
    }
    if (miner.fx.netDelayMs > 0) setTimeout(send, miner.fx.netDelayMs)
    else send()
  }

  async stop () {
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(this.servers.map((server) => new Promise((resolve) => server.close(resolve))))
    this.servers = []
  }
}

module.exports = { MinerServers }
