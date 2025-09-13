declare const MatterClusters: Record<string, unknown>;
declare const MatterDeviceTypes: Record<string, unknown>;
/**
 * Maps common HomeKit service types to appropriate Matter clusters
 */
export declare const HAPToMatterClusterMapping: Record<string, string[]>;
/**
 * Maps common HomeKit service types to appropriate Matter device types
 */
export declare const HAPToMatterDeviceMapping: Record<string, string>;
/**
 * Helper function to get Matter device type for a HomeKit service
 */
export declare function getMatterDeviceTypeForHAPService(serviceType: string, characteristics?: string[]): string | null;
/**
 * Helper function to get Matter clusters for a HomeKit service
 */
export declare function getMatterClustersForHAPService(serviceType: string, characteristics?: string[]): string[];
export { MatterClusters, MatterDeviceTypes };
//# sourceMappingURL=matterTypes.d.ts.map