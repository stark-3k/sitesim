'use strict'

const http = require('http')

// Talks to the simulator's API. This uses one connection per request instead of
// fetch: on Node 24 and macOS, fetch can reuse a keep-alive socket the server has
// closed and crash the process with an uncatchable setTypeOfService EINVAL.
function simApi (base, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base)
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(url, {
      method: payload ? 'POST' : 'GET',
      agent: false,
      timeout: 10000,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          if (res.statusCode >= 400) reject(new Error(data.error || `${route} answered ${res.statusCode}`))
          else resolve(data)
        } catch {
          reject(new Error(`${route} answered with something that isn't JSON`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${route} timed out`)))
    req.on('error', reject)
    req.end(payload)
  })
}

module.exports = { simApi }
