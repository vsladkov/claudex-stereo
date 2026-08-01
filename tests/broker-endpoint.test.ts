import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createBrokerEndpoint,
  parseBrokerEndpoint,
} from '../plugins/stereo/src/broker/endpoint.ts';

test('createBrokerEndpoint uses Unix sockets on non-Windows platforms', () => {
  const endpoint = createBrokerEndpoint('/tmp/cxc-12345', 'darwin');
  assert.equal(endpoint, 'unix:/tmp/cxc-12345/broker.sock');
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: 'unix',
    path: '/tmp/cxc-12345/broker.sock',
  });
});

test('createBrokerEndpoint uses named pipes on Windows', () => {
  const endpoint = createBrokerEndpoint('C:\\\\Temp\\\\cxc-12345', 'win32');
  assert.equal(endpoint, 'pipe:\\\\.\\pipe\\cxc-12345-codex-app-server');
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: 'pipe',
    path: '\\\\.\\pipe\\cxc-12345-codex-app-server',
  });
});

test(
  'the Windows named-pipe endpoint round-trips one line',
  { skip: process.platform !== 'win32' },
  async () => {
    const endpoint = createBrokerEndpoint(
      path.join(os.tmpdir(), `stereo-endpoint-${process.pid}-${Date.now()}`),
      'win32',
    );
    const target = parseBrokerEndpoint(endpoint);
    assert.equal(target.kind, 'pipe');

    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => socket.end(`reply:${chunk.toString('utf8')}`));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.path, resolve);
    });

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(target.path);
        let received = '';
        client.setEncoding('utf8');
        client.once('connect', () => client.write('ping\n'));
        client.on('data', (chunk) => {
          received += chunk;
        });
        client.once('end', () => resolve(received));
        client.once('error', reject);
      });
      assert.equal(response, 'reply:ping\n');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
