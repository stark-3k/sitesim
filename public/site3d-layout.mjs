import { SLOT } from './site3d-models.mjs'

// Where everything sits in the 3D site, in metres. No Three.js here, so it can
// run under Node's test runner. Position is only a picture: the engine gives every
// miner in a container the same inlet temperature.

const MINER = { ...SLOT, gapX: 0.05, gapY: 0.07 }

// Real shipping container sizes, in metres. Past a 40 ft container's capacity it
// simply stretches, which no real container does, so huge fleets look less real.
const CONTAINER = { width: 2.44, height: 2.59, lengths: [6.06, 12.19] }
const MIN_SHELVES = 2
const MAX_SHELVES = 4
const FLOOR = 0.22
// Space at each end for the door, electrical panel and network cabinet.
const END_BAY = 1
const WALL = 0.16
// The hot aisle between the two rows, which is whatever the width leaves.
const AISLE = CONTAINER.width - MINER.d * 2 - WALL * 2
const YARD_GAP = 5

const PITCH_X = MINER.w + MINER.gapX
const PITCH_Y = MINER.h + MINER.gapY

// Picks the smallest real container that fits, with the fewest shelves that do,
// so a part-full container has its miners spread along its length.
function chooseRacking (perSide) {
  for (const length of CONTAINER.lengths) {
    for (let shelves = MIN_SHELVES; shelves <= MAX_SHELVES; shelves++) {
      const columns = Math.max(1, Math.ceil(perSide / shelves))
      if (columns * PITCH_X + END_BAY * 2 <= length) return { length, shelves, columns }
    }
  }
  const columns = Math.ceil(perSide / MAX_SHELVES)
  return { length: columns * PITCH_X + END_BAY * 2, shelves: MAX_SHELVES, columns }
}

export function layoutContainer (minerCount) {
  const perSide = Math.ceil(minerCount / 2)
  const { length, shelves, columns } = chooseRacking(perSide)

  // Racks are centred, with any spare length left at the ends, as in a part-full container.
  const startX = -(columns * PITCH_X) / 2 + MINER.w / 2
  const positions = []
  for (let i = 0; i < minerCount; i++) {
    const side = i % 2 === 0 ? 1 : -1
    const index = Math.floor(i / 2)
    positions.push({
      x: startX + Math.floor(index / shelves) * PITCH_X,
      y: FLOOR + MINER.h / 2 + (index % shelves) * PITCH_Y,
      z: side * (AISLE / 2 + MINER.d / 2)
    })
  }
  return {
    length,
    width: CONTAINER.width,
    height: CONTAINER.height,
    shelves,
    columns,
    positions,
    racks: rackParts(columns, shelves)
  }
}

// Steel for the miners to sit on: a shelf under each row, and uprights between
// columns, as { x, y, z, w, h, d } boxes relative to the container.
function rackParts (columns, shelves) {
  const spanX = columns * PITCH_X
  const startX = -spanX / 2 - MINER.gapX / 2
  const parts = []
  for (const side of [-1, 1]) {
    const z = side * (AISLE / 2 + MINER.d / 2)
    for (let shelf = 0; shelf < shelves; shelf++) {
      parts.push({ x: -MINER.gapX / 2, y: FLOOR + shelf * PITCH_Y - 0.012, z, w: spanX, h: 0.024, d: MINER.d + 0.04 })
    }
    for (let column = 0; column <= columns; column += Math.max(1, Math.ceil(columns / 10))) {
      for (const inset of [-1, 1]) {
        parts.push({
          x: startX + column * PITCH_X,
          y: FLOOR + (shelves * PITCH_Y) / 2,
          z: z + inset * (MINER.d / 2 + 0.01),
          w: 0.03,
          h: shelves * PITCH_Y,
          d: 0.03
        })
      }
    }
  }
  return parts
}

