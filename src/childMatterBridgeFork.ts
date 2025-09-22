/**
 * Child Matter Bridge Fork
 *
 * This is a standalone script executed as a child process fork
 * specifically for running Matter bridges in isolation
 */

import type {
  AccessoryConfig,
  HomebridgeConfig,
  PlatformConfig,
} from './bridgeService.js'
import type { Plugin } from './plugin.js'

import process from 'node:process'

import { HAPStorage } from 'hap-nodejs'

import { HomebridgeAPI, InternalAPIEvent, PluginType } from './api.js'
import { Logger } from './logger.js'
import { MatterServer } from './matter/index.js'
import { ChildMatterMessageType } from './matter/matterSharedTypes.js'
import { PlatformAccessory } from './platformAccessory.js'
import { PluginManager } from './pluginManager.js'
import { User } from './user.js'

import 'source-map-support/register.js'

// Re-export for backward compatibility
export { ChildMatterMessageType } from './matter/matterSharedTypes.js'

export interface ChildMatterLoadEventData {
  type: PluginType
  identifier: string
  pluginPath: string
  pluginConfig: PlatformConfig | AccessoryConfig
  matterConfig: {
    port?: number
    name?: string
  }
  homebridgeConfig: HomebridgeConfig
  bridgeOptions: any
}

export interface ChildMatterStatusEventData {
  status: 'pending' | 'ok' | 'down'
  port?: number
  qrCode?: string
  manualPairingCode?: string
  serialNumber?: string
  deviceCount: number
  commissioned?: boolean
  error?: string
}

export interface ChildMatterPortRequestEventData {
  identifier: string
}

export interface ChildMatterPortAllocatedEventData {
  port: number
}

export interface ChildMatterAccessoryEventData {
  accessory: any // Serialized PlatformAccessory
}

/**
 * Child Matter Bridge Fork - runs in separate process
 */
export class ChildMatterBridgeFork {
  private matterServer: MatterServer | null = null
  private api!: HomebridgeAPI
  private pluginManager!: PluginManager

  private type!: PluginType
  private plugin!: Plugin
  private identifier!: string
  private pluginConfig!: PlatformConfig | AccessoryConfig
  private matterConfig!: any
  private _homebridgeConfig!: HomebridgeConfig
  private bridgeOptions!: any

  private accessories: Map<string, PlatformAccessory> = new Map()
  private portRequestCallbacks: Map<string, (port: number | undefined) => void> = new Map()

