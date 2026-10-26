# Akadian Maps

3D campus maps with room-level directions. Prototype: George Mason University, with the 3D campus outdoors and four buildings indoors: the Johnson Center (4 floors, ~320 rooms), Research Hall (floors 1–4, ~235 rooms), Merten Hall (floor 1) and The HUB (lower level).

There are two parts:

- **The app** (`app/`): what students use. It shows the campus in 3D on a clean dark map and gets you to the right entrance by GPS. From there it shows a 3D route inside the building to the room. It's read-only: no uploads, no downloads.
- **The engine** (`engine/`): the private, self-hosted studio where **you** turn schematics into maps. Schematics never leave the machine it runs on.

## Run it

You need Python 3.11+. Node is only needed to run `tests/test_parking.mjs`.

**1. Install**

```bash
pip install -r engine/requirements.txt
```

**2. Get GMU's public floor plans.** These belong to GMU, so they aren't stored in the repo. This downloads them from GMU's Student Centers site:

```bash
python tools/fetch_gmu_sources.py
```

**3. Build and publish the GMU demo maps.** This builds the four indoor maps, the campus layer and the self-hosted basemap tiles into `engine_data/published/`:

```bash
python tools/seed_gmu.py --publish-only
```

**4. Start the engine:**

```bash
python -m engine serve
```

- Public map: http://localhost:8080
- Admin studio: http://127.0.0.1:8081 (only reachable from this machine)

The first time you open the studio, you create your passphrase. To also load the four buildings into your vault as editable projects, run `python tools/seed_gmu.py` (without `--publish-only`) and enter your passphrase.

**Tests:**

```bash
python tests/test_engine.py
node tests/test_parking.mjs
```

`engine_data/` is in `.gitignore` on purpose: it holds your vault and encrypted schematics. Never commit it.

## Privacy model

The engine is built so that a school's non-public schematics can be processed without handing them to anyone, Claude included.

| | Where it lives | Who can see it |
|---|---|---|
| Schematics (PDF/images), plan renders, OCR text, labels, settings | `engine_data/projects/` and `engine_data/campuses/`, **encrypted** (Fernet/AES with a key derived from your passphrase via scrypt) | Only you, while the studio is unlocked |
| Compiled maps (room outlines, numbers/names, walkable grid) | `engine_data/published/` | Everyone, through the public app, but only after you press Publish |

- **Local processing:** OCR runs on-device (RapidOCR/ONNX) and geometry runs through OpenCV. The engine only goes online when you press a button that fetches public data: OpenStreetMap outlines, entrances and paths, or the basemap tile download. Schematic data is never sent.
- **Locked-down studio:** it binds to `127.0.0.1` and needs your passphrase. Sessions are HttpOnly, SameSite=Strict cookies. Changes need a custom header and a same-origin check, which blocks cross-site requests. Repeated wrong passphrases trigger a lockout. To use it on a server, reach it through an SSH tunnel, never by opening the port.
- **Restricted rooms:** marking a room restricted keeps its number and name out of the published map. It shows only as an unlabeled block, can't be searched, and has no route.
- **Read-only public server:** it serves only the app and published JSON. It has no route to schematics, plan images or OCR.
- **No recovery:** a lost passphrase means the encrypted projects can't be opened. Published maps keep working.
- **Your responsibility:** don't paste private schematics into chat tools, Claude included. Import them in the studio. If `engine_data/` sits in a synced folder (like OneDrive), only ciphertext gets synced, but keep it somewhere you control.

## Making a new building map (in the studio)

1. **Buildings → New building.** Give it a name, an ID and a campus ID.
2. **Floors:** import each floor's PDF or image with a level and room prefix (`G`, `1`, `2`…). Room numbers can have 3 digits (`214`) or 4 (`1201A`); the engine tells which from the plan. The engine renders it and reads labels with OCR. Use **Align** to overlay each floor on the reference floor; auto-align, then nudge.
3. **Plan editor:** fix or rename labels, and give public names (e.g. "Math Tutoring Center"). Then:
   - mark **Open to below** inside each atrium piece
   - drag **Exclude area** over title blocks and legends
   - place **Entrance** door points
   - mark sensitive rooms **Restricted**
