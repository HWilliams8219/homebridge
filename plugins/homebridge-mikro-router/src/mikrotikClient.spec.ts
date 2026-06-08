import * as http from 'http';
import { MikrotikAuthError, MikrotikClient, MikrotikConnectionError } from './mikrotikClient';

function makeServer(statusCode: number, body: string) {
  return http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(body);
  });
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

describe('MikrotikClient.login', () => {
  it('succeeds when router returns 200', async () => {
    const server = makeServer(200, JSON.stringify({ name: 'TestRouter' }));
    const port = await listen(server);

    const client = new MikrotikClient('127.0.0.1', 'admin', 'password', port, false);
    await expect(client.login()).resolves.toBe(true);

    server.close();
  });

  it('throws MikrotikAuthError on 401', async () => {
    const server = makeServer(401, '');
    const port = await listen(server);

    const client = new MikrotikClient('127.0.0.1', 'admin', 'wrongpassword', port, false);
    await expect(client.login()).rejects.toBeInstanceOf(MikrotikAuthError);

    server.close();
  });

  it('throws MikrotikConnectionError when host is unreachable', async () => {
    // Port 1 is almost certainly not listening
    const client = new MikrotikClient('127.0.0.1', 'admin', 'password', 1, false);
    await expect(client.login()).rejects.toBeInstanceOf(MikrotikConnectionError);
  });
});

describe('MikrotikClient.isOnline', () => {
  it('returns true when router is reachable', async () => {
    const server = makeServer(200, JSON.stringify({ name: 'TestRouter' }));
    const port = await listen(server);

    const client = new MikrotikClient('127.0.0.1', 'admin', 'password', port, false);
    await expect(client.isOnline()).resolves.toBe(true);

    server.close();
  });

  it('returns false when router is unreachable', async () => {
    const client = new MikrotikClient('127.0.0.1', 'admin', 'password', 1, false);
    await expect(client.isOnline()).resolves.toBe(false);
  });
});
