import {Database} from 'bun:sqlite';
import {expect,test} from 'bun:test';
import {hashContent} from '../hash';
import type {getDb} from '../database';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.EASYMONEY_DB_PATH = join(tmpdir(), `easymoney-retention-${process.pid}.sqlite`);
const { assertRetainedOriginal } = await import('./originalRetention');

test('commit retention gate rejects missing or corrupt originals and verifies approved replacements',()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE importFiles(id INTEGER,contentHash TEXT);
    CREATE TABLE sourceFiles(id INTEGER,importFileId INTEGER,contentHash TEXT);
    CREATE TABLE importOriginals(importFileId INTEGER,bytes BLOB,bytesHash TEXT);
    CREATE TABLE importReplacementVersions(id INTEGER,sourceFileId INTEGER,importFileId INTEGER,priorContentHash TEXT,bytes BLOB,bytesHash TEXT)`);
  const bytes=new TextEncoder().encode('original'), hash=hashContent(bytes);
  const wrapped=db as unknown as ReturnType<typeof getDb>;
  db.query('INSERT INTO importFiles VALUES (1,?)').run(hash);
  db.query('INSERT INTO sourceFiles VALUES (1,1,?)').run(hash);
  expect(()=>assertRetainedOriginal(1,wrapped)).toThrow('not retained');
  db.query('INSERT INTO importOriginals VALUES (1,?,?)').run(bytes,hash);
  expect(()=>assertRetainedOriginal(1,wrapped)).not.toThrow();
  db.query("UPDATE importOriginals SET bytesHash='corrupt'").run();
  expect(()=>assertRetainedOriginal(1,wrapped)).toThrow('integrity');
  db.exec('DELETE FROM importOriginals');
  const replacement=new TextEncoder().encode('approved replacement');
  db.query('INSERT INTO importReplacementVersions VALUES(1,1,1,?,?,?)').run(hash,replacement,hashContent(replacement));
  expect(()=>assertRetainedOriginal(1,wrapped)).not.toThrow();
  db.query("UPDATE importReplacementVersions SET bytesHash='corrupt'").run();
  expect(()=>assertRetainedOriginal(1,wrapped)).toThrow('not retained');
  db.close();
});
