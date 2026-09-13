import { expect, test } from 'bun:test';
import { generateParserVersions } from '../../scripts/parser-versions';
import versions from './importParsers/versions.json';
import { IMPORT_PARSERS } from './importParsers';

test('every registered parser has a current dependency fingerprint', async () => {
  expect(Object.keys(versions).sort()).toEqual(IMPORT_PARSERS.map(parser => parser.id).sort());
  expect(await generateParserVersions()).toEqual(versions);
});
