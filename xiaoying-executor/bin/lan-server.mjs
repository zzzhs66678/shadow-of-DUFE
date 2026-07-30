#!/usr/bin/env node

process.env.XIAOYING_EXECUTOR_HOST = "0.0.0.0";
await import("./server.mjs");
