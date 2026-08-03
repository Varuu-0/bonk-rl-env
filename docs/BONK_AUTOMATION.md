# bonk.io Browser Automation Documentation

Complete reference for automating bonk.io via Playwright or browser console.

**Last updated:** August 3, 2026
**Account:** Angelet (Lv 6)

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Pre-load Capture Bootstrap](#15-pre-load-capture-bootstrap)
3. [Login Workflow](#2-login-workflow)
4. [Custom Game Workflow](#3-custom-game-workflow)
5. [Map Selection Workflow](#4-map-selection-workflow)
6. [Element ID Reference](#5-element-id-reference)
7. [Known Issues](#6-known-issues)
8. [Reusable Script](#7-reusable-script)

---

## 1. Architecture

### Page Structure

```
https://bonk.io/                    ← Main page
  └─ <iframe id="maingameframe">    ← Game iframe (gameframe-release.html)
       └─ alpha2s.js                ← Obfuscated game code (~2.7MB)
       └─ M$QCc                    ← Runtime constant table (1724 entries)
```

### Accessing the Game

```js
// From the main page or Playwright:
const iframe = document.getElementById('maingameframe');
const gameDoc = iframe.contentDocument;   // DOM access
const gameWin = iframe.contentWindow;     // JS context (M$QCc, etc.)
```

### Key Global Objects

| Object | Location | Purpose |
|--------|----------|---------|
| `M$QCc` | `gameWin` | String constant table (1724 entries) |
| `bonkCodeInjectors` | `gameWin` | Array of code injector functions (set by codeinjector.js) |
| `bonkHost` | `gameWin` | Set by bonkhost.js after injection |
| `__bonkExportState` | `gameWin` | Set by mapexporter.js injector |
| `__bonkExportGameSettings` | `gameWin` | Set by mapexporter.js injector |
| `__bonkExportWorld` | `gameWin` | Set by mapexporter.js injector |

### 1.5 Pre-load Capture Bootstrap

Map capture must install `Webscripts/capture-init.js` before navigating. It is a
document-start bootstrap that intercepts `alpha2s.js`, records the per-tick
state and game settings, and exposes the same globals consumed by
`mapexporter.js`. It is intentionally narrow: on an anchor or fetch failure it
loads the original game script unchanged.

```js
await context.addInitScript({ path: 'Webscripts/capture-init.js' });
await page.goto('https://bonk.io/');
```

After the game iframe has loaded, add `Webscripts/mapexporter.js` to that frame
to provide the export button. The exporter can then consume the state captured
by the bootstrap even though it was added after `alpha2s.js` loaded. Verify the
marker `gameWin.__bonkCaptureInitV1 === true` and that
`gameWin.__bonkExportState` becomes non-null before beginning a capture.

`scripts/check-webscript-ids.js` validates the static room-list, lobby, and map
picker IDs used by the capture workflow against the retained DOM fixtures.

### Screen States

The game has several screen states, determined by which containers are visible:

| State | Key Elements Visible |
|-------|---------------------|
| **Login** | `guestOrAccountContainer`, `loginwindow` |
| **Auto-login** | `autoLoginContainer` (shows "Welcome Back") |
| **Main Menu** | `classicmenu`, `pretty_top`, `pretty_bottom` |
| **Game Choice** | `sm_gameChoiceWindow` (Simple/Classic/Arrows/Grapple/Custom) |
| **Connecting** | `sm_connectingWindow` ("Connecting to server...") |
| **Game Lobby (Host)** | `newbonklobby`, `newbonklobby_settingsbox` |
| **Playing** | `gamerenderer` (visibility=inherit) |
| **Map Picker** | `maploadwindow` |
| **Room List** | `roomListContainer` |

---

## 2. Login Workflow

### Step-by-Step

```js
// 1. Navigate to bonk.io
await page.goto('https://bonk.io/');
await page.waitForTimeout(5000);

// 2. Cancel auto-login (if "Welcome Back" appears)
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const cancelBtn = doc.getElementById('autoLogin_cancelButton');
  if (cancelBtn && cancelBtn.offsetParent !== null) cancelBtn.click();
});
await page.waitForTimeout(3000);

// 3. Click "Login or Register"
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('guestOrAccountContainer_accountButton').click();
});
await page.waitForTimeout(1500);

// 4. Fill credentials using Playwright fill (more reliable than native setters)
const frame = page.frameLocator('#maingameframe');
await frame.locator('#loginwindow_username').fill('Angelet');
await frame.locator('#loginwindow_password').fill('Parmar@2005');
await page.waitForTimeout(300);

// 5. Check "Stay logged in"
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const cb = doc.getElementById('loginwindow_remember_checkbox');
  if (cb && !cb.checked) cb.click();
});
await page.waitForTimeout(300);

// 6. Click "Log In"
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('loginwindow_submitbutton').click();
});

// 7. Wait for login (5-8 seconds)
await page.waitForTimeout(8000);
```

### Verification

```js
const isLoggedIn = await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const loginWindow = doc.getElementById('loginwindow');
  const classicMenu = doc.getElementById('classicmenu');
  const topBar = doc.getElementById('pretty_top_name')?.textContent?.trim();
  return {
    loginGone: !loginWindow?.offsetParent,
    menuVisible: classicMenu?.getBoundingClientRect()?.width > 100,
    username: topBar,
  };
});
// isLoggedIn.username should be "Angelet"
```

### Notes

- The password field sometimes doesn't accept native setter input. Use Playwright's `fill()` method.
- Auto-login ("Welcome Back") appears if "Stay logged in" was checked previously. Cancel it first.
- Login takes 5-8 seconds server-side.

---

## 3. Custom Game Workflow

### Step-by-Step

```js
// 1. Click "Custom Game" from main menu
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('classic_mid_customgame').click();
});
await page.waitForTimeout(2000);

// 2. Click "Custom Game" in the game choice window
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('sm_gameChoiceCustom').click();
});

// 3. Wait for connection + lobby (can take 10-45 seconds)
// Poll for newbonklobby to appear with non-zero dimensions
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const ready = await page.evaluate(() => {
    const doc = document.getElementById('maingameframe').contentDocument;
    const lobby = doc.getElementById('newbonklobby');
    const rect = lobby?.getBoundingClientRect();
    return rect && rect.width > 100 && rect.height > 100;
  });
  if (ready) break;
}
```

### Known Issue: Connection Hanging

The `sm_connectingWindow` sometimes shows "Connecting to server...test" indefinitely. This appears to be a server-side issue, not a client-side problem. Possible causes:
- Server capacity limits
- Rate limiting on account creation
- The "test" text suggests the game is in a debug/test mode

**Workaround:** Cancel the connection and retry, or try creating via the room list instead.

### Alternative: Room List Creation

```js
// Click "Create" in the room list
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('roomlistcreatebutton').click();
});
await page.waitForTimeout(500);

// Fill the create game form using native JS (Playwright fill fails on hidden elements)
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  
  const nameInput = doc.getElementById('roomlistcreatewindowgamename');
  setter.call(nameInput, 'BonkBot Research');
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  
  const maxPlayers = doc.getElementById('roomlistcreatewindowmaxplayers');
  setter.call(maxPlayers, '2');
  maxPlayers.dispatchEvent(new Event('input', { bubbles: true }));
  
  // Check unlisted
  const unlisted = doc.getElementById('roomlistcreatewindowunlistedcheckbox');
  if (unlisted && !unlisted.checked) unlisted.click();
});

// Click Create
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('roomlistcreatecreatebutton').click();
});
```

---

## 3.5. Game Lobby Configuration

### Setting Game Mode

After creating a custom game and the lobby appears, set the game mode:

```js
// Open mode menu and select grapple
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  doc.getElementById('newbonklobby_modebutton').click();
});
await page.waitForTimeout(500);

// Click the specific mode
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('newbonklobby_mode_grapple').click();
});
await page.waitForTimeout(500);
```

Mode button IDs:
| Mode | Element ID |
|------|-----------|
| Classic | `newbonklobby_mode_classic` |
| Arrows | `newbonklobby_mode_arrow` |
| Death Arrows | `newbonklobby_mode_deatharrows` |
| Grapple | `newbonklobby_mode_grapple` |
| VTOL | `newbonklobby_mode_vtol` |
| Football | `newbonklobby_mode_football` |

### Toggling Teams

```js
// Toggle teams (for Weird Death Ball: teams ON)
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const teamsText = doc.getElementById('newbonklobby_teams_middletext')?.textContent?.trim();
  const teamsOff = teamsText?.toLowerCase().includes('off');
  if (teamsOff) {
    doc.getElementById('newbonklobby_teamsbutton').click();
  }
});
```

### Starting the Match

```js
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('newbonklobby_startbutton').click();
});
await page.waitForTimeout(5000); // Wait for match to load
```

---

## 4. Map Selection Workflow

### Opening the Map Picker

```js
// Once in the game lobby (newbonklobby is visible):
await page.evaluate(() => {
  document.getElementById('maingameframe').contentDocument
    .getElementById('newbonklobby_mapbutton').click();
});
await page.waitForTimeout(2000);
```

### Map Picker Structure

The `maploadwindow` contains tabs for different map sources. Expected tab IDs:
- `maploadwindow_*` prefix for all elements
- Search input: `maploadwindowsearchinput`
- Hotness slider: `maploadwindowhotnesssliderinput`

### Selecting a Favorited Map

Once the map picker is open, click the "Favorites" tab, then find the map by name:

```js
// Click Favorites tab (text-based search)
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const tabs = doc.querySelectorAll('div, span');
  for (const tab of tabs) {
    if (tab.offsetParent !== null && 
        tab.textContent.trim().toLowerCase().includes('favorites')) {
      tab.click();
      break;
    }
  }
});
await page.waitForTimeout(1000);

// Find and click the map by name
await page.evaluate((mapName) => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const items = doc.querySelectorAll('div, span, p');
  for (const item of items) {
    if (item.offsetParent !== null && 
        item.textContent.trim().toLowerCase().includes(mapName.toLowerCase())) {
      item.click();
      break;
    }
  }
}, 'grapple 1v1 simple');
await page.waitForTimeout(2000);

// Click "Load" or "Done" to apply
await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const btns = doc.querySelectorAll('div.brownButton');
  for (const btn of btns) {
    if (btn.offsetParent !== null) {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes('load') || text.includes('done') || text.includes('play')) {
        btn.click();
        break;
      }
    }
  }
});
```

### Target Maps

| Map Name | Purpose |
|----------|---------|
| `grapple 1v1 simple` | Grapple mode training |
| `Weird Death Ball` | Death ball map |

---

## 5. Element ID Reference

### Login Screen

| ID | Element | Notes |
|----|---------|-------|
| `guestOrAccountContainer` | Main login/guest container | visibility:hidden when logged in |
| `guestOrAccountContainer_accountButton` | "Login or Register" button | |
| `guestOrAccountContainer_guestButton` | "Play as Guest" button | |
| `autoLoginContainer` | Auto-login overlay | "Welcome Back" |
| `autoLogin_cancelButton` | Cancel auto-login | |
| `loginwindow` | Login window container | |
| `loginwindow_username` | Username input | Use Playwright fill() |
| `loginwindow_password` | Password input | Use Playwright fill() |
| `loginwindow_remember_checkbox` | "Stay logged in" checkbox | |
| `loginwindow_submitbutton` | "Log In" submit button | |

### Main Menu

| ID | Element |
|----|---------|
| `classicmenu` | Main menu container |
| `classic_mid_quickplay` | "Quick Play" button |
| `classic_mid_customgame` | "Custom Game" button |
| `classic_mid_news` | "News" button |
| `classic_mid_skins` | "Skins" button |
| `classic_mid_friendlist` | "Friend List" button |
| `classic_mid_tutorial` | "Tutorial" button |
| `pretty_playbutton` | PLAY tab (bottom bar) |
| `pretty_top_name` | Username display |
| `pretty_top_level` | Level display |

### Game Choice Window

| ID | Element |
|----|---------|
| `sm_gameChoiceWindow` | Game mode selection container |
| `sm_gameChoiceSimple` | "Simple" mode |
| `sm_gameChoiceClassic` | "Classic" mode |
| `sm_gameChoiceArrows` | "Arrows" mode |
| `sm_gameChoiceGrapple` | "Grapple" mode (Coming Soon™) |
| `sm_gameChoiceCustom` | "Custom Game" mode |

### Connection Window

| ID | Element |
|----|---------|
| `sm_connectingWindow` | Connection status window |
| `sm_connectingWindow_topbar` | Title bar ("Creating Game") |
| `sm_connectingWindow_text` | Status text |
| `sm_connectingWindowCancelButton` | Cancel button |

### Game Lobby (Host)

| ID | Element |
|----|---------|
| `newbonklobby` | Lobby container |
| `newbonklobby_settingsbox` | Settings panel |
| `newbonklobby_mapbutton` | Map selection button |
| `newbonklobby_maptext` | Current map name |
| `newbonklobby_mapauthortext` | Current map author |
| `newbonklobby_modebutton` | Game mode button |
| `newbonklobby_teamsbutton` | Teams toggle |
| `newbonklobby_startbutton` | Start game button |
| `newbonklobby_editorbutton` | Map editor button |
| `newbonklobby_readybutton` | Ready button |
| `newbonklobby_roundsinput` | Rounds to win input |

### Game Mode Options

| ID | Mode |
|----|------|
| `newbonklobby_mode_classic` | Classic |
| `newbonklobby_mode_arrow` | Arrows |
| `newbonklobby_mode_deatharrows` | Death Arrows |
| `newbonklobby_mode_grapple` | Grapple |
| `newbonklobby_mode_vtol` | VTOL |
| `newbonklobby_mode_football` | Football |

### In-Game

| ID | Element |
|----|---------|
| `gamerenderer` | Game canvas container (visibility=inherit when playing) |
| `ingamecountdown` | Round countdown |
| `ingamemapcredit` | Map name/author display |
| `ingamechatbox` | Chat box |
| `ingamevotewindow` | Map vote (upvote/downvote) |
| `ingametextwarnings` | Warning messages |
| `leaveconfirmwindow` | Leave game confirmation |
| `leaveconfirmwindow_okbutton` | Confirm leave |
| `leaveconfirmwindow_cancelbutton` | Cancel leave |
| `hostleaveconfirmwindow` | Host leave confirmation |
| `hostleaveconfirmwindow_okbutton` | Confirm leave (host) |
| `hostleaveconfirmwindow_endbutton` | End room (host) |

### Map Picker

| ID | Element |
|----|---------|
| `maploadwindow` | Map picker container |
| `maploadwindowsearchinput` | Search input |
| `maploadwindowhotnesssliderinput` | Hotness filter slider |

### Room List

| ID | Element |
|----|---------|
| `roomListContainer` | Room list container |
| `roomlistscrollbox` | Scrollable room list |
| `roomlistcreatebutton` | "Create" button |
| `roomlistcreatewindow` | Create game form |
| `roomlistcreatewindowgamename` | Game name input |
| `roomlistcreatewindowpassword` | Password input |
| `roomlistcreatewindowmaxplayers` | Max players input |
| `roomlistcreatewindowminlevel` | Min level input |
| `roomlistcreatewindowmaxlevel` | Max level input |
| `roomlistcreatewindowunlistedcheckbox` | Unlisted room checkbox |
| `roomlistcreatecreatebutton` | Create game submit button |

### Map Editor

| ID | Element |
|----|---------|
| `mapeditorcontainer` | Editor container |
| `mapeditor` | Editor main |
| `mapeditor_leftbox` | Elements sidebar |
| `mapeditor_leftbox_createmenu_spawn` | Add spawn |
| `mapeditor_leftbox_createmenu_capzone` | Add cap zone |
| `mapeditor_leftbox_createmenu_platform_s` | Stationary platform |
| `mapeditor_leftbox_createmenu_platform_d` | Moving (dynamic) platform |
| `mapeditor_leftbox_createmenu_platform_np` | No-physics platform |
| `mapeditor_midbox_playbutton` | Play test button |
| `mapeditor_rightbox_table_friction` | Friction input |
| `mapeditor_rightbox_table_restitution` | Restitution input |
| `mapeditor_rightbox_table_density` | Density input |
| `mapeditor_rightbox_table_forcezone` | Force zone checkbox |
| `mapeditor_rightbox_table_collideP` | Collide with players |
| `mapeditor_rightbox_table_collideA` | Collide group A |
| `mapeditor_rightbox_table_collideB` | Collide group B |
| `mapeditor_rightbox_table_collideC` | Collide group C |
| `mapeditor_rightbox_table_collideD` | Collide group D |

---

## 6. Known Issues

### Connection Hanging

When creating a custom game, the `sm_connectingWindow` shows "Connecting to server...test" and may hang indefinitely. This is a **persistent server-side issue** — bonk.io's custom game servers frequently reject or timeout new room creation. This has been confirmed across multiple attempts on July 25-26, 2026.

**The workflow itself is correct** — the issue is purely server availability:
1. Click `classic_mid_customgame` → game choice window appears ✅
2. Click `sm_gameChoiceCustom` → connecting window appears ✅
3. Server never responds → lobby never appears ❌

**Workarounds:**
- Keep retrying (sometimes works after multiple attempts)
- Use Quick Play instead (connects to existing rooms, more reliable)
- Host a Manifold server locally (`E:\Projects\manifold-server`) and use the Manifold client mod to redirect the connection to localhost
- Ask another user to create the room and share the invite link

### Password Field Input

The `loginwindow_password` field sometimes doesn't accept values set via native input setters (`Object.getOwnPropertyDescriptor`). Use Playwright's `fill()` method instead, which properly triggers all required events.

### Visibility Detection

Many bonk.io UI elements have `offsetParent !== null` even when hidden (they use `opacity:0` or `visibility:hidden` instead of `display:none`). Always check `getBoundingClientRect()` dimensions AND `style.visibility` / `style.opacity` for reliable visibility detection:

```js
function isReallyVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return false;
  if (el.style.visibility === 'hidden') return false;
  if (parseFloat(el.style.opacity) === 0) return false;
  return true;
}
```

### Overlapping UI Layers

The game has many UI layers that overlap (login, auto-login, quick play, room list, settings, etc.). Clicking buttons that are "visible" by `offsetParent` may click the wrong layer. Always ensure the target element's parent container is the topmost visible one.

---

## 7. Reusable Script

The full automation library is in `Webscripts/bonkbot.js`. Key functions:

```js
// Load the script first (paste into console or inject via Playwright)
// Then use:

BonkBot.login();                    // Login with stored credentials
BonkBot.navigate('room-list');      // Open the Custom Game room list
BonkBot.navigate('custom-lobby');   // Create a custom-game lobby
BonkBot.navigate('map-picker');     // Open the lobby map picker
BonkBot.navigate('map-favorites');  // Open the picker with MY FAVS selected
BonkBot.navigate('map-editor');     // Open the lobby map editor
BonkBot.navigate('match', {         // Configure, load, and start a match
  mapName: 'grapple 1v1 simple',
  mode: 'grapple',
  teams: false,
});
BonkBot.createCustomGame();         // Create custom game
BonkBot.openMapPicker();            // Open map selection
BonkBot.selectFavoriteMap('name');  // Select a favorited map
BonkBot.selectMapSource('hot');     // Select a map-picker source
BonkBot.loadMap('name');            // Full workflow: login → game → map
BonkBot.extractMapData('name');     // Extract map + physics data
BonkBot.searchConstantTable('Step'); // Search constant table
BonkBot.lookupConstant(327);        // Lookup constant by index
BonkBot.searchSource('ppm:12');     // Search alpha2s.js source
BonkBot.setGameMode('grapple');     // Set game mode in lobby
BonkBot.setTeams(true);             // Toggle teams on/off
BonkBot.startMatch();               // Start the match
BonkBot.isInMatch();                // Check if in active match
BonkBot.probePlayerDiscs();         // Read all disc positions/teams
BonkBot.identifyLocalPlayer();      // Identify local player + all disc data
BonkBot.getMapCredit();             // Get current map name/author
BonkBot.getCountdown();             // Get round countdown text
```

`navigate(page, options)` is the preferred route dispatcher for Bonk UI screens. It accepts these page names and aliases:

| Page | Aliases | Notes |
|------|---------|-------|
| `main-menu` | `menu` | Verifies that the main menu is already open. Leaving a live room remains an explicit user action. |
| `room-list` | `rooms` | Opens Custom Game from the main menu. |
| `custom-lobby` | `lobby`, `custom` | Creates and waits for a hosted custom lobby. |
| `map-picker` | `maps` | Creates a lobby if needed, then opens map selection. |
| `map-favorites` | `favorites`, `favourites` | Opens the picker and selects `MY FAVS`. |
| `map-editor` | `editor` | Creates a lobby if needed, then opens the editor. |
| `match` | `game` | Creates a lobby, optionally applies `mapName`, `mode`, and `teams`, then starts. |

`options.timeout` overrides the default navigation timeout in milliseconds. `mode` and `teams` can also be supplied when navigating to the lobby, map picker, or editor. For new lobbies, `roomName`, `maxPlayers`, and `unlisted` are passed to the actual `roomlistcreatewindow` form.

The map picker has no Favorites tab. Favorites is the `MY FAVS` dropdown option (`#maploadtypedropdownoption10`). `selectFavoriteMap()` selects that source and then matches the requested name against `.maploadwindowmapdiv > .maploadwindowtextname`.

### Account Credentials

```
Username: Angelet
Password: Parmar@2005
```

These are stored in `BonkBot.CONFIG.account` in `bonkbot.js`.

---

## 8. Player Identity & Live Gameplay

### How Player Identity Works

The game identifies the local player via `localPlayerID` (constant table index 1564). This maps directly to an index in the `discs` array:

```
state.discs[localPlayerID]  →  your disc's data
```

Key constants for player identity:

| Index | String | Purpose |
|-------|--------|---------|
| 1564 | `localPlayerID` | Which disc index is "you" |
| 1119 | `playerID` | Disc-to-player mapping on render objects |
| 1668 | `localSpawnedYet` | True once you've spawned |
| 856 | `playerArray` | Array of all players |
| 634 | `hostID` | Host's player ID |
| 771 | `peerID` | PeerJS connection ID |

### Spectating Detection

When `localSpawnedYet` is false, the element `ingametextwarning_spectating` is visible. Check it:

```js
const isSpectating = await page.evaluate(() => {
  const doc = document.getElementById('maingameframe').contentDocument;
  const el = doc.getElementById('ingametextwarning_spectating');
  return el && el.getBoundingClientRect().width > 10;
});
```

### Team System

Disc objects have a `team` field with numeric values:

| Value | Team |
|-------|------|
| 0 | Spectator |
| 1 | FFA |
| 2 | Red |
| 3 | Blue |
| 4 | Green |
| 5 | Yellow |

The `tea` field (index 114) on game settings enables/disables teams:
- `tea = false`: All players are FFA (team 1)
- `tea = true`: Players assigned to colored teams

### Reading Disc Positions

If the code injector was loaded before the match, `__bonkExportState` captures the full game state each tick:

```js
// Via BonkBot API:
const data = BonkBot.probePlayerDiscs();
// Returns: { discCount, discs: [{idx, x, y, xv, yv, team, ...}], physics, mm, gameSettings }

// Via raw evaluate:
const discs = await page.evaluate(() => {
  const win = document.getElementById('maingameframe').contentWindow;
  const state = win.__bonkExportState;
  if (!state) return null;
  return state.discs.map((d, i) => ({
    idx: i, x: d.x, y: d.y, xv: d.xv, yv: d.yv,
    team: d.team, ds: d.ds, a: d.a
  }));
});
```

### Game Mode Codes

The `mo` field on game settings uses these codes:

| Code | Mode | Notes |
|------|------|-------|
| `b` | Classic | Standard bonk.io |
| `bs` | Simple | Simplified physics |
| `ar` | Arrows | Fire arrows |
| `ard` | Death Arrows | Arrows + death |
| `sp` | Grapple | Grapple mode |
| `v` | VTOL | Arrow impulse movement |
| `f` | Football | Football mode |

### Required Setup for Training Maps

| Map | Game Mode | Teams |
|-----|-----------|-------|
| grapple 1v1 simple | Grapple (`g`) | Off (FFA) |
| Weird Death Ball | Grapple (`g`) | On |

### BonkBot API for Player Identification

```js
BonkBot.identifyLocalPlayer();
// Returns:
// {
//   discCount: 2,
//   discs: [{ discIndex: 0, team: 2, teamName: 'red', position: {x, y}, ... }],
//   playerCount: 2,
//   players: [{ playerIndex: 0, team: 2, ... }],
//   mode: 'g',
//   teamsEnabled: true,
//   mapName: 'Weird Death Ball',
//   isSpectating: false,
// }
```
