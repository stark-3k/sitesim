// Where someone on foot can and can't go. Solid things are boxes on the ground,
// { minX, maxX, minZ, maxZ, sight }, and sight marks what can't be seen through.
// No Three.js here, so it runs under Node's test runner.

export const PLAYER_RADIUS = 0.22
export const EYE_HEIGHT = 1.68
export const DOOR_WIDTH = 1
const WALL = 0.08
const FENCE = 0.05
// Past the gate you can only go so far along the road.
const WORLD_MARGIN = 45
const MAX_STEP = 0.1

const box = (x, z, w, d, sight = true) => ({
  minX: x - w / 2,
  maxX: x + w / 2,
  minZ: z - d / 2,
  maxZ: z + d / 2,
  sight
})

function containerColliders (container, out) {
  const { origin: { x, z }, length, width, racks } = container
  // Long walls, and the closed end. Power comes in at +x, and the door is at -x.
  out.push(box(x, z + width / 2, length, WALL))
  out.push(box(x, z - width / 2, length, WALL))
  out.push(box(x + length / 2, z, WALL, width))
  const jamb = (width - DOOR_WIDTH) / 2
  for (const side of [1, -1]) {
    out.push(box(x - length / 2, z + side * (DOOR_WIDTH / 2 + jamb / 2), WALL, jamb))
  }
  // Each row of racks is one solid block. The shelves are the widest parts.
  for (const side of [1, -1]) {
    const shelves = racks.filter((part) => part.w > 0.1 && Math.sign(part.z) === side)
    const shelf = shelves[0]
    if (shelf) out.push(box(x + shelf.x, z + shelf.z, shelf.w, shelf.d))
  }
}

function fenceColliders ({ minX, maxX, minZ, maxZ, gateHalf }, out) {
  const see = false
  out.push(box((minX - gateHalf) / 2, maxZ, -gateHalf - minX, FENCE, see))
  out.push(box((maxX + gateHalf) / 2, maxZ, maxX - gateHalf, FENCE, see))
  out.push(box(maxX, (minZ + maxZ) / 2, FENCE, maxZ - minZ, see))
  out.push(box(minX, (minZ + maxZ) / 2, FENCE, maxZ - minZ, see))
  out.push(box((minX + maxX) / 2, minZ, maxX - minX, FENCE, see))
}

export function buildColliders (site) {
  const { boxes, yard } = site
  const colliders = []
  for (const container of boxes) containerColliders(container, colliders)
  fenceColliders(yard.fence, colliders)

  const { x, z } = yard.substation
  colliders.push(box(x + yard.transformer.x, z + yard.transformer.z, yard.transformer.w, yard.transformer.d))
  colliders.push(box(x + yard.switchgear.x, z + yard.switchgear.z, yard.switchgear.w, yard.switchgear.d))
  for (const mast of yard.masts) colliders.push(box(mast.x, mast.z, 0.2, 0.2, false))
  return colliders
}

function overlaps (x, z, c) {
  return x > c.minX - PLAYER_RADIUS && x < c.maxX + PLAYER_RADIUS &&
    z > c.minZ - PLAYER_RADIUS && z < c.maxZ + PLAYER_RADIUS
}

export function isClear (x, z, colliders) {
  return !colliders.some((c) => overlaps(x, z, c))
}

// Moves as far as possible, in small steps so thin walls can't be skipped. Each axis
// is tried separately, which lets you slide along a wall instead of sticking to it.
export function move (position, dx, dz, colliders, bounds) {
  const distance = Math.hypot(dx, dz)
  const steps = Math.max(1, Math.ceil(distance / MAX_STEP))
  let { x, z } = position
  for (let i = 0; i < steps; i++) {
    const nextX = x + dx / steps
    if (isClear(nextX, z, colliders)) x = nextX
    const nextZ = z + dz / steps
    if (isClear(x, nextZ, colliders)) z = nextZ
  }
  if (bounds) {
    x = Math.min(bounds.maxX, Math.max(bounds.minX, x))
    z = Math.min(bounds.maxZ, Math.max(bounds.minZ, z))
  }
  return { x, z }
}

// Whether something solid stands between two points on the ground. Racks don't
// count at the far end, because the thing you're looking at is often on one.
export function isBlocked (from, to, colliders) {
  const distance = Math.hypot(to.x - from.x, to.z - from.z)
  const steps = Math.ceil(distance / 0.08)
  // Stop short of the target, which sits inside its own rack's collider.
  for (let i = 1; i < steps - 4; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const z = from.z + ((to.z - from.z) * i) / steps
    if (colliders.some((c) => c.sight && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ)) return true
  }
  return false
}

export function walkBounds ({ fence }) {
  return {
    minX: fence.minX - WORLD_MARGIN,
    maxX: fence.maxX + WORLD_MARGIN,
    minZ: fence.minZ - WORLD_MARGIN,
    maxZ: fence.maxZ + WORLD_MARGIN
  }
}

// Outside the gate on the road, looking in. A yaw of 0 faces towards -z.
export function spawnPoint ({ fence, road }) {
  return { x: road.x, z: fence.maxZ + 3, yaw: 0 }
}

// Just inside a container's door, looking down the aisle.
export function doorPoint (container) {
  return { x: container.origin.x - container.length / 2 - 1, z: container.origin.z, yaw: -Math.PI / 2 }
}

// A miner you're facing, even if the crosshair passes above or below it, as you'd
// expect when standing over a low rack. Takes the closest match to your heading.
const FACING_RAD = 0.3

export function facingMiner (walker, centres, reach, colliders) {
  let best = null
  let bestScore = Infinity
  for (const [id, centre] of centres) {
    const dx = centre.x - walker.x
    const dz = centre.z - walker.z
    const distance = Math.hypot(dx, dz)
    if (distance > reach || distance < 0.01) continue
    // A yaw of 0 faces -z, and turning left increases it.
    const heading = Math.atan2(-dx, -dz)
    let off = Math.abs(heading - walker.yaw) % (Math.PI * 2)
    if (off > Math.PI) off = Math.PI * 2 - off
    if (off > FACING_RAD) continue
    const score = off + distance * 0.25
    if (score < bestScore && !isBlocked(walker, centre, colliders)) {
      best = id
      bestScore = score
    }
  }
  return best
}
