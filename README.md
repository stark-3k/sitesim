# SiteSim

A simulated Bitcoin mining site for developing against [MDK](https://github.com/tetherto/mdk). It models how heat, cooling, power, pools and money affect each other, and exposes each device over its real vendor protocol, so MDK Workers should be able to connect without changes.

MDK's bundled mocks answer as individual devices. SiteSim adds what they leave out: a site where throttling a miner lowers the power meter, a cooling failure overheats a whole container, and a pool outage costs real revenue.

The default fleet has 120 miners, 20 each from the six miner families MDK supports. It has no dependencies to install and needs Node 22 or newer.

## Run it

```bash
node bin/sitesim.js
```

Then open <http://127.0.0.1:8080>.

From the control panel you can:

- Run time at up to one simulated hour per second
- Start scenarios, inject faults and turn on random failures
- Inspect and command any miner, or the whole fleet
- Watch hashrate, power, temperature and profit, and export them as CSV

## 3D site view

The **3D site** tab draws the live site as a fenced compound: shipping containers on gravel, a substation with a transformer and switchgear, power runs to each container, light masts, and a road in. Containers are real 20 ft or 40 ft sizes, with evaporative intake walls, racks two to four shelves high either side of a hot aisle, and exhaust through the roof. Walls facing the camera turn see-through, so you can always see inside.

The scenery shows real state. Power runs turn from amber to dark when a container loses power, the switchgear lamp turns red when the breaker opens or the grid fails, and the yard lights come on at dusk if there's power for them. Hot air rises in proportion to each container's heat, and shadows and daylight follow the simulated clock. Tripped machines flash, faulted ones are marked with a triangle.

**Full screen** (or F) fills the screen with the 3D view, with a status bar showing the clock, hashrate, power, fleet and any alert. In full screen, Esc leaves full screen first, as browsers require, and a second press stops walking. The scenario and fault panels aren't available until you exit.

Click **Walk the site** to explore on foot: ↑ and ↓ walk, ← and → turn, A and D sidestep, Shift jogs, dragging looks around, and Esc exits. You start on the road outside the gate. You can't pass through walls, racks, equipment or the fence, but each container has an open door, at the end away from its power run, leading into its hot aisle. Look at a miner within reach to see its live status, and press E for its controls. There's no touch control yet, so it needs a keyboard.

The layout itself is illustrative. It isn't based on a real site's engineering, and past a 40 ft container's capacity, containers simply stretch.

Miners are built from code, in rough real proportions per brand: chassis, vented ends, a PSU on top where the family has one, and fans on both ends. They're stylised from memory rather than accurate replicas, and the Proto R2's shape is a guess. Fans spin with the miner's real fan speed, so a failed one stops. Detail depends on distance: from afar, miners are coloured blocks that read at a glance, and zooming in brings up the fans, guards and bare metal, with a bright LED strip along the top carrying the selected colour.

Click a miner for its details and controls, or a container's label to focus on it and pick it as a fault target. The view uses the panel's live data and colours, and Three.js r170 is included in `public/vendor/three`, so nothing needs installing and it works offline. It only loads when you open the tab.

Position inside a container is only a picture. The model gives every miner in a container the same inlet temperature, so a miner's place in the rack doesn't affect how hot it runs.

## How the model connects

```text
 outdoor temp ──► cooling capacity ──► inlet temp ──► chip temp ──► throttle / trip
                       ▲                                  │               │
                       └────────── heat load ◄─── miner power ◄───────────┤
                                                      │                   ▼
       power price ──► cost ◄── site meter ◄──────────┘    hashrate ──► pool ──► BTC
```

- **Miners** have rated hashrate and power per model, per-unit variation, a thermal model, automatic fan control, work modes, and throttling from 85°C with a cut-out at 100°C. A tripped miner cools and restarts on its own.
- **Containers** have limited cooling. Load above capacity raises inlet temperature for every miner inside, and cooling derates above 35°C outdoors.
- **The grid** has a contract limit that costs a penalty per kWh above it. Staying 25% over for 60 seconds opens the main breaker, and the site stays dark until someone closes it.
- **Pools** credit hashrate through real failover. If every pool is down, machines keep burning power and earn nothing.
- **Markets** have time-of-use power prices and a wandering BTC price.

The same seed and inputs replay the same run, as long as the only commands sent are scripted ones. The default numbers in `src/config.js` are plausible simulation values, not market or vendor data.

## Scenarios

| Scenario | Length | What it tests |
| --- | --- | --- |
| Summer heatwave | 12h | Throttling as outdoor temperature climbs |
| Primary pool outage | 2h | Failover, then a degraded backup |
| All pools down | 2h | Spending power for no revenue |
| Grid curtailment | 5h | Shedding load to avoid penalties |
| Cooling plant failure | 3h | Throttling, then trips, in one container |
| Blackout and recovery | 2h | Fleet restart and a failed network switch |
| Power price spike | 8h | Whether to run through a loss |
| Aging fleet | 24h | Finding sick machines, including quiet failures |
| Overload and breaker trip | 1.5h | Catching an overload within 60 seconds |

To add your own, put a JSON file in `scenarios/`:

```json
{
  "id": "my-test",
  "name": "My test",
  "goal": "What a good response looks like",
  "speed": 60,
  "duration": "02:00:00",
  "events": [
    { "at": "00:10:00", "action": "fault", "type": "fan_failure", "target": "random:5" },
    { "at": "00:30:00", "action": "note", "message": "Something to log" },
    { "at": "01:00:00", "action": "command", "command": "reboot", "target": "container:c1" },
    { "at": "01:30:00", "action": "clear" }
  ]
}
```

Event actions are `fault`, `clear`, `command`, `set`, `resetBreaker` and `note`. Miner targets are `all`, `random:N`, `percent:N`, `model:antminer`, `container:c1` or `miner:c1-m001`. `GET /api/catalog` lists every fault type and its parameters.

## Miners

| Model | Default share | Rated | Protocol | MDK Worker |
| --- | --- | --- | --- | --- |
| Avalon A1346 | 20 | 110 TH/s, 3,300 W | cgminer API over TCP | [`@tetherto/mdk-worker-avalon`](https://github.com/tetherto/mdk/tree/main/backend/workers/miners/avalon) |
| Antminer S21 | 20 | 200 TH/s, 3,420 W | HTTP CGI with Digest auth | [`antminer-mdk-worker`](https://github.com/bitmain-official/antminer-mdk-worker) |
| Whatsminer M50S | 20 | 101 TH/s, 3,268 W | API v3: framed JSON over TCP, with tokens and AES | [`whatsminer-mdk-worker`](https://github.com/whatsminer/whatsminer-mdk-worker) |
| SealMiner A2 | 20 | 231 TH/s, 4,300 W | bdminer JSON over TCP | [`sealminer-mdk-worker`](https://github.com/sealminer/sealminer-mdk-worker) |
| LuxOS on S19 XP | 20 | 140 TH/s, 3,010 W | LuxOS JSON over TCP, with sessions | [`luxos-mdk-worker`](https://github.com/LuxorLabs/luxos-mdk-worker) |
| Proto R2 | 20 | 95.5 TH/s, 3,250 W | HTTP REST with JWT bearer auth | [`proto-tether-mdk-worker`](https://github.com/block/proto-tether-mdk-worker) |

Ratings come from each vendor Worker's mock, except Avalon's, which uses MDK's 30 W/TH nominal. They are simulation defaults, not datasheet values.

To change the fleet, click **Edit fleet** in the control panel, set the containers and miners per brand, and apply. The simulation starts over with the new fleet, and miners may move to different ports. Miners fill the containers in blocks, one brand at a time, and the fleet lasts until the simulator stops.

To start with a particular fleet, use weights on the command line, or `POST /api/fleet` while running:

```bash
node bin/sitesim.js --mix antminer=3,whatsminer=1
node bin/sitesim.js --mix avalon=1
```

Each brand's controls work through its own protocol. A power limit, for example, arrives as a percentage on Whatsminer, a frequency level on Antminer, and watts on SealMiner and Proto. LuxOS has no such command, but its tuning profiles change the work mode.

## Connect MDK

Print the settings for each Worker:

```bash
node bin/sitesim.js mdk-config
```

| Device | Protocol | Default address | MDK Worker |
| --- | --- | --- | --- |
| 120 miners, each on its own port | See [Miners](#miners) | `127.0.0.1:14030-14149` | One per brand |
| SATEC PM180 meter | Modbus TCP | `127.0.0.1:15020` | `@tetherto/mdk-worker-satec` |
| Seneca Z-4RTD-2 sensor, one per container | Modbus TCP | `127.0.0.1:15021-15022` | `@tetherto/mdk-worker-seneca` |
| F2Pool API | HTTP | `http://127.0.0.1:18000` | `@tetherto/mdk-worker-f2pool` |

Avalon's settings use `seedDevices` for its boot function. The vendor-maintained Workers take a `devices` list on `WorkerRuntimeV2`.

Commands from a Worker show up in the event log under that protocol's name, such as `cgminer` or `antminer`, and **Device connections** in the panel shows what is polling.

Each sensor has four channels. Registers 3 to 6 are inlet, exhaust, outdoor and hottest chip.

### Run MDK against it

One setup step, then one command. Both need Node 24 or newer, which is MDK's requirement. The simulator itself only needs Node 22.

```bash
node mdk/setup.js    # once: fetches MDK and the vendor Workers into .mdk
node mdk/start.js    # the simulator, a real Kernel, and a Worker per device family
```

Setup pins MDK to `v0.13.1` and each vendor Worker to the commit MDK's catalogue lists. Install scripts stay off, but the Workers do run on your machine without a sandbox, with your account's access. Use a container or VM if the machine holds anything sensitive.

`start.js` uses a simulator that's already running, or starts one and stops it on exit. If you change the fleet in the panel, it warns you to restart it, because the Workers still hold the old device list.

### See the site through MDK

`mdk/start.js` also runs a small bridge. In the 3D view, switch the data source from **Simulator** to **Through MDK**, and the view shows only what comes out of MDK's Kernel and Workers:

```text
Simulator ──► MDK Workers ──► Kernel ──► Bridge ──► 3D view
```

Each brand's readings are translated to one format in `mdk/normalize.js`. A line below the view compares MDK's picture with what the simulator knows is true, and lists every miner where they differ. A miner's controls go through MDK in this mode, while its dialog's readings, the side panel, scenarios, simulation speed and the fleet editor still talk to the simulator directly.

The MDK view knows less, as it would on a real site. Some of the gaps you'll see:

- **No utility limit, breaker state or per-container fault:** those aren't MDK readings. A silent container shows as a network problem, because MDK can't say why it's silent, and its power run stays amber.
- **Faults MDK doesn't report:** a failed Avalon hashboard still reads as healthy, because of the driver bug described below.
- **Slower updates:** the bridge publishes every second, but readings can be a few seconds old because of Worker caches, so the view lags at high simulation speeds and briefly disagrees during fast changes. The bridge reads each device every three seconds, because reading every second stalled some Worker reads. A device that fails outright reads as unreachable at once, and one that goes silent within about nine seconds, without holding up the others.
- **Fan speeds are approximate:** several Workers report RPM, which is converted using an assumed full speed.

A real site would need its own site map, in the shape of `GET /api/mdk/site-map`, because MDK doesn't know where each miner sits. That map, and the Workers' settings, are what would change.

### Example app: curtailment responder

`mdk/curtailment.js` keeps a site under a utility's power limit using only MDK: it reads power and sends commands through the Kernel. It sleeps the least efficient miners first, and wakes the most efficient first when the limit lifts.

```bash
node mdk/start.js --app curtailment                                  # keep running
node mdk/start.js --app curtailment --scenario curtailment --exit    # score it
```

Scoring takes about 5 minutes and compares the app with the same site and scenario and nothing responding. One run with the default fleet:

| | No app | With app |
| --- | ---: | ---: |
| Revenue | $178.83 | $134.77 |
| Power cost | $112.81 | $78.12 |
| Penalties | $156.97 | $1.03 |
| Over-limit energy | 627.9 kWh | 4.1 kWh |
| **Profit** | **−$90.95** | **$55.63** |

These dollar figures come from the simulator's default prices and penalty, so they show the app working, not what curtailment would cost a real site. Runs vary a little, because the app reacts in real time.

The first version of this app passed its unit tests, then shed miners for no reason against the real stack, because a real SATEC meter only moves in 21.7 kW steps. It now adds up the power each miner reports, and uses the meter only to learn the load miners don't report, such as cooling.

It's an example, so it's deliberately simple. The limit comes from the simulator's API, standing in for a utility's signal. It only uses sleep, not power limits, which would keep more hashrate running. It doesn't remember what it shed across restarts, so anything it put to sleep stays asleep if it stops mid-curtailment.

### Check compatibility

`compat/run.js` runs MDK's real drivers, then a real Kernel, Workers and client, against the simulator. It needs an MDK checkout with its dependencies installed, and Node 24 or newer, which is MDK's own requirement:

```bash
MDK_PATH=/path/to/mdk node compat/run.js
```

To include the vendor-maintained Workers, clone each one into a single directory with its dependencies installed, and add `VENDOR_WORKERS=/path/to/clones`.

**Status: all 166 checks pass against real code, using MDK v0.13.1 and the latest commit of each vendor Worker rather than the commits MDK pins.**

- **Avalon, SATEC, Seneca and F2Pool** run against their real drivers and Workers, with a live Kernel and client.
- **Antminer, Whatsminer, SealMiner, LuxOS and Proto** each run through a real Worker and Kernel. The checks compare hashrate, power and temperature with the model, confirm that board, PSU, fan and pool faults are reported and clear, and test sleep and wake, power control, pool changes and reboot.

A pass means the simulator matches what these Workers expect. It says nothing about how closely it matches physical miners. The other fault types are covered only by this project's own tests.

The check also found three issues in MDK's Avalon driver, which real hardware would hit too:

- **`hashboard_temp_overheating` and the `error_code === '513'` branch of `hashboard_error` can't fire.** `getEStats` stores `error_code` as an array, and `_prepErrors` compares it to a string. Overheating still shows through temperature readings, and a failed board through `HASHS`.
- **`setPools` always fails its login.** It authenticates with `this.username` and `this.password`, which nothing sets, so it sends "undefined". The driver then reboots the miner anyway. The simulator refuses this login, as MDK's own mock does.

- **An offline miner can crash the Worker process.** `setLED(true)` starts a two-minute timer to turn the LED off, with no error handling. If the miner is unreachable when it fires, the error is an unhandled rejection, which ends a Node process with no handler. The check saw the rejection, but didn't test whether MDK's own hosts install a handler.

These are from reading and running the code on MDK's `main` branch, so check whether they've since been fixed.

MDK also refuses two devices at one IP address by default, so the Avalon and Seneca settings include `conf: { allowDuplicateIPs: true }`. Pass that through to their boot functions.

## Control API

The panel uses this API, so you can script anything it does.

| Route | Purpose |
| --- | --- |
| `GET /api/state` | The full site state |
| `GET /api/events` | The same state as a live event stream |
| `GET /api/catalog` | Fault types and scenarios |
| `GET /api/history?window=3600&points=480` | Metric history |
| `GET /api/export.csv` | All history as CSV |
| `GET /api/miners/:id` | One miner in detail |
| `GET /api/mdk/config` | Settings for MDK's Workers |
| `GET /api/fleet` | The current fleet and its limits |
| `POST /api/fleet` | Replace the fleet: `containers`, `minersPerContainer`, `counts` per brand |
| `POST /api/control` | `pause`, `resume`, `reset`, `speed` with `value`, `step` with `seconds` |
| `POST /api/faults` | Inject: `type`, `target`, `params`, `durationSec` |
| `POST /api/faults/clear` | Clear by `id` or `groupId`, or `all: true` |
| `POST /api/miners/command` | `ids`, `action` (`sleep`, `wake`, `reboot`, `mode`, `powerPct`, `fan`, `led`, `repair`), `value` |
| `POST /api/site` | `contractKw`, `resetBreaker`, `chaos` |
| `POST /api/scenarios/start` and `/stop` | Run or end a scenario, by `id` |

```bash
curl -X POST localhost:8080/api/faults -H 'content-type: application/json' \
  -d '{"type":"fan_failure","target":"random:5","durationSec":3600}'
```

The API has no login. It binds to `127.0.0.1` by default and refuses requests sent from other websites. Don't bind it to a shared network unless you trust everyone on that network.

## Batch runs

Headless mode runs as fast as it can. Simulating a day takes about 3 seconds on a laptop:

```bash
node bin/sitesim.js --headless --scenario curtailment --seed 7 --out run.csv
node bin/sitesim.js --headless --duration 168:00:00 --out week.json
```

It prints a JSON summary of energy, revenue, cost and penalties, which makes it easy to compare strategies across seeds.

## Options

Run `node bin/sitesim.js --help` for all flags. To change anything else, such as fleet size, power prices or thermal limits, pass a JSON file with `--config` that overrides values from `src/config.js`:

```json
{ "fleet": { "containers": 4, "minersPerContainer": 100 }, "environment": { "pricePeak": 0.12 } }
```

## Limits worth knowing

- **One model per brand.** Each family is one representative model, although some Workers cover many. Water-cooled SealMiners, for example, report different fields and aren't modelled.
- **Device extras are partial.** Log downloads and firmware updates aren't simulated on any brand. Whatsminer's API v2 isn't simulated either, so its settings pin API v3. Settings with no physical effect, such as hostname and timezone, are accepted and ignored.
- **Error codes are illustrative.** Faults appear in the fields each Worker reads, but the LuxOS, Antminer and Proto codes are made up for the simulator. Whatsminer's come from its Worker's table, but aren't confirmed against what firmware sends in each case.
- **The meter is coarse by design.** One step of the SATEC power register is about 21.7 kW, as in MDK's driver, so small fleets look jumpy through it. The panel shows true power.
- **Pool API times use the real clock.** MDK's pool Worker queries by real time, so sped-up runs fit more simulated days into less pool history.
- **Mode changes apply at once.** Avalon's real driver reboots a miner after changing mode, so via MDK you'll still see that reboot.
- **Thermal and economic models are approximations.** They are good for testing software behaviour, not for predicting a real site's output or profit.

## Project layout

```text
bin/sitesim.js     Command line
src/engine/        The model: site, miner models, faults, scenarios, environment
src/protocols/     Device servers: one per miner brand, plus Modbus, SATEC, Seneca, F2Pool
src/server/api.js  Control API and event stream
src/runner.js      Runs the model in real time and hosts the servers
mdk/               Setup, one-command start, and the example curtailment app
public/            Control panel, the 3D view, and a local copy of Three.js
scenarios/         Scenario definitions
compat/run.js      Checks against real MDK code
test/              Run with: npm test
```
