// The first-visit tour: its steps, and where its card goes. No browser code here, so
// it runs under Node's test runner.

const GAP = 12
const EDGE = 12

export const STARTER_SCENARIO = 'blackout'

// `target` is what gets highlighted, and a step without one sits in the middle.
export const STEPS = [
  {
    title: 'Welcome to SiteSim',
    body: 'This is a virtual Bitcoin mining site that runs on your computer. Its miners, power and money are all simulated, so you can break anything here without touching a real machine. The tour takes about a minute.'
  },
  {
    target: '.kpis',
    title: 'The site at a glance',
    body: 'Hashrate, power against the site’s limit, temperature, and profit. They affect each other: lose cooling and chips heat up, then slow down, then earnings fall.'
  },
  {
    target: '#fleet',
    title: 'Every square is a miner',
    body: 'Green means mining, and the legend below explains the other colours. Click a square to inspect that miner, or to sleep or reboot it.'
  },
  {
    target: '.transport',
    title: 'Speed up time',
    body: 'A blackout recovery takes minutes and a price swing takes hours, so you can run time up to an hour per second, or pause it.'
  },
  {
    target: '#scenario-list',
    title: 'Run a scenario',
    body: 'A scenario is a scripted bad day, like a blackout or a heatwave, that’s scored at the end. It’s the quickest way to see what the site can do.'
  },
  {
    target: '#fault-form',
    title: 'Or break something yourself',
    body: 'Fail a fan, trip a power unit, or spike the power price. Pick a fault and a target, and watch what happens to the site.'
  },
  {
    target: '#view-select',
    title: 'See it in 3D',
    body: 'Switch to the 3D site to look around the containers, or to walk the aisles in first person with the arrow keys.'
  },
  {
    target: '#curtail-panel',
    title: 'Connect real software',
    body: 'The site speaks each miner’s real protocol, so MDK connects to it as if it were hardware. With Node 24, run these in a terminal to add MDK and the curtailment app, which then reports here:',
    code: 'node mdk/setup.js\nnode mdk/start.js --app curtailment',
    bodyWhenRunning: 'The site speaks each miner’s real protocol, so MDK connects to it as if it were hardware. MDK and the curtailment app are running now: this card shows what the app is doing and why, and you can set a power cap here.'
  },
  {
    title: 'Try it now',
    body: 'Start a blackout and watch the site go dark, then recover. It runs for two simulated hours, which takes about two minutes. You can replay this tour from the Tour button at the top.',
    bodyWhenBusy: 'A scenario is already running, so have a look at that. You can replay this tour from the Tour button at the top.',
    action: { label: 'Start a blackout', scenario: STARTER_SCENARIO }
  }
]

const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)))

// Places the card beside its target: below if it fits, then above, then to either
// side. On a small screen where nothing fits, it sits at the bottom over the target.
export function placeCard (target, card, viewport) {
  if (!target) {
    return { left: (viewport.width - card.width) / 2, top: (viewport.height - card.height) / 2 }
  }
  const centredX = clamp(target.left + (target.width - card.width) / 2, EDGE, viewport.width - card.width - EDGE)
  const centredY = clamp(target.top + (target.height - card.height) / 2, EDGE, viewport.height - card.height - EDGE)

  if (target.top + target.height + GAP + card.height + EDGE <= viewport.height) {
    return { left: centredX, top: target.top + target.height + GAP }
  }
  if (target.top - GAP - card.height >= EDGE) {
    return { left: centredX, top: target.top - GAP - card.height }
  }
  if (target.left - GAP - card.width >= EDGE) {
    return { left: target.left - GAP - card.width, top: centredY }
  }
  if (target.left + target.width + GAP + card.width + EDGE <= viewport.width) {
    return { left: target.left + target.width + GAP, top: centredY }
  }
  return { left: centredX, top: Math.max(EDGE, viewport.height - card.height - EDGE) }
}

// The highlight around a target, kept on screen so its edges always show.
export function highlightRect (target, viewport, padding = 6) {
  const left = Math.max(2, target.left - padding)
  const top = Math.max(2, target.top - padding)
  return {
    left,
    top,
    width: Math.max(0, Math.min(viewport.width - 2, target.left + target.width + padding) - left),
    height: Math.max(0, Math.min(viewport.height - 2, target.top + target.height + padding) - top)
  }
}
