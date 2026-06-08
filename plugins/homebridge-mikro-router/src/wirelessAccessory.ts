import type { PlatformAccessory, Service } from '../../../src/platformAccessory';
import type { API, Logging } from '../../../src/index';
import { MikrotikClient } from './mikrotikClient';

export class WirelessAccessory {
  private service: Service;
  private isOn = false;

  constructor(
    private readonly log: Logging,
    private readonly accessory: PlatformAccessory,
    private readonly api: API,
    private readonly client: MikrotikClient,
    private readonly interfaceName: string,
  ) {
    const hap = api.hap;

    this.accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'MikroTik')
      .setCharacteristic(hap.Characteristic.Model, 'Wireless Interface')
      .setCharacteristic(hap.Characteristic.SerialNumber, interfaceName);

    this.service = this.accessory.getService(hap.Service.Switch) ??
      this.accessory.addService(hap.Service.Switch);

    this.service.setCharacteristic(hap.Characteristic.Name, `WiFi: ${interfaceName}`);

    this.service.getCharacteristic(hap.Characteristic.On)
      .onGet(this.handleGet.bind(this))
      .onSet(this.handleSet.bind(this));

    // Poll for state changes every 30 seconds
    setInterval(() => this.refreshState(), 30_000);
    this.refreshState();
  }

  private async handleGet(): Promise<boolean> {
    await this.refreshState();
    return this.isOn;
  }

  private async handleSet(value: unknown): Promise<void> {
    const enabled = value as boolean;
    try {
      await this.client.setWirelessEnabled(this.interfaceName, enabled);
      this.isOn = enabled;
      this.log.info(`Wireless interface "${this.interfaceName}" ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      this.log.error(`Failed to set wireless state: ${(err as Error).message}`);
      throw err;
    }
  }

  private async refreshState(): Promise<void> {
    try {
      const interfaces = await this.client.getWirelessInterfaces();
      const iface = interfaces.find(i => i.name === this.interfaceName);
      if (iface) {
        const newState = !iface.disabled && iface.running;
        if (newState !== this.isOn) {
          this.isOn = newState;
          this.service.updateCharacteristic(this.api.hap.Characteristic.On, this.isOn);
        }
      }
    } catch (err) {
      this.log.debug(`Could not refresh wireless state: ${(err as Error).message}`);
    }
  }
}
