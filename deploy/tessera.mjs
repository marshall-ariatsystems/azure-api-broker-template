#!/usr/bin/env node
import { main } from './lib/product.mjs';

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`tessera: ${error.message}\n`);
  process.exitCode = 1;
});
