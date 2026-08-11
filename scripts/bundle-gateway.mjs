/**
 * Bundle the compiled gateway into a single self-contained `main.js`.
 *
 * Why this exists:
 *  - The gateway is compiled with `tsc` (so NestJS decorator metadata —
 *    `design:paramtypes` — is preserved in the output).
 *  - Running the tsc output directly with `node` fails at runtime because
 *    pnpm's isolated `node_modules` layout (deps live under
 *    `apps/gateway/node_modules`) is not on the resolution path of
 *    `dist/out-tsc/...`.
 *  - Bundling with esbuild inlines every dependency (including the
 *    `@x402/*` workspace packages) into one file, eliminating module
 *    resolution entirely. `@prisma/client` (native query engine) stays
 *    external and is resolved at runtime via `NODE_PATH`.
 *
 * Usage: `node scripts/bundle-gateway.mjs` (run after the tsc build step).
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(root, 'dist/out-tsc/apps/gateway/src/main.js')],
  outfile: resolve(root, 'dist/apps/gateway/main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Prisma ships a platform-specific native query engine — it must stay in
  // node_modules (present in the runtime image) and be loaded at runtime.
  // The @nestjs/microservices and class-transformer/storage specifiers are
  // optional/lazy requires inside Nest core and mapped-types that this gateway
  // never exercises (they are guarded by try/catch or lazy adapter loading at
  // runtime).
  external: [
    '@prisma/client',
    '@prisma/engines',
    '@nestjs/microservices',
    '@nestjs/microservices/microservices-module',
    'class-transformer/storage',
  ],
  // esbuild resolves packages relative to the entry file + these extra paths.
  // pnpm keeps third-party deps under apps/gateway/node_modules (isolated
  // layout), so point esbuild there to resolve `@nestjs/*`, `@x402/*`, etc.
  nodePaths: [resolve(root, 'apps/gateway/node_modules'), resolve(root, 'node_modules')],
  logLevel: 'info',
});

const sizeKiB = (statSync(resolve(root, 'dist/apps/gateway/main.js')).size / 1024).toFixed(0);
console.log(`✔ Bundled gateway → dist/apps/gateway/main.js (${sizeKiB} KiB)`);
