'use strict'

const HOUR = 3600

// Weather and markets: the outside inputs the site reacts to but cannot change.
class Environment {
  constructor (cfg, rng, startHour) {
    this.cfg = cfg
    this.rng = rng
    this.startHour = startHour
    this.ambientNoise = 0
    this.priceNoise = 0
    this.btcNoise = 0
    this.ambientC = cfg.ambientMeanC
    this.priceUsdKwh = cfg.priceShoulder
    this.btcUsd = cfg.btcUsd
    this.btcPerThDay = cfg.btcPerThDay
  }

  hourOfDay (t) {
    return (this.startHour + t / HOUR) % 24
  }

  basePrice (hour) {
    const { peakHours, offPeakHours, pricePeak, priceOffPeak, priceShoulder } = this.cfg
    if (hour >= peakHours[0] && hour < peakHours[1]) return pricePeak
    if (hour >= offPeakHours[0] && hour < offPeakHours[1]) return priceOffPeak
    return priceShoulder
  }

  update (t, dt, fx) {
    const { rng, cfg } = this
    const hour = this.hourOfDay(t)

    // Mean-reverting noise, so the values wander without drifting away.
    this.ambientNoise += (-this.ambientNoise / 1800 + rng.gauss() * 0.012) * dt
    this.priceNoise += (-this.priceNoise / 3600 + rng.gauss() * 0.00002) * dt
    this.btcNoise += (-this.btcNoise / 86400 + rng.gauss() * 0.00001) * dt

    const swing = Math.cos(2 * Math.PI * (hour - cfg.ambientPeakHour) / 24)
    this.ambientC = cfg.ambientMeanC + cfg.ambientSwingC * swing + this.ambientNoise + fx.ambientDeltaC
    this.priceUsdKwh = Math.max(0.005, (this.basePrice(hour) + this.priceNoise) * fx.priceMult)
    this.btcUsd = cfg.btcUsd * (1 + this.btcNoise)
    this.btcPerThDay = cfg.btcPerThDay * fx.revenueMult
  }

  get hashpriceUsdThDay () {
    return this.btcPerThDay * this.btcUsd
  }
}

module.exports = Environment
