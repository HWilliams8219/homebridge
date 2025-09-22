/* global NodeJS */

/**
 * Real Matter.js Server Implementation
 *
 * Complete Matter.js integration
 * and official Matter.js v0.15 documentation
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { access } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

import {
  Endpoint,
  Environment,
  ServerNode,
  StorageService,
  VendorId,
} from '@matter/main'
import { AggregatorEndpoint } from '@matter/main/endpoints'
import {
  ManualPairingCodeCodec,
  QrPairingCodeCodec,
} from '@matter/types/schema'
import * as fse from 'fs-extra'
import QRCode from 'qrcode-terminal'

import { Logger } from '../logger.js'
import { PlatformAccessory } from '../platformAccessory.js'
import getVersion from '../version.js'
import { MatterDevice } from './matterDevice.js'
import { diagnostics } from './matterDiagnostics.js'
import { errorHandler } from './matterErrorHandler.js'
import { networkMonitor } from './matterNetworkMonitor.js'
import { MatterServerConfig } from './matterSharedTypes.js'

const log = Logger.withPrefix('Matter')

// Re-export for backward compatibility
export { MatterServerConfig } from './matterSharedTypes.js'

/**
 * Real Matter.js Server for Homebridge
 * Creates a Matter bridge that exposes HAP accessories to Matter controllers
 */
export class MatterServer {
  private serverNode: ServerNode | null = null
  private aggregator: Endpoint<typeof AggregatorEndpoint> | null = null
  private devices: Map<string, MatterDevice> = new Map()
  private removedDevices = new Set<string>() // Track removed devices for restart
  private isRunning = false
  private restartTimer: NodeJS.Timeout | null = null
  private isRestarting = false
  private readonly MAX_DEVICES = 1000 // Maximum number of devices
  private readonly MAX_REMOVED_DEVICES = 10 // Trigger restart after this many removals
  private readonly RESTART_DELAY_MS = 30000 // Delay before restarting server
  private shutdownHandler: (() => Promise<void>) | null = null
  // Internal commissioning values (generated, not user-configurable)
  private passcode: number
  private discriminator: number
  private vendorId: number
  private productId: number

  private commissioningInfo: {
    qrCode?: string
    manualPairingCode?: string
    qrCodeUrl?: string
  } = {}

  private serialNumber?: string

  private cleanupHandlers: Array<() => void | Promise<void>> = []

  constructor(private readonly config: MatterServerConfig = {}) {
    // Store the user config with defaults
    this.config = {
      port: config.port || 5540,
      name: config.name || 'Homebridge Matter Bridge',
      // Use a consistent uniqueId based on the name to ensure storage persistence
      uniqueId: config.uniqueId || `homebridge-matter-${config.name?.replace(/[^a-z0-9]/gi, '-') || 'bridge'}`,
      storagePath: config.storagePath,
      mdnsInterface: config.mdnsInterface,
      ipv4: config.ipv4 !== false, // Default to true
      ipv6: config.ipv6 !== false, // Default to true
    }

    // Generate internal commissioning values
    this.passcode = this.generateSecurePasscode()
    this.discriminator = this.generateRandomDiscriminator()
    this.vendorId = 0xFFF1 // Test vendor ID
    this.productId = 0x8001 // Test product ID
  }

  /**
   * Generate a secure random passcode
   */
  private generateSecurePasscode(): number {
    let passcode: number
    const maxAttempts = 100
    let attempts = 0

    const invalidPasscodes = [
      0,
      11111111,
      22222222,
      33333333,
      44444444,
      55555555,
      66666666,
      77777777,
      88888888,
      99999999,
      12345678,
      87654321,
    ]

    do {
      // Use cryptographically secure random number generation
      const randomBytes = crypto.randomBytes(4)
      const randomValue = randomBytes.readUInt32BE(0)
      passcode = (randomValue % 99999998) + 1

      attempts++
      if (attempts > maxAttempts) {
        throw new Error('Failed to generate secure passcode after maximum attempts')
      }
    } while (
      invalidPasscodes.includes(passcode)
      || passcode.toString().padStart(8, '0').length !== 8
    )

    return passcode
  }

