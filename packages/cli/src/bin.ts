#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main, type Io } from './cli.js';

const io: Io = {
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

if (process.stdin.isTTY) {
  io.confirm = async (question) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await readline.question(`${question} [y/N] `)).trim());
    } finally {
      readline.close();
    }
  };
}

process.exitCode = await main(process.argv.slice(2), io);
