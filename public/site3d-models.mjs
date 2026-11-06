// What each miner family looks like, in metres. These are stylised from memory of
// each product's general shape: boxy chassis, fans on both ends, and PSU on top.
// They aren't accurate replicas, and the Proto R2's shape is a plain guess.

// The rack space a miner sits in. Every model has to fit it.
export const SLOT = { w: 0.22, h: 0.38, d: 0.42 }

export const LED_H = 0.012

export const MINER_MODELS = {
  avalon: { w: 0.195, h: 0.29, d: 0.33, fans: 2, psuH: 0, metal: '#b9bec4', psuMetal: '#8d9298' },
  antminer: { w: 0.195, h: 0.29, d: 0.4, fans: 2, psuH: 0.06, metal: '#c9ccd0', psuMetal: '#a4a8ad' },
  whatsminer: { w: 0.15, h: 0.24, d: 0.39, fans: 1, psuH: 0.06, metal: '#7d8288', psuMetal: '#c2c5c9' },
  sealminer: { w: 0.195, h: 0.29, d: 0.4, fans: 2, psuH: 0.06, metal: '#595e65', psuMetal: '#7b8087' },
  // LuxOS is firmware, so this is the Antminer S19 XP it runs on.
  luxos: { w: 0.195, h: 0.29, d: 0.4, fans: 2, psuH: 0.06, metal: '#c9ccd0', psuMetal: '#a4a8ad' },
  proto: { w: 0.2, h: 0.26, d: 0.36, fans: 2, psuH: 0, metal: '#e2e4e6', psuMetal: '#c9ccd0' }
}

export const FALLBACK_MODEL = MINER_MODELS.antminer

export function modelFor (id) {
  return MINER_MODELS[id] || FALLBACK_MODEL
}

// Where a miner's parts sit, relative to the centre of its rack slot.
export function partsFor (model) {
  const floor = -SLOT.h / 2
  const body = { y: floor + model.h / 2, w: model.w, h: model.h, d: model.d }
  const led = { y: floor + model.h + LED_H / 2, w: model.w, h: LED_H, d: model.d }
  const psu = model.psuH > 0
    ? { y: floor + model.h + LED_H + model.psuH / 2, w: model.w * 0.72, h: model.psuH, d: model.d * 0.62 }
    : null

  // Fans stack up the end of the chassis, on both ends, as air passes straight through.
  const size = Math.min(model.w, model.h / model.fans) * 0.94
  const fans = []
  for (let i = 0; i < model.fans; i++) {
    const y = floor + (model.h * (i + 0.5)) / model.fans
    for (const side of [1, -1]) fans.push({ y, z: side * (model.d / 2 + 0.002), side })
  }
  return { body, led, psu, fans, fanSize: size }
}