  constructor() {
    // Set process title
    process.title = 'homebridge: matter bridge'

    // Check for debug flag in command line arguments
    if (process.argv.includes('-D')) {
      // Enable debug mode for this child process
      Logger.setDebugEnabled(true)
    }

    // Tell parent we're ready
    this.sendMessage(ChildMatterMessageType.READY)

    // Handle IPC messages from parent
    process.on('message', this.handleMessage.bind(this))

    // Handle process termination
    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())
  }

  /**
   * Send message to parent process
   */
  private sendMessage<T = unknown>(type: ChildMatterMessageType, data?: T): void {
    if (process.send) {
      process.send({
        id: type,
        data,
      })
    } else {
      const log = Logger.withPrefix(this.identifier || 'ChildMatterBridge')
      log.error('Cannot send message - process.send not available')
    }
  }

  /**
   * Handle messages from parent process
   */
  private async handleMessage(message: any): Promise<void> {
    if (typeof message !== 'object' || !message.id) {
      return
    }

    switch (message.id) {
      case ChildMatterMessageType.LOAD:
        await this.loadPlugin(message.data)
        break

      case ChildMatterMessageType.START:
        await this.startMatterBridge()
        break

      case ChildMatterMessageType.ADD_ACCESSORY:
        await this.addAccessory(message.data)
        break

      case ChildMatterMessageType.REMOVE_ACCESSORY:
        await this.removeAccessory(message.data)
        break

      case ChildMatterMessageType.PORT_ALLOCATED:
        this.handlePortAllocated(message.data)
        break

      case ChildMatterMessageType.SHUTDOWN:
        await this.shutdown()
        break
    }
  }

  /**
   * Load the plugin and configuration
   */
  private async loadPlugin(data: ChildMatterLoadEventData): Promise<void> {
    this.type = data.type
    this.identifier = data.identifier
    this.pluginConfig = data.pluginConfig
    this.matterConfig = data.matterConfig
    this._homebridgeConfig = data.homebridgeConfig
    this.bridgeOptions = data.bridgeOptions

    // Remove the _matter key from plugin config
    delete this.pluginConfig._matter

    // Set up logging
    if (this.bridgeOptions.noLogTimestamps) {
      Logger.setTimestampEnabled(false)
    }

    if (this.bridgeOptions.debugModeEnabled) {
      Logger.setDebugEnabled(true)
    }

    if (this.bridgeOptions.forceColourLogging) {
      Logger.forceColor()
    }

    if (this.bridgeOptions.customStoragePath) {
      User.setStoragePath(this.bridgeOptions.customStoragePath)
    }

    // Initialize HAP-NodeJS storage
    HAPStorage.setCustomStoragePath(User.persistPath())

    // Create API and plugin manager
    this.api = new HomebridgeAPI()
    this.pluginManager = new PluginManager(this.api)

    // Load the plugin
    this.plugin = this.pluginManager.loadPlugin(data.pluginPath)
    await this.plugin.load()
    await this.pluginManager.initializePlugin(this.plugin, data.identifier)

    // Update process title
    process.title = `homebridge: ${this.plugin.getPluginIdentifier()} matter`

    // Send loaded message
    this.sendMessage(ChildMatterMessageType.LOADED, {
      version: this.plugin.version,
    })
  }

  /**
   * Start the Matter bridge
   */
  private async startMatterBridge(): Promise<void> {
    try {
      const log = Logger.withPrefix(this.matterConfig.name || this.identifier)
      log.info('Starting Matter bridge in child process...')
      log.debug('Matter config:', JSON.stringify(this.matterConfig))

      // Create Matter server with proper storage path
      const storagePath = User.storagePath()
      this.matterServer = new MatterServer({
        port: this.matterConfig.port,
        name: this.matterConfig.name,
        uniqueId: `${this.identifier}-matter`,
        storagePath,
      })

      // Start the server
      await this.matterServer.start()

      const info = this.matterServer.getInfo()
      const commissioningInfo = this.matterServer.getCommissioningInfo()
      log.success(`Matter bridge started on port ${info.port}`)
      log.debug('Matter server info:', JSON.stringify(info))
      log.debug('Commissioning info:', JSON.stringify(commissioningInfo))

      // Send online status with QR code
      const onlineMessage: ChildMatterStatusEventData = {
        status: 'ok',
        port: info.port,
        serialNumber: info.serialNumber,
        deviceCount: this.accessories.size,
        commissioned: info.commissioned,
        qrCode: commissioningInfo.qrCode,
        manualPairingCode: commissioningInfo.manualPairingCode,
      }
      log.debug('Sending ONLINE message:', JSON.stringify(onlineMessage))
      this.sendMessage<ChildMatterStatusEventData>(ChildMatterMessageType.ONLINE, onlineMessage)

      // If this is a platform, initialize it to get accessories
      if (this.type === PluginType.PLATFORM) {
        await this.initializePlatform()
      }
    } catch (error: any) {
      const log = Logger.withPrefix(this.identifier)
      log.error('Failed to start Matter bridge:', error)
      log.error('Stack trace:', error.stack)

      // Send more detailed error info
      this.sendMessage<ChildMatterStatusEventData>(ChildMatterMessageType.STATUS_UPDATE, {
        status: 'down',
        deviceCount: 0,
        error: `${error.message}\n${error.stack}`,
      })

      // Also send a failure message so parent knows startup failed
      this.sendMessage(ChildMatterMessageType.ERROR, {
        message: error.message,
        stack: error.stack,
      })
    }
  }

  /**
   * Initialize platform to get accessories
   */
  private async initializePlatform(): Promise<void> {
    if (this.type !== PluginType.PLATFORM) {
      return
    }

    // Ensure we have a platform config
    const platformConfig = this.pluginConfig as PlatformConfig
    if (!platformConfig.platform) {
      const log = Logger.withPrefix(this.identifier)
      log.error('Platform configuration missing platform identifier')
      return
    }

    const platformConstructor = this.plugin.getPlatformConstructor(platformConfig.platform)
    const logger = Logger.withPrefix(platformConfig.name || this.identifier)

    // Initialize the platform - it will emit events through the API
    // We don't need to store the instance as it manages itself through events
    void new platformConstructor(logger, platformConfig, this.api)

    // Listen for accessory registration
    this.api.on(InternalAPIEvent.REGISTER_PLATFORM_ACCESSORIES, (accessories: PlatformAccessory[]) => {
      accessories.forEach(accessory => this.addAccessoryToMatter(accessory))
    })

    this.api.on(InternalAPIEvent.UNREGISTER_PLATFORM_ACCESSORIES, (accessories: PlatformAccessory[]) => {
      accessories.forEach(accessory => this.removeAccessoryFromMatter(accessory))
    })

    // Signal API finished
    this.api.signalFinished()
  }

  /**
   * Add an accessory to the Matter bridge
   */
  private async addAccessory(data: ChildMatterAccessoryEventData): Promise<void> {
    // Deserialize the accessory
    const accessory = PlatformAccessory.deserialize(data.accessory)
    await this.addAccessoryToMatter(accessory)
  }

  /**
   * Add accessory to Matter server
   */
  private async addAccessoryToMatter(accessory: PlatformAccessory): Promise<void> {
    if (!this.matterServer) {
      return
    }

    const log = Logger.withPrefix(this.identifier)

    try {
      const device = await this.matterServer.addAccessory(accessory)
      if (device) {
        this.accessories.set(accessory.UUID, accessory)
        log.info(`Added ${accessory.displayName} to Matter bridge`)

        // Send status update with commissioning info
        const commissioningInfo = this.matterServer.getCommissioningInfo()
        this.sendMessage<ChildMatterStatusEventData>(ChildMatterMessageType.STATUS_UPDATE, {
          status: 'ok',
          deviceCount: this.accessories.size,
          qrCode: commissioningInfo.qrCode,
          manualPairingCode: commissioningInfo.manualPairingCode,
          commissioned: commissioningInfo.commissioned,
        })
      }
    } catch (error: any) {
      log.error(`Failed to add accessory ${accessory.displayName}:`, error)
    }
  }

  /**
   * Remove an accessory from the Matter bridge
   */
  private async removeAccessory(data: ChildMatterAccessoryEventData): Promise<void> {
    const accessory = PlatformAccessory.deserialize(data.accessory)
    await this.removeAccessoryFromMatter(accessory)
  }

  /**
   * Remove accessory from Matter server
   */
  private async removeAccessoryFromMatter(accessory: PlatformAccessory): Promise<void> {
    if (!this.matterServer) {
      return
    }

    const log = Logger.withPrefix(this.identifier)

    try {
      await this.matterServer.removeAccessory(accessory)
      this.accessories.delete(accessory.UUID)
      log.info(`Removed ${accessory.displayName} from Matter bridge`)

      // Send status update with commissioning info
      const commissioningInfo = this.matterServer.getCommissioningInfo()
      this.sendMessage<ChildMatterStatusEventData>(ChildMatterMessageType.STATUS_UPDATE, {
        status: 'ok',
        deviceCount: this.accessories.size,
        qrCode: commissioningInfo.qrCode,
        manualPairingCode: commissioningInfo.manualPairingCode,
        commissioned: commissioningInfo.commissioned,
      })
    } catch (error: any) {
      log.error(`Failed to remove accessory ${accessory.displayName}:`, error)
    }
  }

  /**
   * Request a port from the parent process
   */
  public async requestPort(identifier: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      this.portRequestCallbacks.set(identifier, resolve)
      this.sendMessage<ChildMatterPortRequestEventData>(ChildMatterMessageType.PORT_REQUEST, {
        identifier,
      })

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.portRequestCallbacks.has(identifier)) {
          this.portRequestCallbacks.delete(identifier)
          resolve(undefined)
        }
      }, 5000)
    })
  }

  /**
   * Handle port allocation response
   */
  private handlePortAllocated(data: ChildMatterPortAllocatedEventData): void {
    const callbacks = Array.from(this.portRequestCallbacks.values())
    this.portRequestCallbacks.clear()
    callbacks.forEach(callback => callback(data.port))
  }

  /**
   * Shutdown the child process
   */
  private async shutdown(): Promise<void> {
    const log = Logger.withPrefix(this.identifier)
    log.info('Shutting down Matter bridge child process...')

    if (this.matterServer) {
      await this.matterServer.stop()
    }

    process.exit(0)
  }
}

// Start the child process
void new ChildMatterBridgeFork()