// The compound around the containers: substation at the back, power runs to each
// container through the gaps between them, a fence with a gate, and a road in.
function layoutYard (boxes, cellX) {
  const edgeX = Math.max(...boxes.map((b) => Math.abs(b.origin.x) + b.length / 2))
  const backZ = Math.min(...boxes.map((b) => b.origin.z - b.width / 2))
  const frontZ = Math.max(...boxes.map((b) => b.origin.z + b.width / 2))

  const substation = { x: 0, z: backZ - 7.5 }
  const spineZ = backZ - 2.5
  const fence = { minX: -edgeX - 4.5, maxX: edgeX + 4.5, minZ: backZ - 12, maxZ: frontZ + 5, gateHalf: 3 }
  const masts = [
    { x: fence.minX + 1, z: fence.minZ + 1 },
    { x: fence.maxX - 1, z: fence.minZ + 1 },
    { x: fence.minX + 1, z: fence.maxZ - 1 },
    { x: fence.maxX - 1, z: fence.maxZ - 1 }
  ]

  // Each run leaves the switchgear, follows the spine to the gap beside its
  // container, comes forward through the gap, and enters at the container's end.
  const CABLE = 0.32
  const runs = boxes.map((box) => {
    const entryX = box.origin.x + box.length / 2
    const gapX = box.origin.x + (cellX / 2)
    const segment = (x1, z1, x2, z2) => ({
      x: (x1 + x2) / 2,
      z: (z1 + z2) / 2,
      w: Math.abs(x2 - x1) + CABLE,
      d: Math.abs(z2 - z1) + CABLE
    })
    return {
      id: box.id,
      segments: [
        segment(substation.x, spineZ, gapX, spineZ),
        segment(gapX, spineZ, gapX, box.origin.z),
        segment(gapX, box.origin.z, entryX, box.origin.z)
      ]
    }
  })

  return {
    substation,
    // Relative to the substation, and including the transformer's cooling fins.
    transformer: { x: -1.6, z: 0, w: 2.5, d: 2.5 },
    switchgear: { x: 2.4, z: 0.4, w: 3.2, d: 1 },
    spineZ,
    fence,
    masts,
    runs,
    road: { x: 0, width: 5, fromZ: fence.maxZ - 0.5, length: 400 }
  }
}

// Containers go in a roughly square yard, centred on the origin.
export function layoutSite (containers) {
  const boxes = containers.map((container) => ({ id: container.id, ...layoutContainer(container.minerCount) }))
  const perRow = Math.max(1, Math.ceil(Math.sqrt(boxes.length)))
  const cellX = Math.max(...boxes.map((b) => b.length), 1) + YARD_GAP
  const cellZ = Math.max(...boxes.map((b) => b.width), 1) + YARD_GAP
  const rows = Math.ceil(boxes.length / perRow)

  boxes.forEach((box, i) => {
    box.origin = {
      x: ((i % perRow) - (perRow - 1) / 2) * cellX,
      y: 0,
      z: (Math.floor(i / perRow) - (rows - 1) / 2) * cellZ
    }
  })

  const yard = layoutYard(boxes, cellX)
  const { fence } = yard
  // What the camera has to fit: the whole compound, which isn't centred on the containers.
  const halfX = (fence.maxX - fence.minX) / 2
  const halfZ = (fence.maxZ - fence.minZ) / 2
  const centre = { x: (fence.maxX + fence.minX) / 2, z: (fence.maxZ + fence.minZ) / 2 }
  return { boxes, yard, centre, halfX, halfZ, height: 6, radius: Math.sqrt(halfX * halfX + halfZ * halfZ), miner: MINER }
}

// How far back a camera must sit to see the whole site, whatever the panel's
// shape. Pitch is how far it looks down, in radians. The margin leaves room for labels.
export function cameraDistance ({ halfX, halfZ, height }, fovDegrees, aspect, pitch, margin = 1.18) {
  const tanV = Math.tan((fovDegrees * Math.PI) / 360)
  const tanH = tanV * aspect
  // Seen from above, depth foreshortens by the sine of the pitch.
  const halfHeight = halfZ * Math.sin(pitch) + (height + 3) * Math.cos(pitch)
  // The near corners sit closer to the camera, so they need more room.
  const forWidth = halfX / tanH + halfZ * Math.cos(pitch)
  const forHeight = halfHeight / tanV + halfZ * Math.cos(pitch)
  return Math.max(forWidth, forHeight) * margin
}

// A signature of what changes the layout, so the scene rebuilds only when needed.
export function fleetSignature (state) {
  return state.containers.map((c) => c.id).join(',') + '|' + state.miners.map((m) => `${m.c}:${m.id}:${m.model}`).join(',')
}
