'use strict';
const online = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
global.__mguLocalizedSdk = { OnlineApp: online.OnlineApp || online, logging: logging.logging || logging };
