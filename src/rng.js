'use strict'

// Seeded PRNG (mulberry32). Every source of randomness in the engine goes
// through one of these, so the same seed and inputs replay the same site.
class Rng {
  constructor (seed) {
    this.state = seed >>> 0
  }

  next () {
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range (min, max) {
    return min + this.next() * (max - min)
  }

  int (min, max) {
    return Math.floor(this.range(min, max + 1))
  }

  gauss () {
    const u = Math.max(this.next(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next())
  }

  pick (items) {
    return items[Math.floor(this.next() * items.length)]
  }

  // Derives an independent stream, so drawing from one (chaos, say) does not
  // shift the sequence another one sees.
  fork (salt) {
    return new Rng((Math.imul(this.state ^ salt, 0x9E3779B1) + salt) >>> 0)
  }
}

module.exports = Rng
