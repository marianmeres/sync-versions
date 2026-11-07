#!/usr/bin/env node

// npm `bin` entry, and what `node src/bin.ts` runs from source.
import process from "node:process";
import { main } from "./cli.ts";

process.exitCode = main(process.argv.slice(2));
