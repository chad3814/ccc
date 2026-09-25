import { pgliteDatabase } from '@ccc/runtime/pglite';
import { describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';
import { resetDatabase } from '../src/dbreset.js';
import { FakeGenerator } from './fake-generator.js';
import { pipelineResponder } from './pipeline-fixture.js';
import { writeProject } from './helpers.js';

const SCHEMA = 'create table tallies (id text primary key, count integer not null);\n';

describe('resetDatabase', () => {
  it('drops everything and applies the schema', async () => {
    const db = pgliteDatabase();
    await db.exec('create table leftover (x integer)');
    await resetDatabase(db, SCHEMA);
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['tallies']);
  });
});

describe('ccc db reset', () => {
  function capture(cwd: string, env: Record<string, string | undefined>) {
    let out = '';
    const io: Io = {
      cwd,
      env,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        out += text;
      },
    };
    return { io, out: () => out };
  }

  it('resets the database named by DATABASE_URL', async () => {
    const root = await writeProject({ '.ccc/gen/schema.sql': SCHEMA });
    const db = pgliteDatabase();
    let closed = false;
    const opened: string[] = [];
    const services = {
      generator: () => new FakeGenerator(pipelineResponder()),
      openDatabase: async (url: string) => {
        opened.push(url);
        return {
          db,
          close: async () => {
            closed = true;
          },
        };
      },
    };
    const cap = capture(root, { DATABASE_URL: 'postgres://localhost/dev' });
    expect(await main(['db', 'reset'], cap.io, services)).toBe(0);
    expect(cap.out()).toBe('✓ database reset from .ccc/gen/schema.sql\n');
    expect(opened).toEqual(['postgres://localhost/dev']);
    expect(closed).toBe(true);
    expect((await db.query<{ n: number }>('select count(*)::int as n from tallies')).rows[0]?.n).toBe(0);
  });

  it('explains missing DATABASE_URL and a missing schema', async () => {
    const services = {
      generator: () => new FakeGenerator(pipelineResponder()),
      openDatabase: async () => ({ db: pgliteDatabase(), close: async () => undefined }),
    };
    const noUrl = capture(await writeProject({ '.ccc/gen/schema.sql': SCHEMA }), {});
    expect(await main(['db', 'reset'], noUrl.io, services)).toBe(1);
    expect(noUrl.out()).toBe('error: set DATABASE_URL to the database to reset\n');
    const noSchema = capture(await writeProject({}), { DATABASE_URL: 'x' });
    expect(await main(['db', 'reset'], noSchema.io, services)).toBe(1);
    expect(noSchema.out()).toBe('error: no .ccc/gen/schema.sql; run ccc build first\n');
  });
});
