import { describe, expect, test } from 'bun:test';

import { parseSequoiaFundStatementHtml } from './sequoiaFundHtml.ts';

const statementFixture = `<!doctype html>
<html>
  <head>
    <meta name="csrf-token" content="opaque-meta-token">
    <script>window.activeCSRFtoken = "opaque-script-token";</script>
  </head>
  <body>
    <input type="hidden" name="csrf_token" value="opaque-input-token">
  </body>
</html>`;

describe('Sequoia Fund statement response parsing', () => {
  test('extracts the active statement CSRF token from the HTTP response', () => {
    expect(parseSequoiaFundStatementHtml(statementFixture)).toEqual({
      csrfToken: 'opaque-script-token',
    });
  });

  test('falls back from script state to hidden input and meta state', () => {
    const withoutScriptToken = statementFixture
      .replace('<script>window.activeCSRFtoken = "opaque-script-token";</script>', '')
    expect(parseSequoiaFundStatementHtml(withoutScriptToken).csrfToken).toBe('opaque-input-token');
    expect(parseSequoiaFundStatementHtml(
      withoutScriptToken.replace('<input type="hidden" name="csrf_token" value="opaque-input-token">', ''),
    ).csrfToken).toBe('opaque-meta-token');
  });
});
