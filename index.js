const {
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
} = require('./axios-cached-dns-resolve.js');

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
  backgroundRefresh
}
