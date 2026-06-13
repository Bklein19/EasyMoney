import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from '../server/database.js';
import { saveRobinhoodSnapshot } from '../server/robinhoodSnapshots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.resolve(__dirname, '..', 'data', 'robinhood-snapshot.json');
const snapshotPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;

if (!fs.existsSync(snapshotPath)) {
  throw new Error(`Robinhood snapshot JSON not found: ${snapshotPath}`);
}

initDatabase();

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const snapshotId = saveRobinhoodSnapshot(snapshot);

console.log(`Persisted Robinhood snapshot ${snapshotId} from ${snapshotPath}`);
