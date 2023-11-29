/* eslint-disable no-plusplus */
const dns = require('dns');
const URL = require('url');
const net = require('net');
const stringify = require('json-stringify-safe');
const LRUCache = require('lru-cache');
const util = require('util');

// const dnsResolve = util.promisify(dns.resolve);
const dnsLookup = util.promisify(dns.lookup);

const config = {
  disabled: process.env.AXIOS_DNS_DISABLE === 'true',
  dnsTtlMs: process.env.AXIOS_DNS_CACHE_TTL_MS || 5000,
  cacheGraceExpireMultiplier: process.env.AXIOS_DNS_CACHE_EXPIRE_MULTIPLIER || 2,
  dnsIdleTtlMs: process.env.AXIOS_DNS_CACHE_IDLE_TTL_MS || 1000 * 60 * 60,
  backgroundScanMs: process.env.AXIOS_DNS_BACKGROUND_SCAN_MS || 2400,
  dnsCacheSize: process.env.AXIOS_DNS_CACHE_SIZE || 100,
  cache: undefined,
};

const cacheConfig = {
  max: config.dnsCacheSize,
  ttl: config.dnsTtlMs * config.cacheGraceExpireMultiplier,
};

const stats = {
  dnsEntries: 0,
  refreshed: 0,
  hits: 0,
  misses: 0,
  idleExpired: 0,
  errors: 0,
  lastError: 0,
  lastErrorTs: 0,
};

let log;
let backgroundRefreshId;
let cachePruneId;

init();

function init() {
  log = console;

  if (config.cache) return;

  config.cache = new LRUCache(cacheConfig);

  startBackgroundRefresh();
  startPeriodicCachePrune();
  cachePruneId = setInterval(() => config.cache.purgeStale(), config.dnsIdleTtlMs);
}

function reset() {
  if (backgroundRefreshId) clearInterval(backgroundRefreshId);
  if (cachePruneId) clearInterval(cachePruneId);
}

function startBackgroundRefresh() {
  if (backgroundRefreshId) clearInterval(backgroundRefreshId);
  backgroundRefreshId = setInterval(backgroundRefresh, config.backgroundScanMs);
}

function startPeriodicCachePrune() {
  if (cachePruneId) clearInterval(cachePruneId);
  cachePruneId = setInterval(() => config.cache.purgeStale(), config.dnsIdleTtlMs);
}

function getStats() {
  stats.dnsEntries = config.cache.size;
  return stats;
}

function getDnsCacheEntries() {
  return Array.from(config.cache.values());
}

function registerInterceptor(axios) {
  if (config.disabled || !axios || !axios.interceptors) return;
  axios.interceptors.request.use(async (reqConfig) => {
    try {
      let url;
      if (reqConfig.baseURL) {
        url = URL.parse(reqConfig.baseURL);
      } else {
        url = URL.parse(reqConfig.url);
      }

      if (net.isIP(url.hostname)) return reqConfig;

      reqConfig.headers.Host = url.hostname;

      url.hostname = await getAddress(url.hostname);
      delete url.host;

      if (reqConfig.baseURL) {
        reqConfig.baseURL = URL.format(url);
      } else {
        reqConfig.url = URL.format(url);
      }
    } catch (err) {
      recordError(err, `Error getAddress, ${err.message}`);
    }

    return reqConfig;
  });
}

async function getAddress(host) {
  let dnsEntry = config.cache.get(host);
  if (dnsEntry) {
    ++stats.hits;
    dnsEntry.lastUsedTs = Date.now();
    const ip = dnsEntry.ips[dnsEntry.nextIdx++ % dnsEntry.ips.length];
    config.cache.set(host, dnsEntry);
    return ip;
  }
  ++stats.misses;
  log.debug(`cache miss ${host}`);

  const ips = await resolve(host);
  dnsEntry = {
    host,
    ips,
    nextIdx: 0,
    lastUsedTs: Date.now(),
    updatedTs: Date.now(),
  };
  const ip = dnsEntry.ips[dnsEntry.nextIdx++ % dnsEntry.ips.length];
  config.cache.set(host, dnsEntry);
  return ip;
}

let backgroundRefreshing = false;
async function backgroundRefresh() {
  if (backgroundRefreshing) return;
  backgroundRefreshing = true;
  try {
    config.cache.forEach(async (value, key) => {
      try {
        if (value.updatedTs + config.dnsTtlMs > Date.now()) {
          return;
        }
        if (value.lastUsedTs + config.dnsIdleTtlMs <= Date.now()) {
          ++stats.idleExpired;
          config.cache.delete(key);
          return;
        }

        const ips = await resolve(value.host);
        value.ips = ips;
        value.updatedTs = Date.now();
        config.cache.set(key, value);
        ++stats.refreshed;
      } catch (err) {
        recordError(err, `Error backgroundRefresh host: ${key}, ${stringify(value)}, ${err.message}`);
      }
    });
  } catch (err) {
    recordError(err, `Error backgroundRefresh, ${err.message}`);
  } finally {
    backgroundRefreshing = false;
  }
}

async function resolve(host) {
  let ips;
  try {
    let lookupResp = await dnsLookup(host, { all: true });
    lookupResp = extractAddresses(lookupResp);
    if (!Array.isArray(lookupResp) || lookupResp.length < 1) throw new Error(`fallback to dnsLookup returned no address ${host}`);
    ips = lookupResp;
  } catch (e) {  
     log.error(e.message)
     throw e;
  }
  return ips;
}

function extractAddresses(lookupResp) {
  if (!Array.isArray(lookupResp)) throw new Error('lookup response did not contain array of addresses');
  return lookupResp.filter((e) => e.address != null).map((e) => e.address);
}

function recordError(err, errMesg) {
  ++stats.errors;
  stats.lastError = err;
  stats.lastErrorTs = new Date().toISOString();
  log.error(err, errMesg);
}
/* eslint-enable no-plusplus */

module.exports = {
  config,
  cacheConfig,
  stats,
  init,
  reset,
  startBackgroundRefresh,
  startPeriodicCachePrune,
  getStats,
  getDnsCacheEntries,
  registerInterceptor,
  getAddress,
  backgroundRefresh,
};
