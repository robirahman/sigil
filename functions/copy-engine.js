'use strict';
// Predeploy step (firebase.json): `firebase deploy` uploads only functions/,
// so copy the browser engine files the rating function loads into it.
const fs = require('fs');
const path = require('path');
const { ENGINE_FILES, SHARED_FILES } = require('./engine-loader');

const src = path.resolve(__dirname, '..', 'docs', 'static', 'scripts', 'engine');
const dst = path.join(__dirname, 'engine');
fs.mkdirSync(dst, { recursive: true });
for (const f of [...ENGINE_FILES, ...SHARED_FILES, 'position-rating.js', 'rust-ai.js']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
// pricing.js: the wasm engine build and the position calibration.
const stat = path.resolve(__dirname, '..', 'docs', 'static');
for (const [sub, f] of [['wasm', 'sigil_engine.js'], ['wasm', 'sigil_engine_bg.wasm'], ['data', 'position-winprob.json']]) {
	fs.mkdirSync(path.join(__dirname, sub), { recursive: true });
	fs.copyFileSync(path.join(stat, sub, f), path.join(__dirname, sub, f));
}
// racer.js: the Puzzle Racer pool (ids and ratings of the mate puzzles).
const { poolFromSet } = require('./racer');
const puzzles = JSON.parse(fs.readFileSync(path.join(stat, 'puzzles', 'mate_puzzles.json'), 'utf8')).puzzles;
fs.writeFileSync(path.join(__dirname, 'data', 'racer-pool.json'), JSON.stringify(poolFromSet(puzzles)));
console.log('copied the engine, shared files, wasm build, position calibration and Racer puzzle pool into ' + __dirname);