4. **Entrances:** set at least two entrances' coordinates. **Look up** on OpenStreetMap fills them from the building's tagged entrances. If a building has fewer than two tagged entrances, the engine places the plan by fitting its outline to the building's OpenStreetMap footprint (scale, rotation and position; within about a metre on GMU's buildings). For a plan that covers only part of the footprint, like a lower level under one wing, set `footprint_partial` in the project settings (the GMU seed does this for The HUB).
5. **Build & publish:** build, check the walkable-grid preview, then publish.
6. **Campuses:** create the campus from its OSM boundary way, fetch, list residence halls and athletics buildings, link the building's OSM ID to your indoor map, and publish.

## The app

- **Getting around the app:**
  - One search box covers rooms, buildings, food and bus stops. Exact room numbers rank first, and Enter opens the top result.
  - Category buttons cover Food, Bus, Restrooms, Study rooms, Computer labs and Buildings.
  - "Explore the map" opens the map without a destination.
  - The last 5 places are kept on the device as Recent.
  - The phone's back gesture, the browser's back button and Esc all step back a screen.
  - A loading screen shows while the map loads, and a clear error with "Try again" appears if it can't.
- **Map screen:**
  - Routes show the total trip time first. Distances are in feet and miles for US users, metres elsewhere.
  - "Use my location" retries GPS.
  - "Share this place" uses the phone's share sheet, or copies the link.
  - The Layers panel is collapsible, and collapsed by default on phones.
- **Installable and offline:**
  - The app can be added to a phone's home screen (manifest and icons).
  - A service worker keeps it working with a weak campus signal. App files load fresh when online, and libraries, tiles and fonts come from the cache.
- **Accessibility:**
  - Keyboard focus outlines, labelled buttons, and lists you can use with the keyboard.
  - Animations, auto-rotation and camera flights are turned off when the device's "reduce motion" setting is on.
- **Performance:**
  - Indoor routing runs in a background worker (`app/js/route-worker.js`), so picking a room never freezes the screen.
  - The 3D views and Three.js load only when first opened, and start loading early once you pick a room.
  - The server gzips responses: about 0.5 MB on first visit, down from about 3.4 MB.
  - 3D rendering is capped at 1.5× pixel density on phones.
  - Search tolerates typos ("chipolte" → Chipotle), and the Step-free setting is remembered on the device.
