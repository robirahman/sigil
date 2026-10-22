'use strict';
// Predeploy step (firebase.json): `firebase deploy` uploads only functions/,
// so copy the browser engine files the rating function loads into it.
const fs = require('fs');
const path = require('path');
const { ENGINE_FILES } = require('./engine-loader');

const src = path.resolve(__dirname, '..', 'docs', 'static', 'scripts', 'engine');
const dst = path.join(__dirname, 'engine');
fs.mkdirSync(dst, { recursive: true });
for (const f of ENGINE_FILES) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('copied ' + ENGINE_FILES.length + ' engine files to ' + dst);
