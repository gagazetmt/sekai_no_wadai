function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanPause(minMs = 400, maxMs = 1200) {
  await sleep(randomInt(minMs, maxMs));
}

async function typeHuman(page, selector, text) {
  await page.type(selector, text, { delay: randomInt(60, 160) });
}

module.exports = { randomInt, sleep, humanPause, typeHuman };
