// The 3D site view. It only draws what the live state says, and takes its miner
// colours from the panel, so the heatmap and this view can't disagree.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/OrbitControls.js'
import { layoutSite, fleetSignature, cameraDistance } from './site3d-layout.mjs'
import { MinerFleet } from './site3d-miners.js'
import { SiteYard } from './site3d-yard.js'
import { buildColliders, move, isBlocked, facingMiner, spawnPoint, walkBounds, EYE_HEIGHT } from './site3d-walk.mjs'

const FANS_PER_CONTAINER = 3
const AIR_PARTICLES = 70
const AIR_RISE_M = 3.6
const CLICK_SLOP_PX = 5
const HOVER_MS = 60
const FULL_FAN_RAD_S = 16
const CAMERA_PITCH = 0.62
const CAMERA_YAW = 0.16
const WALK_M_S = 2.4
const JOG_M_S = 5.5
const TURN_RAD_S = 1.9
const LOOK_RAD_PX = 0.004
const REACH_M = 4
const STEP_BOB_M = 0.022
// Everything nearby is in view on foot, so always draw miners at full detail.
const ON_FOOT_FAN_PX = 100
const WALK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'])

const NIGHT = new THREE.Color('#0b0d12')
const DAY = new THREE.Color('#5d7084')
const DUSK = new THREE.Color('#2a2c3a')
const COOL_AIR = new THREE.Color('#7fb4d8')
const HOT_AIR = new THREE.Color('#ff7a4d')

const clamp01 = (x) => Math.min(1, Math.max(0, x))

// A soft round puff, so rising air reads as haze rather than as square dots.
function puffTexture () {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(canvas)
}

