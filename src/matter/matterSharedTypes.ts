/**
 * Shared Matter Types
 *
 * These types are used by both the homebridge core and the UI
 * to ensure consistency across the Matter implementation.
 */

/**
 * Matter bridge status states
 */
export enum MatterBridgeStatus {
  /**
   * When the Matter bridge is loading or restarting
   */
  PENDING = 'pending',

  /**
   * The Matter bridge is online and ready for commissioning
   */
  OK = 'ok',

  /**
   * The bridge is shutting down or stopped
   */
  DOWN = 'down',
}

/**
 * Metadata for a Matter bridge instance
 */
export interface MatterBridgeMetadata {
  /** Bridge type identifier */
  type: 'matter'
  /** Current operational status */
  status: MatterBridgeStatus
  /** Matter server port */
  port?: number
  /** QR code payload for commissioning */
  qrCode?: string
  /** Manual pairing code for commissioning */
  manualPairingCode?: string
  /** Device serial number */
  serialNumber?: string
  /** Display name of the bridge */
  name: string
  /** Plugin identifier */
  plugin: string
  /** Unique identifier for this bridge instance */
  identifier: string
  /** Number of devices exposed by this bridge */
  deviceCount: number
  /** Whether the bridge was manually stopped */
  manuallyStopped?: boolean
  /** Process ID of the bridge if running as child process */
  pid?: number
  /** Whether the bridge has been commissioned */
  commissioned?: boolean
}

/**
 * Matter commissioning information
 */
export interface MatterCommissioningInfo {
  /** QR code payload for commissioning */
  qrCode?: string
  /** Manual pairing code for commissioning */
  manualPairingCode?: string
  /** Device serial number */
  serialNumber?: string
  /** Whether the device is commissioned */
  commissioned: boolean
}

/**
 * Matter accessory information
 */
export interface MatterAccessoryInfo {
  /** Unique identifier */
  uuid: string
  /** Display name */
  displayName: string
  /** HAP category */
  category: number
  /** Matter device information */
  matterInfo?: {
    /** Whether this is a bridged device */
    bridged: boolean
    /** Child bridge identifier if bridged */
    childBridge?: string
    /** Matter device type */
    deviceType?: string
  }
  /** HAP services */
  services?: Array<{
    type: string
    subtype?: string
    displayName?: string
    characteristics: Array<{
      type: string
      value: any
      props: any
    }>
  }>
}

/**
 * Matter server configuration
 */
export interface MatterServerConfig {
  /** Server port */
  port?: number
  /** Bridge name */
  name?: string
  /** Unique identifier */
  uniqueId?: string
  /** Storage path */
  storagePath?: string
  /** mDNS interface */
  mdnsInterface?: string
  /** Enable IPv4 */
  ipv4?: boolean
  /** Enable IPv6 */
  ipv6?: boolean
}

/**
 * Child Matter configuration (extends server config)
 */
export interface ChildMatterConfiguration extends Partial<MatterServerConfig> {
  /** Whether Matter is enabled */
  enabled?: boolean
  /** Bridge name override */
  name?: string
  /** Debug mode flag */
  debug?: boolean
}

/**
 * Matter accessories collection
 */
export interface MatterAccessoriesResponse {
  /** Child bridge accessories indexed by bridge ID */
  children: { [bridgeId: string]: MatterAccessoryInfo[] }
}

/**
 * IPC message types for Matter child bridges
 */
export enum ChildMatterMessageType {
  /** Sent from child when ready to accept config */
  READY = 'ready',
  /** Sent to child with configuration */
  LOAD = 'load',
  /** Sent from child when loaded */
  LOADED = 'loaded',
  /** Sent to child to start the Matter bridge */
  START = 'start',
  /** Sent from child when Matter bridge is online */
  ONLINE = 'online',
  /** Sent to/from child to add an accessory */
  ADD_ACCESSORY = 'addAccessory',
  /** Sent to/from child to remove an accessory */
  REMOVE_ACCESSORY = 'removeAccessory',
  /** Sent from child with status updates */
  STATUS_UPDATE = 'statusUpdate',
  /** Sent from child when requesting a port */
  PORT_REQUEST = 'portRequest',
  /** Sent from child when an error occurs */
  ERROR = 'error',
  /** Sent to child with allocated port */
  PORT_ALLOCATED = 'portAllocated',
  /** Sent to child to shut down */
  SHUTDOWN = 'shutdown',
}
