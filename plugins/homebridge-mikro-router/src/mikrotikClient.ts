import * as http from 'http';
import * as https from 'https';

export interface RouterInfo {
  identity: string;
  version: string;
  uptime: string;
}

export interface WirelessInterface {
  name: string;
  disabled: boolean;
  running: boolean;
  ssid?: string;
}

export class MikrotikClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly useHttps: boolean;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly port: number = 80,
    useTls = false,
  ) {
    this.useHttps = useTls || port === 443;
    const scheme = this.useHttps ? 'https' : 'http';
    this.baseUrl = `${scheme}://${host}:${port}`;
    this.auth = Buffer.from(`${username}:${password}`).toString('base64');
  }

  async login(): Promise<boolean> {
    try {
      // RouterOS v7+ REST API login validation — a GET on /rest/system/identity
      // requires valid credentials; a 401 means bad credentials, not a network error.
      const data = await this.request('GET', '/rest/system/identity');
      return data !== null;
    } catch (err: unknown) {
      if (err instanceof MikrotikAuthError) {
        throw err;
      }
      throw new MikrotikConnectionError(`Cannot reach router at ${this.host}:${this.port} — ${(err as Error).message}`);
    }
  }

  async getSystemIdentity(): Promise<RouterInfo> {
    const [identity, resource] = await Promise.all([
      this.requestObject('/rest/system/identity'),
      this.requestObject('/rest/system/resource'),
    ]);
    return {
      identity: typeof identity?.['name'] === 'string' ? identity['name'] : this.host,
      version: typeof resource?.['version'] === 'string' ? resource['version'] : 'unknown',
      uptime: typeof resource?.['uptime'] === 'string' ? resource['uptime'] : 'unknown',
    };
  }

  async getWirelessInterfaces(): Promise<WirelessInterface[]> {
    const data = await this.request('GET', '/rest/interface/wireless');
    if (!Array.isArray(data)) {
      return [];
    }
    return data.map((item) => {
      const iface = item as Record<string, string>;
      return {
        name: iface['name'] ?? '',
        disabled: iface['disabled'] === 'true',
        running: iface['running'] === 'true',
        ssid: iface['ssid'],
      };
    });
  }

  async setWirelessEnabled(interfaceName: string, enabled: boolean): Promise<void> {
    const data = await this.request('GET', '/rest/interface/wireless');
    if (!Array.isArray(data)) {
      throw new Error('Could not retrieve wireless interfaces');
    }
    const iface = data.find((item) => (item as Record<string, string>)['name'] === interfaceName) as Record<string, string> | undefined;
    if (!iface) {
      throw new Error(`Wireless interface "${interfaceName}" not found`);
    }
    await this.request('PATCH', `/rest/interface/wireless/${encodeURIComponent(iface['.id'] ?? '')}`, {
      disabled: enabled ? 'false' : 'true',
    });
  }

  private async requestObject(path: string): Promise<Record<string, unknown> | null> {
    const result = await this.request('GET', path);
    if (result === null || Array.isArray(result)) {
      return null;
    }
    return result;
  }

  async isOnline(): Promise<boolean> {
    try {
      await this.request('GET', '/rest/system/identity');
      return true;
    } catch {
      return false;
    }
  }

  private request(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | unknown[] | null> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (this.useHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Basic ${this.auth}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      };

      // Skip TLS verification for self-signed certificates (common on home routers)
      const tlsOptions = this.useHttps ? { rejectUnauthorized: false } : {};
      const requestOptions = { ...options, ...tlsOptions };

      const transport = this.useHttps ? https : http;
      const req = transport.request(requestOptions, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new MikrotikAuthError(`Authentication failed: invalid username or password for user "${this.username}"`));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : null);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

export class MikrotikAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MikrotikAuthError';
  }
}

export class MikrotikConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MikrotikConnectionError';
  }
}