  /**
   * Generate a random discriminator
   */
  private generateRandomDiscriminator(): number {
    // Generate cryptographically secure random 12-bit discriminator (0-4095)
    const randomBytes = crypto.randomBytes(2)
    return randomBytes.readUInt16BE(0) & 0x0FFF // Mask to 12 bits
  }

  /**
   * Start the Matter server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Matter server is already running')
      return
    }

    try {
      log.info('Starting Matter.js server...')
      log.info(`Configuration: Port=${this.config.port}, Passcode=${this.passcode}, Discriminator=${this.discriminator}`)

      // Validate and set up storage path
      await this.setupStorage()

      // Start network monitoring
      networkMonitor.startMonitoring()
      this.cleanupHandlers.push(() => networkMonitor.stopMonitoring())

      // Start diagnostics
      diagnostics.startDiagnostics()
      this.cleanupHandlers.push(() => diagnostics.stopDiagnostics())

      // Create commissioning options
      const commissioningOptions = {
        passcode: this.passcode,
        discriminator: this.discriminator,
      }

      // Ensure we have a name for the bridge
      const bridgeName = this.config.name || 'Homebridge Matter Bridge'

      // Create node options with proper typing
      const nodeOptions = {
        id: this.config.uniqueId!,
        network: {
          port: this.config.port,
          ipv4: this.config.ipv4,
          ipv6: this.config.ipv6,
          mdnsInterface: this.config.mdnsInterface,
        },
        commissioning: commissioningOptions,
        productDescription: {
          name: bridgeName, // This should be the user-visible name
          deviceType: AggregatorEndpoint.deviceType,
        },
        basicInformation: {
          // Try setting nodeLabel to the bridge name instead of product name
          nodeLabel: bridgeName.slice(0, 32), // Maximum 32 characters
          vendorId: VendorId(this.vendorId),
          vendorName: 'Homebridge'.slice(0, 32),
          productId: this.productId,
          productName: 'Homebridge Matter Bridge'.slice(0, 32),
          // Set productLabel to bridge name as well
          productLabel: bridgeName.slice(0, 64), // Maximum 64 characters
          serialNumber: this.serialNumber = this.generateSerialNumber(),
          hardwareVersion: 1,
          hardwareVersionString: os.release(), // Hardware version
          softwareVersion: 1,
          softwareVersionString: getVersion(), // Shows as "Firmware" in Home app
          reachable: true,
        },
      }

      // Create server node with proper configuration
      this.serverNode = await ServerNode.create(nodeOptions)

      // Create aggregator endpoint for bridge pattern
      // The bridge name is set via the ServerNode's basicInformation
      this.aggregator = new Endpoint(AggregatorEndpoint, {
        id: 'homebridge-aggregator',
      })

      // Add aggregator to server
      await this.serverNode.add(this.aggregator)

      // Generate and display commissioning information
      await this.generateCommissioningInfo()

      // Set up graceful shutdown handler
      this.shutdownHandler = async () => {
        log.info('Shutting down Matter server...')
        await this.stop()
      }

      // Register shutdown handlers
      process.on('SIGINT', this.shutdownHandler)
      process.on('SIGTERM', this.shutdownHandler)

      // Start the server in a non-blocking way
      this.serverNode.run().then(
        () => {
          log.info('Matter server stopped normally')
        },
        (error) => {
          log.error('Matter server stopped with error:', error)
          errorHandler.handleError(error, 'server-runtime')
        },
      )

      // Wait for server to be ready
      await this.waitForServerReady()

      this.isRunning = true
      log.info(`✅ Matter server started successfully on port ${this.config.port}`)
      log.info('Homebridge accessories can now be added to Matter controllers')
    } catch (error) {
      log.error('Failed to start Matter server:', error)
      await this.cleanup()
      throw error
    }
  }

  /**
   * Set up and validate storage
   */
  private async setupStorage(): Promise<void> {
    if (!this.config.storagePath) {
      throw new Error('Storage path is required for Matter server')
    }

    // Resolve to absolute path and validate
    const storagePath = path.resolve(this.config.storagePath)
    const normalizedPath = path.normalize(storagePath)

    // Ensure path is within allowed directories
    const allowedBasePaths = [
      path.resolve(os.homedir(), '.homebridge'),
      path.resolve(process.cwd()),
      '/var/lib/homebridge', // Common system location
    ]

    const isAllowed = allowedBasePaths.some(basePath =>
      normalizedPath.startsWith(basePath),
    )

    if (!isAllowed || normalizedPath.includes('..')) {
      throw new Error(`Storage path not allowed: ${normalizedPath}. Must be within homebridge directories.`)
    }

    // Ensure the storage directory exists with proper permissions
    try {
      await fse.ensureDir(normalizedPath)
      await access(normalizedPath, fs.constants.R_OK | fs.constants.W_OK)
    } catch (error) {
      throw new Error(`Storage path not accessible: ${error}`)
    }

    // Create Matter-specific storage directory with bridge-specific subfolder
    const bridgeId = this.config.uniqueId?.replace(/[^a-z0-9-]/gi, '_') || 'default'
    const matterStoragePath = path.join(normalizedPath, '.matter', bridgeId)
    await fse.ensureDir(matterStoragePath)

    // Configure environment to use our storage
    const environment = Environment.default
    const storageService = environment.get(StorageService)
    storageService.location = matterStoragePath

    log.info(`✅ Matter storage initialized at: ${matterStoragePath}`)
  }