- **Self-contained:** the public app loads nothing from outside your server. Map tiles and fonts for the campus area are downloaded once by the engine (studio: Campuses → Download basemap). MapLibre and Three.js are bundled in `app/vendor/`.
- **Walking routes:** the engine compiles OpenStreetMap sidewalks, footpaths and crossings into a walking network. The app routes on it to whichever entrance gives the shortest total trip (outside + inside), and redraws the route as GPS updates. Step-free mode avoids stairs outdoors too. Turn-by-turn steps ("Turn left and cross Rivanna River Lane at the crosswalk", "Bear left onto the path by The HUB, passing David King Hall") list under the route. Tap one to fly the map there.
- **Bus & shuttle:** stops and route lines from OpenStreetMap (CUE Green/Gold, Metrobus F23/F29/F50, the Mason Shuttles stops at the GMU Campus hub), drawn in each line's own color. Stops show which lines serve them and offer walking directions. Unnamed stops are named after their road and nearest building.
- **Food & coffee:** 25 spots from OpenStreetMap (Panda Express, Manhattan Pizza, Starbucks, Dunkin', Chick-fil-A, the Johnson Center food court…). Each card shows the type, building and hours, and spots search by name or cuisine. Spots inside a building with an indoor map get indoor directions to the counter. Floors that OSM doesn't record go in the studio's campus hints (e.g. `Starbucks@Johnson Center: 0`).
- **Tap any building for its 3D model.** Buildings with an indoor map (the Johnson Center, Research Hall, Merten Hall, The HUB) open straight into it. Every other building gets a 3D model from its real outline, at true scale. It has a glass floor per level in its category color, floor buttons to isolate a level, and pins for the food spots inside. Parking decks show open levels on pillars, with your car on its level if you saved it there. The card lists food inside, bus stops within 250 m, and "Walk here". Link: `?view=<OSM id>`.
- **Parking spot saver:** "Save where I parked" records your spot, the deck level and an optional note, stored only on the device (localStorage). Nothing goes to the server. When GPS sees you go from driving to walking inside a campus lot, the app offers to save the spot. "Walk to car" gives turn-by-turn directions back, ending with "Go up to Level 3 of …". The car is drawn as a small glowing orange 3D model at its exact spot and level, lined up with the lot's rows, with no label. On the campus map, the deck holding it turns to glass so the car shows through. In the deck's 3D view, the camera flies straight to the car's level. A "My car" button sits on the map.
- **Outdoor:** MapLibre with a custom dark vector style:
  - Campus buildings are 3D. Everything off campus is flat.
  - Color filters for academic, residence halls, parking (highlighted), arena & athletics, and sports fields.
  - Road names appear from zoom 16 (main roads) and 17 (campus streets). Building and lot names fade in as you zoom.
- **Indoor:** Three.js, using clean vector rooms at true scale with glowing outlines and a flowing route. Search covers rooms and restrooms in every mapped building ("restroom research", "1214"). Each building gets its own 3D view on first visit, and only the one on screen renders. Hover a room to see its name; click it to route there. A step-free toggle keeps routes to elevators.
- **Deep links** (good for QR codes): `?to=344` for a room in the main building (the Johnson Center), `?to=405&in=gmu-research` for a room in another building, `?b=<OSM id>` for a building, `?campus=<id>`.
- **Theme:** Memex (charcoal + `#f0a04a`). Tokens are in `app/style.css` and `THEME` in `app/js/indoor3d.js`.

## Layout

```
app/                    public web app (served by the engine)
engine/                 private engine: server.py, vault.py, store.py, pipeline/, admin_ui/
engine_data/            engine home (encrypted projects + public published maps)
tools/fetch_gmu_sources.py  downloads GMU's public floor plans (not stored in git)
tools/prepare_building.py  renders + OCRs a building's plan PDFs (room labels to check by hand)
tools/seed_gmu.py       loads the GMU demo from public sources
tests/test_engine.py    end-to-end engine test (temp folder)
tests/test_parking.mjs  parking auto-prompt + on-device storage (node)
data/gmu/               public GMU sources: floor plan PDFs, directories, OSM extracts
```

## Known limits

- GMU publishes plans for only part of some buildings:
  - Merten Hall: floor 1 only.
  - The HUB: the lower level only.
  - Research Hall: the lower level is left out; GMU's PDF shows only a sliver of mechanical space, cut off at the page edge.
  - Horizon, Peterson, Exploratory and Planetary: no public plans. Import them privately in the studio if GMU supplies them.
- Research Hall, Merten Hall and The HUB show room numbers only (no public directory of names). They are placed on the map by fitting their outline to OpenStreetMap, since OSM tags only one of their entrances.
- A food spot whose floor isn't known gets indoor directions only when its building is fully mapped (the JC). In Merten Hall and The HUB you get walking directions to the building.
- The JC floor plans are from 2020. Room names come from the 2023 directories.
- Most campus footpaths are unnamed in OpenStreetMap. Outdoor directions name the road a sidewalk runs along or a crosswalk crosses, and otherwise use nearby buildings as landmarks. A few crosswalks still read "cross the street".
- The basemap covers the campus plus about 3 km around it; the map can't be panned beyond that.
- The parking auto-prompt only works while the app is open: a website can't watch GPS in the background. Deck levels are picked by hand, because GPS can't tell levels apart.
- Bus, shuttle and food data is only as good as OpenStreetMap. Mason Shuttles route lines aren't mapped there, and some hours are wrong (e.g. Panda Express). The studio can't override names, hours or positions yet, only food-spot floors.
- Building heights are estimated where OpenStreetMap has no floor counts. Adjust them in the campus settings.
