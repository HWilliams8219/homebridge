/**
 * Matter Protocol Support for Homebridge
 *
 * This module provides Matter protocol support alongside the existing HAP bridge,
 * allowing Homebridge accessories to be exposed to Matter-compatible controllers.
 */

export { MatterBridge } from './matterBridge.js'
export { type MatterConfigValidationResult, MatterConfigValidator } from './matterConfigValidator.js'
export { MatterDevice } from './matterDevice.js'
export { MatterServer } from './matterServer.js'
export { type MatterBridgeOptions, type MatterConfiguration } from './matterTypes.js'
export {
  getMatterClustersForHAPService,
  getMatterDeviceTypeForHAPService,
  HAPToMatterClusterMapping,
  HAPToMatterDeviceMapping,
  MatterClusters,
  MatterDeviceTypes,
} from './matterTypes.js'
