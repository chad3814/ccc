#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main, type Io } from './cli.js';

const io: Io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

if (process.stdin.isTTY) {
  io.choose = async (question, choices) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (;;) {
        const answer = (await readline.question(`${question} `)).trim().toLowerCase().slice(0, 1);
        if (choices.includes(answer)) {
          return answer;
        }
      }
    } finally {
      readline.close();
    }
  };
}

process.exitCode = await main(process.argv.slice(2), io);
