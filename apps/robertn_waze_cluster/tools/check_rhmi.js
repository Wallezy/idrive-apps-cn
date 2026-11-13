// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/* The SDK flattens every page into one ID map before resolving names. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function check(directory) {
    const ui = JSON.parse(fs.readFileSync(path.join(directory, 'uiDescription.json'), 'utf8'));
    const xml = fs.readFileSync(path.join(directory, 'application.xml'), 'utf8');
    const ids = new Set();
    const components = [];
    function walk(nodes) {
        Object.keys(nodes || {}).forEach((id) => {
            assert(!ids.has(Number(id)), `duplicate RHMI id ${id}`);
            ids.add(Number(id));
            const node = nodes[id];
            if (node.components) {
                walk(node.components);
            } else {
                components.push(`${id}:${node.type}`);
            }
        });
    }
    walk(ui.containers);
    const xmlIds = new Set();
    const xmlComponents = [];
    xml.replace(/<(container|component)\s+id="(\d+)"\s+type="([^"]+)"/g, (match, kind, id, type) => {
        assert(!xmlIds.has(Number(id)), `duplicate XML RHMI id ${id}`);
        xmlIds.add(Number(id));
        if (kind === 'component') xmlComponents.push(`${id}:${type}`);
        return match;
    });
    assert.deepStrictEqual(Array.from(xmlIds).sort(), Array.from(ids).sort(), 'RHMI JSON/XML IDs differ');
    assert.deepStrictEqual(xmlComponents.sort(), components.sort(), 'RHMI JSON/XML component types differ');
}

module.exports = { check };
if (require.main === module) {
    const app = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(app, 'mgu-app.json'), 'utf8'));
    check(path.join(app, manifest.tree, 'rhmiData', 'uiDescriptions', 'ID7'));
    console.log('RHMI: unique application-wide IDs and matching XML');
}
