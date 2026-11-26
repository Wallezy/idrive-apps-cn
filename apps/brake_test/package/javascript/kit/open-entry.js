'use strict';

function errorText(error) {
    return error && typeof error === 'object'
        ? String(error.message || '') + ' ' + String(error.code || '')
        : String(error);
}

// Keep navigation within this application's own RHMI states when an entry mapping is stale.
function openMappedEntry(rhmi, uuid, state, onStale) {
    return Promise.resolve().then(() => rhmi.openEntryState(uuid)).catch((error) => {
        if (!/INVALID_UUID/.test(errorText(error))) throw error;
        onStale();
        return rhmi.openState(state);
    });
}

module.exports = { openMappedEntry, errorText };
