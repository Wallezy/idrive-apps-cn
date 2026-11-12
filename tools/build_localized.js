'use strict';
const path = require('path');
const link = require('./oap_link');
const app = process.cwd();
const manifest = link.readManifest(app);
const out = path.join(app, `${manifest.id}@${manifest.version}.src.tgz`);
console.log(JSON.stringify({source: out, files: link.packSource(app, out).length}));
