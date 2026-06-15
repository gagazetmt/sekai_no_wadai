'use strict';

require('dotenv').config();

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { fetchFotMobPlayer } = require('./modules/fetchers/fotmob_player');
const { fetchFotMobManager } = require('./modules/fetchers/fotmob_manager');
const { normalizeLabels } = require('../v4_launcher/scripts/v4_assets');

const ROOT = path.join(__dirname, '..');

function assertSofaSsrDisabled() {
  const matchSource = fs.readFileSync(
    path.join(ROOT, 'scripts/modules/fetchers/sofascore_match.js'),
    'utf8',
  );
  const playerSource = fs.readFileSync(
    path.join(ROOT, 'scripts/modules/fetchers/sofascore_player.js'),
    'utf8',
  );

  assert.doesNotMatch(matchSource, /_sofa_via_puppeteer|_fetchMatchSSR|fetchMatchPage/);
  assert.doesNotMatch(playerSource, /_sofa_via_puppeteer|fetchPlayerPage/);
}

function assertManagerLabels() {
  const labels = normalizeLabels({
    assetLabels: [
      { type: 'player', name: 'Erling Haaland' },
      { type: 'manager', name: 'Pep Guardiola' },
    ],
  });

  assert(labels.some(label =>
    label.source === 'fotmob'
    && label.type === 'player'
    && label.entity === 'Erling Haaland'
  ));
  assert(labels.some(label =>
    label.source === 'fotmob'
    && label.type === 'manager'
    && label.entity === 'Pep Guardiola'
  ));
}

async function main() {
  const playerName = process.argv[2] || 'Erling Haaland';
  const managerName = process.argv[3] || 'Pep Guardiola';

  assertSofaSsrDisabled();
  assertManagerLabels();

  const [player, manager] = await Promise.all([
    fetchFotMobPlayer(playerName),
    fetchFotMobManager(managerName),
  ]);

  assert.equal(player.ok, true, player.error || `${playerName} fetch failed`);
  assert(player.playerId, 'playerId is required');
  assert(player.name, 'player name is required');
  assert.match(player.photo || '', /^https:\/\/images\.fotmob\.com\//);

  assert.equal(manager.ok, true, manager.error || `${managerName} fetch failed`);
  assert(manager.managerId, 'managerId is required');
  assert(manager.name, 'manager name is required');
  assert.match(manager.photo || '', /^https:\/\/images\.fotmob\.com\//);

  console.log(JSON.stringify({
    ok: true,
    player: {
      id: player.playerId,
      name: player.name,
      team: player.team,
      seasonStats: player.seasonStats,
    },
    manager: {
      id: manager.managerId,
      name: manager.name,
      currentTeam: manager.currentTeam,
      trophyCount: manager.trophyCount,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
