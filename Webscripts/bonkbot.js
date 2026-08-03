/**
 * Bonk.io Browser Automation Library
 * 
 * Reusable functions for automating bonk.io workflows:
 * - Login
 * - Creating custom games
 * - Selecting maps from favorites
 * - Extracting map data and physics state
 * 
 * Usage: Paste this entire file into the browser console on bonk.io,
 *        or inject via Playwright evaluate().
 * 
 * All functions return Promises. Call await BonkBot.login() etc.
 */

const BonkBot = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  //  CONFIG
  // ═══════════════════════════════════════════════════════════════

  const CONFIG = {
    account: {
      // Credentials are injected at launch time, never committed to source.
      username: (typeof process !== 'undefined' && process.env && process.env.BONK_USERNAME) || '',
      password: (typeof process !== 'undefined' && process.env && process.env.BONK_PASSWORD) || '',
    },
    targetMaps: [
      'grapple 1v1 simple',
      'Weird Death Ball',
    ],
    timeouts: {
      element: 15000,    // Wait for element to appear
      navigation: 30000, // Wait for page navigation
      mapLoad: 10000,    // Wait for map to load
      login: 20000,     // Wait for login to complete
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitFor(fn, timeout = CONFIG.timeouts.element, interval = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        try {
          const result = fn();
          if (result) return resolve(result);
        } catch (e) {
          // Continue waiting
        }
        if (Date.now() - start > timeout) {
          return reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
        }
        setTimeout(check, interval);
      };
      check();
    });
  }

  /**
   * Get the game iframe document
   */
  function getGameDoc() {
    const iframe = document.getElementById('maingameframe');
    if (!iframe) return null;
    return iframe.contentDocument;
  }

  /**
   * Get the game iframe window
   */
  function getGameWin() {
    const iframe = document.getElementById('maingameframe');
    if (!iframe) return null;
    return iframe.contentWindow;
  }

  /**
   * Get the constant table (M$QCc)
   */
  function getConstantTable() {
    const win = getGameWin();
    return win ? win.M$QCc : null;
  }

  /**
   * Click an element by ID (bypasses visibility checks)
   */
  function clickById(id) {
    const doc = getGameDoc();
    if (!doc) throw new Error('Game iframe not found');
    const el = doc.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found`);
    el.click();
    return el;
  }

  /**
   * Get all visible text in the game iframe for debugging
   */
  function getVisibleText() {
    const doc = getGameDoc();
    if (!doc) return 'No game iframe';
    const texts = [];
    doc.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0 && el.textContent.trim()) {
        const text = el.textContent.trim();
        if (text.length > 2 && text.length < 100) {
          texts.push(text);
        }
      }
    });
    return texts;
  }

  /**
   * Find an element by its text content
   */
  function findByText(selector, text) {
    const doc = getGameDoc();
    if (!doc) return null;
    const elements = doc.querySelectorAll(selector);
    for (const el of elements) {
      if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 10 && rect.height > 10 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
  }

  function hasVisibleElement(id) {
    return isVisible(getGameDoc()?.getElementById(id));
  }

  async function clickWhenAvailable(id, timeout = CONFIG.timeouts.element) {
    const el = await waitFor(() => {
      const candidate = getGameDoc()?.getElementById(id);
      return isVisible(candidate) ? candidate : null;
    }, timeout);
    el.click();
    return el;
  }

  // ═══════════════════════════════════════════════════════════════
  //  NAVIGATION & GAME STATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the current game screen state
   */
  function getGameState() {
    const doc = getGameDoc();
    if (!doc) return { screen: 'no_iframe' };

    const screens = {
      login: hasVisibleElement('guestOrAccountContainer'),
      mainMenu: hasVisibleElement('classicmenu'),
      gameChoice: hasVisibleElement('sm_gameChoiceWindow'),
      connecting: hasVisibleElement('sm_connectingWindow'),
      roomList: hasVisibleElement('roomListContainer'),
      lobby: hasVisibleElement('newbonklobby'),
      mapPicker: hasVisibleElement('maploadwindowcontainer'),
      mapEditor: hasVisibleElement('mapeditorcontainer'),
      playing: hasVisibleElement('gamerenderer'),
    };
    const active = Object.entries(screens).find(([, visible]) => visible)?.[0] ?? 'unknown';
    return { screen: active, ...screens };
  }

  /**
   * Navigate through Bonk's verified UI containers and controls.
   * @param {string} page - room-list, custom-lobby, map-picker,
   *   map-favorites, map-editor, or match.
   * @param {object} options - Optional mapName, mode, teams, and timeout.
   */
  async function navigate(page, options = {}) {
    const routes = {
      rooms: 'room-list', 'room-list': 'room-list',
      lobby: 'custom-lobby', custom: 'custom-lobby', 'custom-lobby': 'custom-lobby',
      maps: 'map-picker', 'map-picker': 'map-picker',
      favorites: 'map-favorites', favourites: 'map-favorites', 'map-favorites': 'map-favorites',
      editor: 'map-editor', 'map-editor': 'map-editor',
      game: 'match', match: 'match',
    };
    const target = routes[String(page || '').trim().toLowerCase()];
    const timeout = options.timeout ?? CONFIG.timeouts.navigation;
    if (!target) throw new Error(`Unknown page "${page}". Supported pages: ${[...new Set(Object.values(routes))].join(', ')}`);

    if (!hasVisibleElement('roomListContainer') && !hasVisibleElement('newbonklobby')) {
      await clickWhenAvailable('classic_mid_customgame', timeout);
      await waitFor(() => hasVisibleElement('roomListContainer'), timeout);
    }
    if (target === 'room-list') return { page: target, state: getGameState() };

    if (!hasVisibleElement('newbonklobby')) {
      await clickWhenAvailable('roomlistcreatebutton', timeout);
      await waitFor(() => hasVisibleElement('roomlistcreatewindowcontainer'), timeout);
      const setValue = (id, value) => {
        const input = getGameDoc()?.getElementById(id);
        if (!input) throw new Error(`Create-game input #${id} not found`);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const submitCreateForm = async () => {
        const doc = getGameDoc();
        if (!doc) throw new Error('Game iframe not found while creating a room');
        setValue('roomlistcreatewindowgamename', options.roomName ?? 'Bonk RL Export');
        setValue('roomlistcreatewindowmaxplayers', options.maxPlayers ?? 2);
        const unlisted = doc.getElementById('roomlistcreatewindowunlistedcheckbox');
        if (!unlisted) throw new Error('Create-game unlisted checkbox not found');
        if (options.unlisted === true && !unlisted.checked) unlisted.click();
        await clickWhenAvailable('roomlistcreatecreatebutton', timeout);
      };
      const waitForLobbyOrFailure = async () => {
        const result = await waitFor(() => {
          if (hasVisibleElement('newbonklobby')) return { lobby: true };
          const status = getGameDoc()?.getElementById('roomliststatustext');
          const message = status?.textContent?.trim() || '';
          if (isVisible(status) && message && !/^getting rooms/i.test(message)) {
            return { failure: message };
          }
          return null;
        }, timeout);
        if (result.failure) throw new Error(`Room creation failed: ${result.failure}`);
      };

      await submitCreateForm();
      try {
        await waitForLobbyOrFailure();
      } catch (firstError) {
        const close = getGameDoc()?.getElementById('roomlist_create_close');
        if (!close) throw new Error(`Room creation did not reach the lobby: ${firstError.message}`);
        console.warn(`[BonkBot] ${firstError.message}; retrying creation once`);
        close.click();
        await waitFor(() => !hasVisibleElement('roomlistcreatewindowcontainer'), timeout);
        await clickWhenAvailable('roomlistcreatebutton', timeout);
        await waitFor(() => hasVisibleElement('roomlistcreatewindowcontainer'), timeout);
        await submitCreateForm();
        try {
          await waitForLobbyOrFailure();
        } catch (retryError) {
          throw new Error(`Room creation did not reach the lobby after one retry: ${retryError.message}`);
        }
      }
    }
    if (options.mode) await setGameMode(options.mode);
    if (typeof options.teams === 'boolean') await setTeams(options.teams);
    if (target === 'custom-lobby') return { page: target, state: getGameState() };

    if (target === 'map-picker' || target === 'map-favorites') {
      if (!hasVisibleElement('maploadwindowcontainer')) {
        await clickWhenAvailable('newbonklobby_mapbutton', timeout);
        await waitFor(() => hasVisibleElement('maploadwindowcontainer'), timeout);
      }
      if (target === 'map-favorites') await selectMapSource('favorites', timeout);
      return { page: target, state: getGameState() };
    }

    if (target === 'map-editor') {
      if (!hasVisibleElement('mapeditorcontainer')) {
        await clickWhenAvailable('newbonklobby_editorbutton', timeout);
        await waitFor(() => hasVisibleElement('mapeditorcontainer'), timeout);
      }
      return { page: target, state: getGameState() };
    }

    if (options.mapName) await selectFavoriteMap(options.mapName);
    await startMatch();
    await waitFor(() => hasVisibleElement('gamerenderer'), timeout);
    return { page: target, state: getGameState() };
  }

  /**
   * Check if we're logged in (not showing guest/account screen)
   */
  function isLoggedIn() {
    const doc = getGameDoc();
    if (!doc) return false;
    const container = doc.getElementById('guestOrAccountContainer');
    if (!container) return false;
    // If the container is hidden or the login button is gone, we're logged in
    return container.style.visibility === 'hidden' || container.style.display === 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  //  LOGIN WORKFLOW
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full login workflow:
   * 1. Click "Login or Register"
   * 2. Enter username and password
   * 3. Click login
   * 4. Wait for game menu
   */
  async function login(username, password) {
    username = username || CONFIG.account.username;
    password = password || CONFIG.account.password;
    if (!username || !password) {
      throw new Error('[BonkBot] No credentials configured. Set BONK_USERNAME / BONK_PASSWORD environment variables before launching, or pass username/password to login().');
    }

    console.log('%c[BonkBot] Starting login...', 'color:#4caf50;font-weight:bold');

    // Step 1: Click "Login or Register"
    const loginBtn = waitFor(() => {
      const doc = getGameDoc();
      if (!doc) return null;
      // Try multiple selectors
      const btn = doc.getElementById('guestOrAccountContainer_accountButton') ||
                  findByText('div', 'Login or Register');
      return btn;
    });

    try {
      await loginBtn;
      clickById('guestOrAccountContainer_accountButton');
      console.log('[BonkBot] Clicked Login or Register');
    } catch (e) {
      // Maybe we're already past login screen
      if (isLoggedIn()) {
        console.log('[BonkBot] Already logged in');
        return true;
      }
      throw new Error('Could not find login button: ' + e.message);
    }

    await sleep(1000);

    // Step 2: Enter credentials
    const doc = getGameDoc();
    const usernameInput = doc.querySelector('input[type="text"], input[name="username"], #loginBox_username');
    const passwordInput = doc.querySelector('input[type="password"], input[name="password"], #loginBox_password');

    if (!usernameInput || !passwordInput) {
      // Try finding by ID patterns
      const allInputs = doc.querySelectorAll('input');
      console.log('[BonkBot] Found inputs:', Array.from(allInputs).map(i => ({ id: i.id, type: i.type, placeholder: i.placeholder })));
      throw new Error('Could not find login input fields');
    }

    // Set values using native input setter to trigger React/JS events
    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputSetter.call(usernameInput, username);
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nativeInputSetter.call(passwordInput, password);
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));

    console.log('[BonkBot] Entered credentials');

    await sleep(500);

    // Step 3: Click login button
    const loginSubmit = doc.querySelector('button[type="submit"], #loginBox_loginButton') ||
                        findByText('button', 'Login') ||
                        findByText('div[class*="brownButton"]', 'Login');

    if (loginSubmit) {
      loginSubmit.click();
      console.log('[BonkBot] Clicked login button');
    } else {
      // Try pressing Enter
      passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      console.log('[BonkBot] Pressed Enter to submit');
    }

    // Step 4: Wait for login to complete
    await waitFor(() => {
      const state = getGameState();
      return state.screen === 'mainMenu' || isLoggedIn();
    }, CONFIG.timeouts.login);

    console.log('%c[BonkBot] Login complete!', 'color:#4caf50;font-weight:bold');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  CUSTOM GAME WORKFLOW
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a custom game and navigate to the host menu
   */
  async function createCustomGame() {
    console.log('%c[BonkBot] Creating custom game...', 'color:#4caf50;font-weight:bold');
    await navigate('custom-lobby');
    console.log('[BonkBot] Custom game created');
    return true;
  }

  /**
   * Open the map picker in the host menu
   */
  async function openMapPicker() {
    console.log('[BonkBot] Opening map picker...');

    if (!hasVisibleElement('maploadwindowcontainer')) {
      await clickWhenAvailable('newbonklobby_mapbutton');
      await waitFor(() => hasVisibleElement('maploadwindowcontainer'));
    }
    return true;
  }

  async function selectMapSource(source, timeout = CONFIG.timeouts.element) {
    const optionIds = {
      picks: 'maploadtypedropdownoption11',
      hot: 'maploadtypedropdownoption8',
      deatharrows: 'maploadtypedropdownoption_hotdeatharrows',
      mymaps: 'maploadtypedropdownoption7',
      favorites: 'maploadtypedropdownoption10',
      favourites: 'maploadtypedropdownoption10',
    };
    const optionId = optionIds[String(source).toLowerCase()];
    if (!optionId) throw new Error(`Unknown map source: ${source}`);
    if (!hasVisibleElement('maploadwindowcontainer')) throw new Error('Map picker is not open');

    getGameDoc().getElementById('maploadtypedropdown').click();
    await clickWhenAvailable(optionId, timeout);
    await waitFor(() => !hasVisibleElement('maploadwindowstatustext'), timeout);
    return true;
  }

  /**
   * Select a map from favorites by name
   */
  async function selectFavoriteMap(mapName) {
    console.log(`%c[BonkBot] Selecting map: "${mapName}"`, 'color:#4caf50;font-weight:bold');

    // Open map picker if not already open
    await openMapPicker();
    await selectMapSource('favorites');

    // Find the map by name in the list
    const mapItem = waitFor(() => {
      const doc = getGameDoc();
      if (!doc) return null;
      const wantedName = mapName.trim().toLowerCase();
      for (const item of doc.querySelectorAll('.maploadwindowmapdiv')) {
        const name = item.querySelector('.maploadwindowtextname')?.textContent?.trim().toLowerCase();
        if (name === wantedName) return item;
      }
      return null;
    }, CONFIG.timeouts.element);

    (await mapItem).click();
    console.log(`[BonkBot] Clicked map: "${mapName}"`);

    await waitFor(() => !hasVisibleElement('maploadwindowcontainer'), CONFIG.timeouts.mapLoad);
    console.log(`%c[BonkBot] Map "${mapName}" loaded!`, 'color:#4caf50;font-weight:bold');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GAME LOBBY CONFIGURATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Set the game mode in the lobby.
   * @param {string} mode - One of: 'classic', 'arrows', 'deatharrows', 'grapple', 'vtol', 'football'
   */
  async function setGameMode(mode) {
    console.log(`%c[BonkBot] Setting game mode: ${mode}`, 'color:#4caf50;font-weight:bold');

    const modeIds = {
      classic: 'newbonklobby_mode_classic',
      arrows: 'newbonklobby_mode_arrow',
      deatharrows: 'newbonklobby_mode_deatharrows',
      grapple: 'newbonklobby_mode_grapple',
      vtol: 'newbonklobby_mode_vtol',
      football: 'newbonklobby_mode_football',
    };

    // Click the mode button to open the mode menu
    const doc = getGameDoc();
    const modeBtn = doc.getElementById('newbonklobby_modebutton');
    if (modeBtn) {
      modeBtn.click();
      await sleep(500);
    }

    // Click the specific mode
    const modeId = modeIds[mode.toLowerCase()];
    if (!modeId) throw new Error(`Unknown game mode: ${mode}`);

    const modeEl = doc.getElementById(modeId);
    if (modeEl) {
      modeEl.click();
      console.log(`[BonkBot] Selected mode: ${mode}`);
    } else {
      throw new Error(`Mode button #${modeId} not found`);
    }

    await sleep(500);
    return true;
  }

  /**
   * Toggle teams on/off in the lobby.
   * @param {boolean} enabled - true to enable teams, false to disable
   */
  async function setTeams(enabled) {
    console.log(`%c[BonkBot] Setting teams: ${enabled}`, 'color:#4caf50;font-weight:bold');

    const doc = getGameDoc();
    const teamsBtn = doc.getElementById('newbonklobby_teamsbutton');
    const teamsText = doc.getElementById('newbonklobby_teams_middletext');

    // Check current teams state from the button text
    const currentText = (teamsText || teamsBtn)?.textContent?.trim()?.toLowerCase() || '';
    const currentlyOn = !currentText.includes('off');

    if (currentlyOn !== enabled) {
      teamsBtn.click();
      console.log(`[BonkBot] Toggled teams ${enabled ? 'ON' : 'OFF'}`);
      await sleep(500);
    } else {
      console.log(`[BonkBot] Teams already ${enabled ? 'ON' : 'OFF'}`);
    }

    return true;
  }

  /**
   * Click the Start button to begin a match.
   */
  async function startMatch() {
    console.log('%c[BonkBot] Starting match...', 'color:#4caf50;font-weight:bold');

    const doc = getGameDoc();
    const startBtn = doc.getElementById('newbonklobby_startbutton');
    if (!startBtn) throw new Error('Start button not found');

    startBtn.click();
    await sleep(3000);
    console.log('%c[BonkBot] Match started!', 'color:#4caf50;font-weight:bold');
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIVE GAMEPLAY PROBES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if currently in an active match (gamerenderer visible).
   */
  function isInMatch() {
    const doc = getGameDoc();
    if (!doc) return false;
    const gr = doc.getElementById('gamerenderer');
    if (!gr) return false;
    return gr.style.visibility === 'inherit' && gr.getBoundingClientRect().width > 100;
  }

  /**
   * Read the current map credit (name + author) from the in-game display.
   */
  function getMapCredit() {
    const doc = getGameDoc();
    if (!doc) return null;
    return {
      name: doc.getElementById('ingamemapcredit_name')?.textContent?.trim() || null,
      author: doc.getElementById('ingamemapcredit_author')?.textContent?.trim() || null,
    };
  }

  /**
   * Read the current round countdown text.
   */
  function getCountdown() {
    const doc = getGameDoc();
    if (!doc) return null;
    const cd = doc.getElementById('ingamecountdown');
    if (!cd || cd.getBoundingClientRect().width < 10) return null;
    return cd.textContent.trim();
  }

  /**
   * Probe the runtime for player disc data.
   * Uses the constant table to locate and read the game state.
   * This searches the M$QCc module registry for objects with disc data.
   */
  function probePlayerDiscs() {
    const win = getGameWin();
    if (!win) return { error: 'no game window' };

    const mqcc = win.M$QCc;
    if (!mqcc) return { error: 'no constant table' };

    // We know the step function stores state at window.__bonkExportState
    // (if the code injector was loaded before the match started).
    // If not, we need to find the state through the module system.

    const state = win.__bonkExportState;
    if (!state) return { error: 'no captured state (injector not loaded)', hint: 'Reload page with bonkbot injector' };

    const discs = state.discs || [];
    const results = discs.map((d, i) => {
      if (!d) return null;
      return {
        index: i,
        x: d.x ?? d.sx ?? null,
        y: d.y ?? d.sy ?? null,
        xv: d.xv ?? null,
        yv: d.yv ?? null,
        a: d.a ?? null,
        av: d.av ?? null,
        team: d.team ?? null,
        fn: d.fn ?? null,
        ds: d.ds ?? null,
        da: d.da ?? null,
        a1: d.a1 ?? null,
        a2: d.a2 ?? null,
        vt: d.vt ?? null,
        ni: d.ni ?? null,
      };
    }).filter(d => d !== null);

    return {
      discCount: results.length,
      discs: results,
      physics: state.physics ? {
        ppm: state.physics.ppm ?? null,
        bodyCount: state.physics.bodies?.length ?? 0,
        fixtureCount: state.physics.fixtures?.length ?? 0,
        shapeCount: state.physics.shapes?.length ?? 0,
        jointCount: state.physics.joints?.length ?? 0,
        grav: state.physics.grav ? { x: state.physics.grav[0], y: state.physics.grav[1] } : null,
        bw: state.physics.bw ?? null,
        bh: state.physics.bh ?? null,
      } : null,
      mm: state.mm ? {
        name: state.mm.n ?? null,
        dbid: state.mm.dbid ?? null,
      } : null,
      gameSettings: win.__bonkExportGameSettings ? {
        mapName: win.__bonkExportGameSettings.map?.m?.n ?? null,
        mode: win.__bonkExportGameSettings.mo ?? null,
      } : null,
    };
  }

  /**
   * Try to identify which disc belongs to the local player.
   * 
   * In bonk.io, the local player is identified via `localPlayerID` (constant 1564),
   * which maps directly to an index in the `discs` array: state.discs[localPlayerID].
   * 
   * The `localSpawnedYet` flag (1668) is true once the player has spawned.
   * If false, the player is spectating (ingametextwarning_spectating is visible).
   * 
   * Team numbers on discs: 0=spectator, 1=FFA, 2=red, 3=blue, 4=green, 5=yellow
   * The `tea` field (114) on game settings enables/disables teams mode.
   */
  function identifyLocalPlayer() {
    const win = getGameWin();
    if (!win) return { error: 'no game window' };

    const state = win.__bonkExportState;
    if (!state) return { error: 'no captured state (injector not loaded)' };

    const gs = win.__bonkExportGameSettings;
    const discs = state.discs || [];
    const players = state.players || [];
    const discDeaths = state.discDeaths || [];

    // Team mapping
    const teamNames = ['spectator', 'ffa', 'red', 'blue', 'green', 'yellow'];

    // Build disc info with team names
    const discInfo = discs.map((d, i) => {
      if (!d) return null;
      return {
        discIndex: i,
        team: d.team,
        teamName: teamNames[d.team] ?? `team_${d.team}`,
        fn: d.fn,
        ds: d.ds,
        position: { x: d.x, y: d.y },
        velocity: { x: d.xv, y: d.yv },
        angle: d.a,
        angularVelocity: d.av,
        isDead: discDeaths[i] !== undefined ? !!discDeaths[i] : null,
        // Arrow state
        a1: d.a1,
        a2: d.a2,
        a1a: d.a1a,
        // Grapple state
        lhid: d.lhid,  // last hit ID
        lht: d.lht,    // last hit time
      };
    }).filter(d => d !== null);

    // Build player info
    const playerInfo = players.map((p, i) => {
      if (!p) return null;
      // Player objects have: id, team, name, etc.
      return {
        playerIndex: i,
        id: p.id ?? null,
        team: p.team ?? p.t ?? null,
        teamName: teamNames[p.team ?? p.t] ?? null,
        name: p.n ?? p.name ?? null,
      };
    }).filter(p => p !== null);

    return {
      discCount: discInfo.length,
      discs: discInfo,
      playerCount: playerInfo.length,
      players: playerInfo,
      // Game mode determines movement physics
      mode: gs?.mo ?? null,
      // Teams enabled flag
      teamsEnabled: gs?.tea ?? null,
      // Map info
      mapName: gs?.map?.m?.n ?? state.mm?.n ?? null,
      mapDbid: gs?.map?.m?.dbid ?? state.mm?.dbid ?? null,
      // Scores
      scores: state.scores ?? null,
      // Round info
      seed: state.seed ?? null,
      fte: state.fte ?? null,  // frames to end
      ftu: state.ftu ?? null,  // frames to update
      rl: state.rl ?? null,    // round length
      rc: state.rc ?? null,    // round count
      // Spectating detection
      isSpectating: (() => {
        const doc = getGameDoc();
        if (!doc) return null;
        const spectating = doc.getElementById('ingametextwarning_spectating');
        return spectating && spectating.getBoundingClientRect().width > 10;
      })(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  DATA EXTRACTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Inject the state capture hook (same as mapexporter.js)
   * Must be done BEFORE the game loads, or requires reloading alpha2s.js
   * 
   * For already-loaded games, we can access the state through the
   * constant table + module system instead.
   */
  function injectStateCapture() {
    const win = getGameWin();
    if (!win) throw new Error('No game window');

    // Check if already injected
    if (win.__bonkExportState) {
      console.log('[BonkBot] State capture already active');
      return true;
    }

    // Register a code injector that will be applied on next game load
    if (!win.bonkCodeInjectors) win.bonkCodeInjectors = [];
    win.bonkCodeInjectors.push(function (bonkCode) {
      const stateRegexMatch = bonkCode.match(
        /[A-Za-z]\[[A-Za-z0-9$_]{3}(\[[0-9]{1,3}\]){2}\]={discs/
      );
      if (!stateRegexMatch) {
        console.warn('[BonkBot] Could not find state creation pattern');
        return bonkCode;
      }
      const stateRegex = stateRegexMatch[0];
      const captureCode = '{try{if(arguments[0]&&arguments[0].physics&&arguments[0].physics.bodies){window.__bonkExportState=arguments[0];}if(arguments[4]){window.__bonkExportGameSettings=arguments[4];}}catch(e){}}';
      console.log('[BonkBot] State capture hook injected');
      return bonkCode.replace(stateRegex, captureCode + stateRegex);
    });

    console.log('[BonkBot] Code injector registered (requires page reload)');
    return true;
  }

  /**
   * Extract the current game state if available
   */
  function getCapturedState() {
    const win = getGameWin();
    if (!win) return null;
    return win.__bonkExportState || null;
  }

  /**
   * Extract the current game settings if available
   */
  function getCapturedGameSettings() {
    const win = getGameWin();
    if (!win) return null;
    return win.__bonkExportGameSettings || null;
  }

  /**
   * Search the constant table for all strings matching a pattern
   */
  function searchConstantTable(pattern) {
    const mqcc = getConstantTable();
    if (!mqcc) return null;
    const results = {};
    for (let i = 0; i < mqcc.length; i++) {
      if (typeof mqcc[i] === 'string') {
        if (typeof pattern === 'string') {
          if (mqcc[i].toLowerCase().includes(pattern.toLowerCase())) {
            results[mqcc[i]] = i;
          }
        } else if (pattern instanceof RegExp) {
          if (pattern.test(mqcc[i])) {
            results[mqcc[i]] = i;
          }
        }
      }
    }
    return results;
  }

  /**
   * Look up a constant table value by index
   */
  function lookupConstant(index) {
    const mqcc = getConstantTable();
    if (!mqcc) return null;
    return mqcc[index];
  }

  /**
   * Search the alpha2s.js source for a pattern
   */
  async function searchSource(pattern, contextBefore = 60, contextAfter = 80, maxResults = 5) {
    const resp = await fetch('https://bonk.io/js/alpha2s.js');
    const text = await resp.text();
    const results = [];
    let idx = 0;
    while (results.length < maxResults) {
      if (typeof pattern === 'string') {
        idx = text.indexOf(pattern, idx);
      } else if (pattern instanceof RegExp) {
        const m = text.substring(idx).match(pattern);
        if (!m) break;
        idx = text.indexOf(m[0], idx);
      }
      if (idx === -1) break;
      results.push({
        index: idx,
        context: text.substring(Math.max(0, idx - contextBefore), idx + contextAfter),
      });
      idx++;
    }
    return results;
  }

  /**
   * Dump the full constant table as a lookup object
   */
  function dumpConstantTable() {
    const mqcc = getConstantTable();
    if (!mqcc) return null;
    const out = {};
    for (let i = 0; i < mqcc.length; i++) {
      if (typeof mqcc[i] === 'string' && mqcc[i].length > 0) {
        out[i] = mqcc[i];
      }
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  //  HIGH-LEVEL WORKFLOWS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full workflow: Login → Create custom game → Select map
   */
  async function loadMap(mapName) {
    await login();
    await createCustomGame();
    await selectFavoriteMap(mapName);
    return true;
  }

  /**
   * Full workflow: Login → Create custom game → Select map → Extract data
   * Returns the full map definition + physics constants
   */
  async function extractMapData(mapName) {
    await loadMap(mapName);

    // Wait for physics to be running
    await waitFor(() => {
      const state = getGameState();
      return state.screen === 'playing' || state.screen === 'menu';
    }, CONFIG.timeouts.mapLoad);

    // Extract state
    const state = getCapturedState();
    const gs = getCapturedGameSettings();

    const result = {
      mapName,
      extractedAt: new Date().toISOString(),
      state: state ? clone(state) : null,
      gameSettings: gs ? clone(gs) : null,
      constantTable: dumpConstantTable(),
    };

    console.log(`%c[BonkBot] Extracted data for "${mapName}"`, 'color:#4caf50;font-weight:bold');
    return result;
  }

  function clone(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  return {
    CONFIG,
    // Utilities
    sleep,
    waitFor,
    getGameDoc,
    getGameWin,
    getConstantTable,
    searchConstantTable,
    lookupConstant,
    searchSource,
    dumpConstantTable,
    getGameState,
    getVisibleText,
    navigate,
    // Workflows
    login,
    createCustomGame,
    openMapPicker,
    selectMapSource,
    selectFavoriteMap,
    loadMap,
    extractMapData,
    // Lobby configuration
    setGameMode,
    setTeams,
    startMatch,
    // Live gameplay
    isInMatch,
    getMapCredit,
    getCountdown,
    probePlayerDiscs,
    identifyLocalPlayer,
    // State capture
    injectStateCapture,
    getCapturedState,
    getCapturedGameSettings,
  };
})();
