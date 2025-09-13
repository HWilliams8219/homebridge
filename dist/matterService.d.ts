import { HomebridgeAPI } from './api.js';
import { ExternalPortService } from './externalPortService.js';
import { PlatformAccessory } from './platformAccessory.js';
import { PluginManager } from './pluginManager.js';
import { HomebridgeOptions } from './server.js';
import '@matter/main';
export interface MatterConfiguration {
    enabled?: boolean;
    port?: number;
    discriminator?: number;
    passcode?: number;
    vendorId?: number;
    productId?: number;
    deviceName?: string;
    deviceType?: number;
    storageDir?: string;
    debugEnabled?: boolean;
    interfaceName?: string;
    announceInterval?: number;
    commissioningTimeout?: number;
}
export interface MatterBridgeOptions extends HomebridgeOptions {
    matterConfig?: MatterConfiguration;
}
/**
 * Matter service for publishing accessories via Matter protocol
 * This runs alongside the existing HAP bridge service
 */
export declare class MatterService {
    private matterConfiguration;
    private pluginManager;
    private externalPortService;
    private api;
    private options;
    private matterServer;
    private commissioningServer;
    private storageManager;
    private readonly isEnabled;
    private readonly matterConfig;
    private publishedAccessories;
    private isInitialized;
    private isStarted;
    constructor(matterConfiguration: MatterConfiguration, pluginManager: PluginManager, externalPortService: ExternalPortService, api: HomebridgeAPI, options: HomebridgeOptions);
    /**
     * Validate Matter configuration parameters
     */
    private validateConfiguration;
    /**
     * Initialize the Matter server if enabled
     */
    initialize(): Promise<void>;
    /**
     * Initialize storage for Matter server
     */
    private initializeStorage;
    /**
     * Create the Matter server node
     */
    private createMatterServer;
    /**
     * Setup commissioning server for device pairing
     */
    private setupCommissioningServer;
    /**
     * Generate a unique serial number for the Matter bridge
     */
    private generateSerialNumber;
    /**
     * Generate a unique identifier for the Matter bridge
     */
    private generateUniqueId;
    /**
     * Log commissioning information for users
     */
    private logCommissioningInfo;
    /**
     * Format passcode for manual pairing
     */
    private formatPairingCode;
    /**
     * Start the Matter server
     */
    start(): Promise<void>;
    /**
     * Stop the Matter server
     */
    stop(): Promise<void>;
    /**
     * Clean up resources
     */
    private cleanup;
    /**
     * Publish a platform accessory via Matter protocol
     */
    publishAccessory(accessory: PlatformAccessory): Promise<void>;
    /**
     * Unpublish a platform accessory from Matter protocol
     */
    unpublishAccessory(accessory: PlatformAccessory): Promise<void>;
    /**
     * Convert HAP accessory to Matter device
     * This maps HAP services and characteristics to appropriate Matter clusters and attributes
     */
    private convertToMatterDevice;
    /**
     * Get the primary service from an accessory (excluding utility services)
     */
    private getPrimaryService;
    /**
     * Determine the appropriate Matter device type for a HAP service
     */
    private getMatterDeviceType;
    /**
     * Create a Matter device with the specified type and map characteristics
     */
    private createMatterDevice;
    /**
     * Get placeholder clusters for a device type
     */
    private getPlaceholderClusters;
    /**
     * Map HAP characteristics to Matter cluster attributes
     */
    private mapCharacteristicsToMatter;
    /**
     * Get the Matter cluster name for a HAP characteristic
     */
    private getMatterClusterForCharacteristic;
    /**
     * Get the Matter attribute name for a HAP characteristic
     */
    private getMatterAttributeForCharacteristic;
    /**
     * Get Matter server status
     */
    getStatus(): {
        enabled: boolean;
        running: boolean;
        accessoryCount: number;
        qrCode?: string;
        setupCode?: string;
    };
    /**
     * Get commissioning QR code for setup
     */
    getCommissioningQRCode(): string | null;
    /**
     * Get manual pairing code for setup
     */
    getManualPairingCode(): string | null;
    /**
     * Get list of published accessories
     */
    getPublishedAccessories(): PlatformAccessory[];
    /**
     * Check if an accessory is published via Matter
     */
    isAccessoryPublished(accessory: PlatformAccessory): boolean;
    /**
     * Get Matter configuration (read-only)
     */
    getConfiguration(): Readonly<MatterConfiguration>;
    /**
     * Force restart the Matter server (for configuration changes)
     */
    restart(): Promise<void>;
}
//# sourceMappingURL=matterService.d.ts.map