export function createSite3D (host, { colorFor, onSelectMiner, onSelectContainer, describeMiner, onWalkChange }) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  // Shadows are redrawn on request, not every frame, since nothing big moves.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.shadowMap.autoUpdate = false
  host.append(renderer.domElement)
  renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of the mining site. Every value here is also on the Dashboard view.')
  renderer.domElement.setAttribute('role', 'img')

  const labels = document.createElement('div')
  labels.className = 'site3d-labels'
  host.append(labels)
  const tooltip = document.createElement('div')
  tooltip.className = 'site3d-tooltip'
  tooltip.hidden = true
  host.append(tooltip)
  const hud = document.createElement('div')
  hud.className = 'site3d-hud'
  hud.hidden = true
  hud.innerHTML = `<div class="site3d-crosshair"></div>
    <div class="site3d-target" role="status" hidden></div>
    <div class="site3d-keys"><b>↑ ↓</b> walk <b>← →</b> turn <b>A D</b> sidestep <b>Shift</b> jog <b>Drag</b> look <b>E</b> inspect <b>F</b> full screen <b>Esc</b> exit</div>`
  host.append(hud)
  const targetLabel = hud.querySelector('.site3d-target')

  const scene = new THREE.Scene()
  scene.background = NIGHT.clone()
  scene.fog = new THREE.Fog(NIGHT.getHex(), 60, 220)

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1200)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = !reducedMotion
  controls.dampingFactor = 0.08
  controls.maxPolarAngle = Math.PI * 0.49
  controls.addEventListener('start', () => { userMovedCamera = true })

  // Bright enough that a miner's colour matches the legend, day or night.
  // Bright enough that a miner's colour matches the legend, day or night.
  const hemi = new THREE.HemisphereLight('#e4ecff', '#4a443a', 2.6)
  const sun = new THREE.DirectionalLight('#ffe6c4', 1.2)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0006
  scene.add(hemi, sun, sun.target)

  const puff = puffTexture()
  const yard = new SiteYard(scene, sun, puff)

  // Shared by every container, so a big yard stays light.
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1)
  const edgeGeometry = new THREE.EdgesGeometry(boxGeometry)
  const fanRingGeometry = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 20)
  const bladeGeometry = new THREE.BoxGeometry(0.46, 0.02, 0.06)
  const floorMaterial = new THREE.MeshStandardMaterial({ color: '#34383d', roughness: 0.9 })
  const padMaterial = new THREE.MeshStandardMaterial({ color: '#6d6e6c', roughness: 1 })
  const fanMaterial = new THREE.MeshStandardMaterial({ color: '#4b5158', roughness: 0.5 })
  const bladeMaterial = new THREE.MeshStandardMaterial({ color: '#c9ced4', roughness: 0.4 })
  const edgeOk = new THREE.Color('#7a838e')
  const edgeBad = new THREE.Color('#e5604d')

  const fleet = new MinerFleet(scene, reducedMotion)
  const projected = new THREE.Vector3()

  let site = null
  let containerViews = []
  let signature = null
  let latest = null
  let active = false
  let frame = null
  let lastTime = 0
  let hasFramed = false
  let userMovedCamera = false
  let substationLabel = null
  let walk = null
  const keys = new Set()

  function disposeSite () {
    fleet.clear()
    for (const view of containerViews) {
      scene.remove(view.group)
      view.edgeMaterial.dispose()
      view.air.geometry.dispose()
      view.air.material.dispose()
      view.label.remove()
    }
    containerViews = []
  }

  function buildContainer (box, name) {
    const group = new THREE.Group()
    group.position.set(box.origin.x, 0, box.origin.z)

    const edgeMaterial = new THREE.LineBasicMaterial({ color: edgeOk.clone() })
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial)
    edges.scale.set(box.length, box.height, box.width)
    edges.position.y = box.height / 2

    const floor = new THREE.Mesh(boxGeometry, floorMaterial)
    floor.scale.set(box.length, 0.12, box.width)
    floor.position.y = 0.1
    floor.castShadow = true
    // A concrete pad, so the container sits on something.
    const pad = new THREE.Mesh(boxGeometry, padMaterial)
    pad.scale.set(box.length + 1.2, 0.06, box.width + 1.2)
    pad.position.y = 0
    pad.receiveShadow = true
    group.add(pad, edges, floor)

    const fans = []
    for (let i = 0; i < FANS_PER_CONTAINER; i++) {
      const x = (i - (FANS_PER_CONTAINER - 1) / 2) * (box.length / FANS_PER_CONTAINER)
      const ring = new THREE.Mesh(fanRingGeometry, fanMaterial)
      ring.position.set(x, box.height + 0.04, 0)
      const blades = new THREE.Group()
      blades.position.set(x, box.height + 0.1, 0)
      for (let b = 0; b < 2; b++) {
        const blade = new THREE.Mesh(bladeGeometry, bladeMaterial)
        blade.rotation.y = (b * Math.PI) / 2
        blades.add(blade)
      }
      group.add(ring, blades)
      fans.push(blades)
    }

    // Hot air rising off the roof, one loop per particle.
    const positions = new Float32Array(AIR_PARTICLES * 3)
    const seeds = new Float32Array(AIR_PARTICLES)
    for (let i = 0; i < AIR_PARTICLES; i++) {
      // A fixed pattern: this is decoration, so it stays out of the seeded engine.
      const a = Math.sin(i * 12.9898) * 43758.5453
      const b = Math.sin(i * 78.233) * 12543.123
      // Hot air leaves through the roof fans, so each puff starts over one of them.
      const fan = i % FANS_PER_CONTAINER
      const fanX = (fan - (FANS_PER_CONTAINER - 1) / 2) * (box.length / FANS_PER_CONTAINER)
      positions[i * 3] = fanX + ((a - Math.floor(a)) - 0.5) * 0.6
      positions[i * 3 + 2] = ((b - Math.floor(b)) - 0.5) * 0.6
      seeds[i] = (i / AIR_PARTICLES)
    }
    const airGeometry = new THREE.BufferGeometry()
    airGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const air = new THREE.Points(airGeometry, new THREE.PointsMaterial({
      size: 1.1, map: puff, transparent: true, opacity: 0, color: COOL_AIR.clone(), depthWrite: false, blending: THREE.AdditiveBlending
    }))
    air.position.y = box.height + 0.1
    air.frustumCulled = false
    group.add(air)
    scene.add(group)

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'site3d-label'
    label.dataset.containerId = box.id
    label.innerHTML = `<strong>${name.replace(/[<>&]/g, '')}</strong><span></span>`
    label.title = 'Focus here and pick it as the target for a cooling fault'
    labels.append(label)

    return { id: box.id, box, group, edgeMaterial, fans, air, seeds, label, stats: label.querySelector('span'), fanRate: 0, heat: 0, tempMix: 0 }
  }

  function build (state) {
    disposeSite()
    const containers = state.containers.map((c) => ({
      id: c.id,
      minerCount: state.miners.filter((m) => m.c === c.id).length
    }))
    site = layoutSite(containers)

    containerViews = site.boxes.map((box, i) => buildContainer(box, state.containers[i].name))
    fleet.build(state, site.boxes)
    if (!substationLabel) {
      substationLabel = document.createElement('div')
      substationLabel.className = 'site3d-label site3d-label-static'
      substationLabel.innerHTML = '<strong>Substation</strong><span></span>'
      labels.append(substationLabel)
    }

    yard.build(site)

    // A new fleet has a new shape, so refit unless the viewer has taken over.
    if (walk) stopWalking()
    if (!hasFramed || !userMovedCamera) {
      resetCamera()
      hasFramed = true
    }
  }

  // Fits the whole site to the panel. This repeats on resize until the viewer moves
  // the camera themselves, after which it's theirs until they press Reset view.
  function resetCamera () {
    if (!site) return
    userMovedCamera = false
    const { x, z } = site.centre
    const place = (d) => {
      const flat = d * Math.cos(CAMERA_PITCH)
      camera.position.set(x + flat * Math.sin(CAMERA_YAW), d * Math.sin(CAMERA_PITCH) + 0.8, z + flat * Math.cos(CAMERA_YAW))
      camera.lookAt(x, 0.8, z)
      camera.updateMatrixWorld()
    }
    // Starts from a safe estimate, then finds the closest spot where the compound
    // still fits, by checking where its corners land. There's more room left at the top for labels.
    const { fence } = site.yard
    const fits = (d) => {
      place(d)
      for (const cx of [fence.minX, fence.maxX]) {
        for (const cz of [fence.minZ, fence.maxZ]) {
          for (const cy of [0, 3]) {
            projected.set(cx, cy, cz).project(camera)
            if (Math.abs(projected.x) > 0.96 || projected.y > 0.82 || projected.y < -0.96) return false
          }
        }
      }
      return true
    }
    let far = cameraDistance(site, camera.fov, camera.aspect, CAMERA_PITCH) * 1.5
    let near = 1
    for (let i = 0; i < 16; i++) {
      const mid = (near + far) / 2
      if (fits(mid)) far = mid
      else near = mid
    }
    const distance = far
    place(distance)
    controls.target.set(x, 0.8, z)
    controls.maxDistance = distance * 3
    // Fog only softens the distant yard, so it scales with how far back the camera sits.
    scene.fog.near = distance * 2
    scene.fog.far = distance * 9
    controls.minDistance = 2
    controls.update()
  }

  function focusContainer (id) {
    const view = containerViews.find((v) => v.id === id)
    if (!view) return
    const { x, z } = view.box.origin
    // Close enough for the fans to show, which is when the miners look real.
    const r = Math.max(view.box.length * 0.85, 3)
    controls.target.set(x, view.box.height / 2, z)
    camera.position.set(x + r * 0.45, view.box.height + r * 0.35, z + r)
    controls.update()
    userMovedCamera = true
  }

  function update (state) {
    latest = state
    const nextSignature = fleetSignature(state)
    if (nextSignature !== signature) {
      signature = nextSignature
      build(state)
    }

    // Night to day from the simulated clock.
    const hour = state.clock.hour + state.clock.minute / 60
    const daylight = clamp01(Math.sin(((hour - 6) / 12) * Math.PI))
    if (daylight < 0.3) scene.background.copy(NIGHT).lerp(DUSK, daylight / 0.3)
    else scene.background.copy(DUSK).lerp(DAY, (daylight - 0.3) / 0.7)
    scene.fog.color.copy(scene.background)
    sun.intensity = daylight * 2
    // With no power there are no site lights either.
    const siteLive = !state.site.gridDown && !state.site.breakerOpen
    hemi.intensity = siteLive ? 1.5 + daylight * 1.1 : 0.7 + daylight * 1.1
    yard.update(state, daylight)
    yard.placeSun(hour, renderer, performance.now())
    if (substationLabel) {
      substationLabel.classList.toggle('bad', !siteLive)
      substationLabel.lastElementChild.textContent = state.site.breakerOpen
        ? 'Breaker open'
        : state.site.gridDown
          ? 'No grid power'
          : state.site.limitKw === null ? `${state.site.powerKw.toFixed(0)} kW` : `${state.site.powerKw.toFixed(0)} kW · limit ${state.site.limitKw.toFixed(0)} kW`
    }

    fleet.update(state, colorFor)

    const minersBy = new Map()
    for (const m of state.miners) {
      if (!minersBy.has(m.c)) minersBy.set(m.c, [])
      minersBy.get(m.c).push(m)
    }

    const dark = state.site.gridDown || state.site.breakerOpen
    for (const view of containerViews) {
      const c = state.containers.find((x) => x.id === view.id)
      if (!c) continue
      const list = minersBy.get(view.id) || []
      const avgFan = list.length ? list.reduce((sum, m) => sum + m.fan, 0) / list.length : 0
      view.fanRate = dark || c.fx.pduOff ? 0 : (avgFan / 100) * FULL_FAN_RAD_S * (1 - c.fx.coolingLoss)
      view.heat = clamp01(c.heatKw / Math.max(1, c.capacityKw))
      view.tempMix = clamp01((c.inletC - 25) / 35)
      const trouble = c.fx.coolingLoss > 0 || c.fx.pduOff || c.fx.netDown || c.heatKw > c.availableKw
      view.edgeMaterial.color.copy(trouble ? edgeBad : edgeOk)
      view.air.material.color.copy(COOL_AIR).lerp(HOT_AIR, view.tempMix)
      view.label.classList.toggle('bad', trouble)
      view.stats.textContent = `Inlet ${c.inletC.toFixed(1)}°C · ${c.heatKw.toFixed(0)} kW`
    }
  }

  function resize () {
    const { clientWidth: w, clientHeight: h } = host
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    if (!userMovedCamera && !walk) resetCamera()
  }

  function placeLabels () {
    const { clientWidth: w, clientHeight: h } = host
    if (substationLabel && site) {
      const { x, z } = site.yard.substation
      projected.set(x, 3.8, z).project(camera)
      substationLabel.hidden = projected.z >= 1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1
      substationLabel.style.transform = `translate(-50%, -100%) translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px)`
    }
    for (const view of containerViews) {
      projected.set(view.box.origin.x, view.box.height + 1.4, view.box.origin.z).project(camera)
      const visible = projected.z < 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1
      view.label.hidden = !visible
      if (visible) {
        view.label.style.transform = `translate(-50%, -100%) translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px)`
      }
    }
  }

  function animate (dt, t) {
    fleet.animate(dt, t)
    if (!reducedMotion) {
      for (const view of containerViews) {
        for (const fan of view.fans) fan.rotation.y += view.fanRate * dt

        const position = view.air.geometry.attributes.position
        const speed = 0.25 + view.heat * 1.1
        for (let i = 0; i < AIR_PARTICLES; i++) {
          view.seeds[i] = (view.seeds[i] + dt * speed / AIR_RISE_M) % 1
          position.array[i * 3 + 1] = view.seeds[i] * AIR_RISE_M
        }
        position.needsUpdate = true
      }

    } else {
      for (const view of containerViews) {
        const position = view.air.geometry.attributes.position
        for (let i = 0; i < AIR_PARTICLES; i++) position.array[i * 3 + 1] = view.seeds[i] * AIR_RISE_M
        position.needsUpdate = true
      }
    }
    for (const view of containerViews) view.air.material.opacity = view.heat * (0.1 + view.tempMix * 0.4)
  }

  function loop (time) {
    if (!active) return
    frame = requestAnimationFrame(loop)
    const dt = Math.min(0.1, (time - lastTime) / 1000 || 0)
    lastTime = time
    if (walk) {
      stepWalking(dt)
      fleet.setFanPixels(ON_FOOT_FAN_PX)
    } else {
      controls.update()
      // A fan is about 13 cm across: how many pixels is that from here?
      const distance = camera.position.distanceTo(controls.target)
      const viewHeight = 2 * distance * Math.tan((camera.fov * Math.PI) / 360)
      fleet.setFanPixels((0.13 / viewHeight) * host.clientHeight)
    }
    animate(dt, time / 1000)
    yard.updateCutaway(camera)
    placeLabels()
    renderer.render(scene, camera)
  }

  function setActive (next) {
    if (next === active) return
    active = next
    if (active) {
      resize()
      lastTime = performance.now()
      renderer.shadowMap.needsUpdate = true
      frame = requestAnimationFrame(loop)
    } else {
      cancelAnimationFrame(frame)
      tooltip.hidden = true
      keys.clear()
    }
  }

  // --- picking ------------------------------------------------------------

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  function minerAt (event) {
    if (!site || !latest) return null
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    return fleet.pick(raycaster)
  }

  // --- on foot ------------------------------------------------------------

  function placeWalkCamera () {
    const bob = reducedMotion ? 0 : Math.sin(walk.stride) * STEP_BOB_M
    camera.position.set(walk.x, EYE_HEIGHT + bob, walk.z)
    camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ')
  }

  function startWalking () {
    if (!site || walk) return
    const start = spawnPoint(site.yard)
    walk = {
      ...start,
      // Slightly down, as a person looks, which also keeps low racks in view.
      pitch: -0.2,
      stride: 0,
      colliders: buildColliders(site),
      bounds: walkBounds(site.yard),
      target: null,
      saved: { position: camera.position.clone(), target: controls.target.clone(), moved: userMovedCamera, near: scene.fog.near, far: scene.fog.far, fov: camera.fov }
    }
    controls.enabled = false
    scene.fog.near = 45
    scene.fog.far = 260
    camera.fov = 68
    camera.updateProjectionMatrix()
    yard.setOnFoot(true)
    labels.hidden = true
    tooltip.hidden = true
    hud.hidden = false
    placeWalkCamera()
    onWalkChange?.(true)
  }

  function stopWalking () {
    if (!walk) return
    const { saved } = walk
    walk = null
    keys.clear()
    camera.fov = saved.fov
    camera.updateProjectionMatrix()
    scene.fog.near = saved.near
    scene.fog.far = saved.far
    camera.position.copy(saved.position)
    controls.target.copy(saved.target)
    userMovedCamera = saved.moved
    controls.enabled = true
    controls.update()
    yard.setOnFoot(false)
    labels.hidden = false
    hud.hidden = true
    targetLabel.hidden = true
    onWalkChange?.(false)
  }

  function stepWalking (dt) {
    const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)
    walk.yaw += turn * TURN_RAD_S * dt

    const forward = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0)
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)
    if (forward || strafe) {
      const jogging = keys.has('ShiftLeft') || keys.has('ShiftRight')
      const speed = (jogging ? JOG_M_S : WALK_M_S) * dt / Math.hypot(forward, strafe)
      const sin = Math.sin(walk.yaw)
      const cos = Math.cos(walk.yaw)
      const dx = (-sin * forward + cos * strafe) * speed
      const dz = (-cos * forward - sin * strafe) * speed
      const next = move(walk, dx, dz, walk.colliders, walk.bounds)
      const moved = Math.hypot(next.x - walk.x, next.z - walk.z)
      walk.x = next.x
      walk.z = next.z
      walk.stride += moved * 5
    }
    placeWalkCamera()
    updateTarget()
  }

  // Whichever miner the crosshair is on, if it's in reach with nothing in the way.
  function updateTarget () {
    pointer.set(0, 0)
    raycaster.setFromCamera(pointer, camera)
    const hit = fleet.pickHit(raycaster)
    let id = null
    if (hit && hit.distance <= REACH_M) {
      const centre = fleet.centreOf(hit.id)
      if (!isBlocked(walk, centre, walk.colliders)) id = hit.id
    }
    if (!id) id = facingMiner(walk, fleet.centres, REACH_M, walk.colliders)
    walk.target = id
    const miner = id && latest?.miners.find((m) => m.id === id)
    targetLabel.hidden = !miner
    if (miner) targetLabel.innerHTML = `<strong>${describeMiner(miner).replace(/[<>&]/g, '')}</strong><span>Press E to inspect</span>`
  }

  // Keys only count while nothing else wants them.
  const walkingInput = () => walk && active && !document.querySelector('dialog[open]') &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)

  window.addEventListener('keydown', (event) => {
    if (!walkingInput()) return
    if (event.code === 'Escape') {
      stopWalking()
      event.preventDefault()
    } else if (event.code === 'KeyE' || event.code === 'Enter') {
      if (walk.target) onSelectMiner(walk.target)
      event.preventDefault()
    } else if (WALK_KEYS.has(event.code)) {
      keys.add(event.code)
      event.preventDefault()
    }
  })
  window.addEventListener('keyup', (event) => keys.delete(event.code))
  // A key released while the window was in the background never reports it.
  window.addEventListener('blur', () => keys.clear())

  let downAt = null
  let lastHover = 0

  renderer.domElement.addEventListener('pointerdown', (event) => {
    downAt = { x: event.clientX, y: event.clientY }
    if (document.activeElement?.tagName !== 'BODY') document.activeElement?.blur()
  })
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (!downAt) return
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
    downAt = null
    if (moved > CLICK_SLOP_PX) return
    if (walk) {
      if (walk.target) onSelectMiner(walk.target)
      return
    }
    const id = minerAt(event)
    if (id) onSelectMiner(id)
  })
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (walk) {
      if (event.buttons) {
        walk.yaw -= event.movementX * LOOK_RAD_PX
        walk.pitch = Math.max(-1.3, Math.min(1.3, walk.pitch - event.movementY * LOOK_RAD_PX))
      }
      return
    }
    const now = performance.now()
    if (now - lastHover < HOVER_MS || event.buttons) return
    lastHover = now
    const id = minerAt(event)
    const miner = id && latest.miners.find((m) => m.id === id)
    renderer.domElement.style.cursor = miner ? 'pointer' : 'grab'
    tooltip.hidden = !miner
    if (miner) {
      const rect = host.getBoundingClientRect()
      tooltip.textContent = describeMiner(miner)
      tooltip.style.transform = `translate(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 14}px)`
    }
  })
  renderer.domElement.addEventListener('pointerleave', () => { tooltip.hidden = true })

  labels.addEventListener('click', (event) => {
    const label = event.target.closest('[data-container-id]')
    if (!label) return
    focusContainer(label.dataset.containerId)
    onSelectContainer(label.dataset.containerId)
  })

  new ResizeObserver(resize).observe(host)

  return {
    update,
    setActive,
    resetCamera,
    startWalking,
    stopWalking,
    get walk () {
      return walk && { x: walk.x, z: walk.z, yaw: walk.yaw, target: walk.target }
    },
    // Where a miner appears on screen, in client pixels. Used to test real clicks.
    screenPositionOf (id) {
      const centre = fleet.centreOf(id)
      if (!centre) return null
      projected.set(centre.x, centre.y, centre.z).project(camera)
      const rect = renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((projected.x + 1) / 2) * rect.width, y: rect.top + ((1 - projected.y) / 2) * rect.height }
    },
    // Moves in close on one miner, to see its detail.
    focusMiner (id) {
      const centre = fleet.centreOf(id)
      if (!centre) return
      controls.target.set(centre.x, centre.y, centre.z)
      camera.position.set(centre.x + 0.9, centre.y + 0.45, centre.z + 1.5)
      controls.update()
      userMovedCamera = true
    },
    // Stands somewhere exact. Used to test the view from inside a container.
    placeWalker (x, z, yaw) {
      if (!walk) return
      Object.assign(walk, { x, z, yaw })
    },
    get info () {
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, ...fleet.stats }
    }
  }
}
