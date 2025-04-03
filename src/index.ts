#!/usr/bin/env node
// src/index.ts - Main entry point

import { main } from "./server.js";

// Run the server's main function
main().catch((error) => {
  console.error("Fatal error executing main function:", error);
  process.exit(1);
});