  /**
   * Generate serial number for the bridge
   */
  private generateSerialNumber(): string {
    const timestamp = Date.now().toString(36).toUpperCase()
    const random = crypto.randomBytes(2).toString('hex').toUpperCase()
    return `HB-${timestamp}-${random}`
  }

  /**
   * Generate and display commissioning information
   */
  private async generateCommissioningInfo(): Promise<void> {
    const passcode = this.passcode.toString().padStart(8, '0')
    const discriminator = this.discriminator
    const vendorId = this.vendorId
    const productId = this.productId

    // Use Matter.js library to generate pairing codes properly
    // Generate 11-digit code (without vendor/product IDs) for better compatibility
    const manualCode = ManualPairingCodeCodec.encode({
      discriminator,
      passcode: this.passcode,
      // Omit vendorId and productId to generate 11-digit code instead of 21-digit
    })

    // Format as XXXX-XXX-XXXX for display
    const manualPairingCode = `${manualCode.slice(0, 4)}-${manualCode.slice(4, 7)}-${manualCode.slice(7, 11)}`

    const qrCodePayload = QrPairingCodeCodec.encode([{
      version: 0,
      vendorId,
      productId,
      flowType: 0, // Standard commissioning flow
      discoveryCapabilities: 4, // OnNetwork=4
      discriminator,
      passcode: this.passcode,
    }])

    // Store commissioning info
    this.commissioningInfo = {
      qrCode: qrCodePayload,
      manualPairingCode,
    }

    // Display commissioning information
    log.info(`\n${'='.repeat(60)}`)
    log.info('📱 MATTER COMMISSIONING INFORMATION')
    log.info('='.repeat(60))
    log.info(`Manual Pairing Code: ${manualPairingCode}`)
    log.info(`Passcode: ${passcode}`)
    log.info(`Discriminator: ${discriminator}`)
    log.info('\nQR Code for commissioning:')

    // Generate and display QR code in terminal
    QRCode.generate(qrCodePayload, { small: true }, (qrcode) => {
      // eslint-disable-next-line no-console
      console.log(qrcode)
    })

    log.info(`${'='.repeat(60)}\n`)
  }

