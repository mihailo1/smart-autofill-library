// Compatibility shim — field detection and actions were split (no bundler):
//   fieldDetection.js  — scan, labels, essay/resume heuristics, afCollectFields
//   fieldActions.js    — afApplyValues, afPlaceFile
// Content scripts and any host must load them in that order (see manifest.json).
// This file is intentionally empty of logic so old docs still find "fieldDetector".
