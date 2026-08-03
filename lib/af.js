// Global AF namespace for classic-script modularity (no bundler / no ES modules).
// Load first in popup (and any multi-file host). Content scripts keep flat self.*
// globals for historical reasons and importScripts simplicity.
(function (global) {
  const root = global.AF || (global.AF = {});
  root.popup = root.popup || {};
  root.version = "1.6.0";
  if (typeof global !== "undefined") {
    global.AF = root;
  }
})(typeof self !== "undefined" ? self : globalThis);
