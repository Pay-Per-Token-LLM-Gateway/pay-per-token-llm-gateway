import type { Config } from 'jest';

const config: Config = {
  displayName: 'sdk',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/packages/sdk',
  // coverageReporters is configured via the nx executor options (global config).
  // The SDK is the primary client integration surface — enforce the same
  // floor as the other packages (≥ 80% statements).
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80,
    },
  },
};

export default config;
