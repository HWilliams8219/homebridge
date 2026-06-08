import type { DynamicPlatformPlugin } from '../../../src/api';
import type { PlatformAccessory } from '../../../src/platformAccessory';
import type { API, Logging } from '../../../src/index';
import type { PlatformConfig } from '../../../src/bridgeService';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MikrotikAuthError, MikrotikClient, MikrotikConnectionError } from './mikrotikClient';
import { WirelessAccessory } from './wirelessAccessory';

interface MikroRouterConfig extends PlatformConfig {
  host: string;
  port?: number;
  username: string;
  password: string;
  tls?: boolean;
}

export class MikroRouterPlatform implements DynamicPlatformPlugin {
  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private client!: MikrotikClient;

  constructor(
    private readonly log: Logging,
    private readonly config: MikroRouterConfig,
    private readonly api: API,
  ) {
    if (!config.host) {
      log.error('Missing required config field: host');
      return;
    }
    if (!config.username || !config.password) {
      log.error('Missing required config fields: username and/or password');
      return;
    }

    this.client = new MikrotikClient(
      config.host,
      config.username,
      config.password,
      config.port ?? 80,
      config.tls ?? false,
    );

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    this.log.info(`Connecting to MikroTik router at ${this.config.host}…`);

    try {
      await this.client.login();
    } catch (err) {
      if (err instanceof MikrotikAuthError) {
        this.log.error(`Login failed — ${err.message}`);
        this.log.error('Check your username and password in the Homebridge config.');
        return;
      }
      if (err instanceof MikrotikConnectionError) {
        this.log.error(`Connection failed — ${err.message}`);
        this.log.error(`Verify the router address (${this.config.host}:${this.config.port ?? 80}) and that the REST API is enabled.`);
        return;
      }
      this.log.error(`Unexpected error during login: ${(err as Error).message}`);
      return;
    }

    const info = await this.client.getSystemIdentity();
    this.log.info(`Connected to router "${info.identity}" running RouterOS ${info.version} (uptime: ${info.uptime})`);

    let wirelessInterfaces = [];
    try {
      wirelessInterfaces = await this.client.getWirelessInterfaces();
    } catch {
      this.log.info('No wireless interfaces found (or wireless package not installed).');
    }

    for (const iface of wirelessInterfaces) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:wireless:${this.config.host}:${iface.name}`);
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info(`Restoring cached wireless accessory: ${iface.name}`);
        new WirelessAccessory(this.log, existingAccessory, this.api, this.client, iface.name);
      } else {
        this.log.info(`Adding new wireless accessory: ${iface.name}`);
        const accessory = new this.api.platformAccessory(`WiFi ${iface.name}`, uuid);
        new WirelessAccessory(this.log, accessory, this.api, this.client, iface.name);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
    }

    // Remove stale accessories that no longer exist on the router
    for (const [uuid, accessory] of this.accessories) {
      const stillExists = wirelessInterfaces.some(
        iface => this.api.hap.uuid.generate(`${PLUGIN_NAME}:wireless:${this.config.host}:${iface.name}`) === uuid,
      );
      if (!stillExists) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }
}