  /**
   * Wait for the server to be ready
   */
  private async waitForServerReady(maxWaitTime = 5000): Promise<void> {
    const startTime = Date.now()

    while (!this.serverNode || !this.aggregator) {
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error('Server failed to become ready within timeout')
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Additional small delay to ensure everything is initialized
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  /**
   * Add a Homebridge accessory as a bridged Matter device
   */
  async addAccessory(accessory: PlatformAccessory): Promise<MatterDevice | null> {
    if (!this.serverNode || !this.aggregator) {
      log.error('Matter server not started - cannot add accessory')
      return null
    }

    // Check device limit
    if (this.devices.size >= this.MAX_DEVICES) {
      log.error(`Device limit reached (${this.MAX_DEVICES}), cannot add ${accessory.displayName}`)
      return null
    }

    if (this.devices.has(accessory.UUID)) {
      log.debug(`Accessory ${accessory.displayName} already exists as Matter device`)
      return this.devices.get(accessory.UUID) || null
    }

    try {
      log.info(`Adding Matter device: ${accessory.displayName}`)

      // Create Matter device from HAP accessory
      const matterDevice = new MatterDevice(accessory)
      const endpoint = await matterDevice.createEndpoint()

      if (!endpoint) {
        log.warn(`Could not create Matter endpoint for: ${accessory.displayName}`)
        return null
      }

      // Add to aggregator (bridge)
      log.debug(`Adding endpoint to aggregator for ${accessory.displayName} (UUID: ${accessory.UUID})`)
      await this.aggregator.add(endpoint)

      // Store for management
      this.devices.set(accessory.UUID, matterDevice)

      // Set up bidirectional sync
      matterDevice.startSync()

      log.info(`Added Matter device: ${accessory.displayName} (${matterDevice.getDeviceType()})`)
      return matterDevice
    } catch (error) {
      log.error(`Failed to add Matter device for ${accessory.displayName}:`, error)
      await errorHandler.handleError(error as Error, 'add-accessory')
      return null
    }
  }

  /**
   * Remove a Matter device
   */
  async removeAccessory(accessory: PlatformAccessory): Promise<void> {
    const device = this.devices.get(accessory.UUID)
    if (!device) {
      log.debug(`No Matter device found for: ${accessory.displayName}`)
      return
    }

    try {
      // Stop sync
      device.stopSync()

      // Get endpoint to remove
      const endpoint = await device.getEndpoint()

      if (endpoint && this.aggregator) {
        // Remove from aggregator
        // Note: Matter.js v0.15 doesn't provide a direct API to remove endpoints
        // from an aggregator after they're added. This is a limitation of the current API.
        // The endpoint will be cleaned up when the server stops.
        log.debug('Endpoint marked for removal - will be cleaned up on server restart')

        // Track removed devices and schedule restart if threshold reached
        this.removedDevices.add(accessory.UUID)

        if (this.removedDevices.size >= this.MAX_REMOVED_DEVICES) {
          log.warn(`Reached ${this.MAX_REMOVED_DEVICES} removed devices - scheduling Matter server restart in 30 seconds`)
          this.scheduleRestart()
        }
      }

      // Clean up device
      await device.destroy()
      this.devices.delete(accessory.UUID)

      log.info(`Removed Matter device: ${accessory.displayName}`)
    } catch (error) {
      log.error(`Failed to remove Matter device for ${accessory.displayName}:`, error)
      await errorHandler.handleError(error as Error, 'remove-accessory')
    }
  }

  /**
   * Schedule a server restart to clean up removed endpoints
   */
  private scheduleRestart(): void {
    // Prevent scheduling if already restarting
    if (this.isRestarting) {
      log.debug('Restart already in progress, skipping schedule')
      return
    }

    // Cancel any existing restart timer
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
    }

    this.restartTimer = setTimeout(async () => {
      // Check again in case state changed
      if (this.isRestarting) {
        log.debug('Restart already in progress, skipping')
        return
      }

      this.isRestarting = true
      log.info('Restarting Matter server to clean up removed endpoints...')

      try {
        // Save current devices
        const currentDevices = Array.from(this.devices.values())

        // Stop server
        await this.stop()

        // Clear removed devices tracking
        this.removedDevices.clear()

        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Restart server
        await this.start()

        // Re-add current devices
        for (const device of currentDevices) {
          const accessory = device.getAccessory()
          if (accessory) {
            await this.addAccessory(accessory)
          }
        }

        log.info('Matter server restarted successfully')
      } catch (error) {
        log.error('Failed to restart Matter server:', error)
      } finally {
        this.isRestarting = false
        this.restartTimer = null
      }
    }, this.RESTART_DELAY_MS)
  }

  /**
   * Get server information
   */
  getInfo(): {
    running: boolean
    port: number
    deviceCount: number
    config: MatterServerConfig
    serialNumber?: string
    commissioned?: boolean
  } {
    // Record diagnostics info (async, fire and forget)
    diagnostics.collectDiagnostics({
      enabled: true,
      initialized: this.serverNode !== null,
      running: this.isRunning,
      port: this.config.port,
      deviceCount: this.devices.size,
      bridgeCount: 1,
    }).catch(error => log.debug('Failed to collect diagnostics:', error))

    return {
      running: this.isRunning,
      port: this.config.port!,
      deviceCount: this.devices.size,
      config: this.config,
      serialNumber: this.serialNumber,
      commissioned: this.isCommissioned(),
    }
  }

  /**
   * Get commissioning information
   */
  getCommissioningInfo(): {
    qrCode?: string
    manualPairingCode?: string
    commissioned: boolean
  } {
    return {
      ...this.commissioningInfo,
      commissioned: this.isCommissioned(),
    }
  }

  /**
   * Check if the server is commissioned
   */
  isCommissioned(): boolean {
    // Type-safe check for commissioning state
    try {
      const serverState = this.serverNode as any
      return serverState?.state?.commissioning?.commissioned === true
    } catch {
      return false
    }
  }

  /**
   * Get all Matter devices
   */
  getDevices(): Map<string, MatterDevice> {
    return this.devices
  }

  /**
   * Stop the Matter server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    log.info('Stopping Matter server...')

    // Stop monitoring
    networkMonitor.stopMonitoring()
    diagnostics.stopDiagnostics()

    try {
      // Clean up all devices
      for (const device of this.devices.values()) {
        try {
          device.stopSync()
          await device.destroy()
        } catch (error) {
          log.error('Failed to clean up device:', error)
          await errorHandler.handleError(error as Error, 'device-cleanup')
        }
      }
      this.devices.clear()

      // Stop server
      if (this.serverNode) {
        await this.serverNode.close()
      }

      await this.cleanup()
      log.info('Matter server stopped')
    } catch (error) {
      log.error('Error stopping Matter server:', error)
      await errorHandler.handleError(error as Error, 'server-stop')
      throw error
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    // Remove signal handlers
    if (this.shutdownHandler) {
      process.off('SIGINT', this.shutdownHandler)
      process.off('SIGTERM', this.shutdownHandler)
      this.shutdownHandler = null
    }

    // Run all cleanup handlers
    for (const handler of this.cleanupHandlers) {
      try {
        await handler()
      } catch (error) {
        log.debug('Error during cleanup handler:', error)
      }
    }
    this.cleanupHandlers = []

    // Cancel any pending restart
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    // Clear references
    this.serverNode = null
    this.aggregator = null
    this.isRunning = false
    this.commissioningInfo = {}
  }

  /**
   * Clean up all devices
   */
  private async cleanupAllDevices(): Promise<void> {
    const cleanupPromises: Promise<void>[] = []

    for (const [uuid, device] of this.devices.entries()) {
      cleanupPromises.push(
        (async () => {
          try {
            log.debug(`Cleaning up device: ${uuid}`)
            device.stopSync()
            await device.destroy()
          } catch (error) {
            log.error(`Failed to clean up device ${uuid}:`, error)
          }
        })(),
      )
    }

    await Promise.all(cleanupPromises)
    this.devices.clear()
  }
}
