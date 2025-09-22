/**
 * Matter Bridge Implementation
 *
 * Main interface for Homebridge to interact with Matter.js
 * Manages the Matter server and device lifecycle
 */

import { Logger } from '../logger.js'
import { PlatformAccessory } from '../platformAccessory.js'
import { MatterDevice } from './matterDevice.js'
import { MatterServer, MatterServerConfig } from './matterServer.js'

const log = Logger.withPrefix('Matter')

/**
 * Main Matter bridge class that manages the Matter integration
 */
export class MatterBridge {
  private matterServer: MatterServer | null = null
  private isInitialized = false

  constructor(config: MatterServerConfig = {}) {
    // Create Matter server with provided config
    this.matterServer = new MatterServer(config)
  }

  /**
   * Initialize and start the Matter server
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log.warn('Matter bridge already initialized')
      return
    }

    if (!this.matterServer) {
      throw new Error('Matter server not created')
    }

    try {
      log.info('Initializing Matter bridge...')

      // Start the Matter server
      await this.matterServer.start()

      this.isInitialized = true

      const info = this.matterServer.getInfo()
      log.info(`Matter bridge initialized on port ${info.port}`)
      log.info('Homebridge is now ready to bridge accessories to Matter')
    } catch (error) {
      log.error('Failed to initialize Matter bridge:', error)
      throw error
    }
  }

  /**
   * Add a HAP accessory to the Matter bridge
   */
  async createBridgedEndpoint(accessory: PlatformAccessory): Promise<MatterDevice | null> {
    if (!this.isInitialized || !this.matterServer) {
      log.error('Matter bridge not initialized')
      return null
    }

    try {
      // Add accessory to Matter server
      const device = await this.matterServer.addAccessory(accessory)

      if (device) {
        log.info(`Successfully bridged ${accessory.displayName} to Matter`)
      }

      return device
    } catch (error) {
      log.error(`Failed to bridge accessory ${accessory.displayName}:`, error)
      return null
    }
  }

  /**
   * Remove a bridged accessory from Matter
   */
  async removeBridgedEndpoint(accessory: PlatformAccessory): Promise<void> {
    if (!this.isInitialized || !this.matterServer) {
      log.error('Matter bridge not initialized')
      return
    }

    try {
      await this.matterServer.removeAccessory(accessory)
      log.info(`Removed ${accessory.displayName} from Matter bridge`)
    } catch (error) {
      log.error(`Failed to remove accessory ${accessory.displayName}:`, error)
    }
  }

  /**
   * Get Matter server information
   */
  getServerInfo(): any {
    if (!this.matterServer) {
      return {
        running: false,
        initialized: false,
      }
    }

    return {
      initialized: this.isInitialized,
      ...this.matterServer.getInfo(),
    }
  }

  /**
   * Get all bridged devices
   */
  getBridgedEndpoints(): Map<string, MatterDevice> {
    if (!this.matterServer) {
      return new Map()
    }

    return this.matterServer.getDevices()
  }

  /**
   * Check if using real Matter implementation
   */
  isUsingRealMatter(): boolean {
    return true // This is the real implementation
  }

  /**
   * Get the port the Matter server is running on
   */
  getPort(): number {
    if (!this.matterServer) {
      return 0
    }
    return this.matterServer.getInfo().port
  }

  /**
   * Check if the Matter bridge is commissioned
   */
  isCommissioned(): boolean {
    if (!this.matterServer) {
      return false
    }
    return this.matterServer.isCommissioned()
  }

  /**
   * Get commissioning information for the Matter bridge
   */
  getCommissioningInfo(): {
    qrCode?: string
    manualPairingCode?: string
    passcode?: number
    discriminator?: number
    commissioned: boolean
  } {
    if (!this.matterServer) {
      return {
        commissioned: false,
      }
    }
    return this.matterServer.getCommissioningInfo()
  }

  /**
   * Clean up and stop the Matter bridge
   */
  async cleanup(): Promise<void> {
    log.info('Cleaning up Matter bridge...')

    if (this.matterServer) {
      await this.matterServer.stop()
    }

    this.isInitialized = false
    this.matterServer = null

    log.info('Matter bridge cleanup completed')
  }
}
