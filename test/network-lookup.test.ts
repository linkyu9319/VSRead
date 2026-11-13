import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { pinnedLookup } from '../src/extension/online/network';

test('固定DNS地址兼容Node自动选择地址族的真实HTTP连接', async () => {
  const server = createServer((_request, response) => response.end('connected'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const options = {
        autoSelectFamily: true,
        lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }),
      };
      const request = get(`http://fixture.invalid:${port}/`, options, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.once('end', () => resolve(text));
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(body, 'connected');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
