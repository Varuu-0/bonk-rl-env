'use strict';

// Offline contract for the BonkBot capture workflow. The fixtures are captured
// Bonk DOM fragments, so this check intentionally covers only IDs the workflow
// requires rather than every optional UI branch in bonkbot.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BOT_PATH = path.join(ROOT, 'Webscripts', 'bonkbot.js');
const FIXTURE_DIR = path.join(ROOT, 'webpages');

const CONTRACTS = [
  {
    fixture: 'roomlist.html',
    ids: [
      'roomListContainer',
      'roomlistcreatebutton',
      'roomlistcreatewindowcontainer',
      'roomlistcreatewindowgamename',
      'roomlistcreatewindowmaxplayers',
      'roomlistcreatewindowunlistedcheckbox',
      'roomlistcreatecreatebutton',
      'roomlist_create_close',
      'roomliststatustext',
    ],
  },
  {
    fixture: 'lobby.html',
    ids: [
      'newbonklobby',
      'newbonklobby_modebutton',
      'newbonklobby_mode_grapple',
      'newbonklobby_teamsbutton',
      'newbonklobby_teams_middletext',
      'newbonklobby_mapbutton',
      'newbonklobby_startbutton',
    ],
  },
  {
    fixture: 'mapwindow.html',
    ids: [
      'maploadwindowcontainer',
      'maploadtypedropdown',
      'maploadtypedropdownoption10',
      'maploadwindowstatustext',
    ],
  },
];

function hasId(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\bid\\s*=\\s*["\']' + escaped + '["\']').test(html);
}

function main() {
  const bot = fs.readFileSync(BOT_PATH, 'utf8');
  const failures = [];
  const checked = [];

  for (const contract of CONTRACTS) {
    const fixturePath = path.join(FIXTURE_DIR, contract.fixture);
    const html = fs.readFileSync(fixturePath, 'utf8');
    for (const id of contract.ids) {
      const sourceMentionsId = bot.includes("'" + id + "'") || bot.includes('"' + id + '"');
      const fixtureContainsId = hasId(html, id);
      checked.push({ fixture: contract.fixture, id, sourceMentionsId, fixtureContainsId });
      if (!sourceMentionsId) failures.push(contract.fixture + ': BonkBot no longer references #' + id);
      if (!fixtureContainsId) failures.push(contract.fixture + ': fixture is missing #' + id);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error('webscript DOM contract failed: ' + failure);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    valid: true,
    bot: path.relative(ROOT, BOT_PATH).replace(/\\/g, '/'),
    checked,
  }, null, 2));
}

main();
