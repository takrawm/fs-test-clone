


import tsJestPreset from "ts-jest/presets/index.js";

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/js-with-ts-esm',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
    ...tsJestPreset.transform,
  },
  extensionsToTreatAsEsm: ['.ts'],
};
