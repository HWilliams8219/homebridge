/**
 * Child Matter Bridge Service
 *
 * Manages Matter bridges for individual plugins/accessories running as child bridges.
 * Provides parallel functionality to ChildBridgeService but for Matter protocol.
 */

import type { ChildProcess } from 'node:child_process'

import type { HomebridgeAPI } from './api.js'
import type { AccessoryConfig, HomebridgeConfig, PlatformConfig } from './bridgeService.js'
import type { ExternalPortService } from './externalPortService.js'
import type { IpcService } from './ipcService.js'
import type { Logging } from './logger.js'
import type { ChildMatterConfiguration, MatterBridgeMetadata } from './matter/matterSharedTypes.js'
import type { Plugin } from './plugin.js'
import type { HomebridgeOptions } from './server.js'

import { fork } from 'node:child_process'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { PluginType } from './api.js'
import { ChildMatterLoadEventData, ChildMatterStatusEventData } from './childMatterBridgeFork.js'
import { IpcOutgoingEvent } from './ipcService.js'
import { Logger } from './logger.js'
import { ChildMatterMessageType, MatterBridgeStatus } from './matter/matterSharedTypes.js'
import { portAllocator } from './matter/portAllocator.js'
import { PlatformAccessory } from './platformAccessory.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Re-export for backward compatibility
export { ChildMatterConfiguration } from './matter/matterSharedTypes.js'
export { MatterBridgeStatus as ChildMatterBridgeStatus } from './matter/matterSharedTypes.js'
export { MatterBridgeMetadata as ChildMatterMetadata } from './matter/matterSharedTypes.js'

/**
 * Manages Matter bridges for child plugins/accessories.
 * Each instance represents a separate Matter bridge for a specific plugin configuration.
 */
export class ChildMatterBridgeService {
  private child?: ChildProcess
  private status: MatterBridgeStatus = MatterBridgeStatus.PENDING
  private readonly accessories = new Map<string, PlatformAccessory>()
  private log: Logging
  private readonly displayName: string
  private readonly identifier: string
  private shuttingDown = false
  private childProcessReady = false
  private childBridgeStatus: Partial<{
    port: number
    qrCode: string
    manualPairingCode: string
    serialNumber: string
    commissioned: boolean
  }> = {}

  constructor(
    public type: PluginType,
    public plugin: Plugin,
    public matterConfig: ChildMatterConfiguration,
    private pluginConfig: PlatformConfig | AccessoryConfig,
    private api: HomebridgeAPI,
    private externalPortService: ExternalPortService,
    private homebridgeOptions: HomebridgeOptions,
    private ipcService?: IpcService,
    private homebridgeConfig?: HomebridgeConfig,
  ) {
    // Set identifier based on config type
    if (this.type === PluginType.PLATFORM && 'platform' in this.pluginConfig) {
      this.identifier = `${plugin.getPluginIdentifier()}-${this.pluginConfig.platform}`
    } else if (this.type === PluginType.ACCESSORY && 'accessory' in this.pluginConfig) {
      this.identifier = `${plugin.getPluginIdentifier()}-${this.pluginConfig.accessory}`
    } else {
      this.identifier = `${plugin.getPluginIdentifier()}-external`
    }
    this.displayName = this.matterConfig.name || `${this.pluginConfig.name || plugin.getPluginIdentifier()} Matter Bridge`
    this.log = Logger.withPrefix(this.displayName)

    // Enable debug logging for this Matter bridge if debug flag is set
    if (this.matterConfig.debug) {
      // Note: This enables debug for the parent process logging of this bridge
      // The child process will have its own debug flag set via command-line args
      // We may want to isolate this better in the future
    }

    // Listen for shutdown
    this.api.on('shutdown', () => {
      this.shuttingDown = true
      void this.teardown()
    })

    // Increase max listeners
    this.api.setMaxListeners(this.api.getMaxListeners() + 1)
  }

  /**
   * Start the child Matter bridge
   */
  async start(): Promise<void> {
    if (this.status === MatterBridgeStatus.OK) {
      this.log.warn('Child Matter bridge already started')
      return
    }

    this.status = MatterBridgeStatus.PENDING
    this.sendStatusUpdate()

    // Always start in child process
    await this.startChildProcess()
  }

  /**
   * Start Matter bridge in child process
   */
  private async startChildProcess(): Promise<void> {
    this.log.info('Starting child Matter bridge in separate process...')

    // Prepare arguments for child process
    const args: string[] = []

    // Pass debug flag if enabled for this Matter bridge
    if (this.matterConfig.debug) {
      args.push('-D')
    }

    // Fork the child process
    this.child = fork(resolve(__dirname, 'childMatterBridgeFork.js'), args, {
      silent: false, // Let child handle its own stdio
      env: {
        ...process.env,
        HOMEBRIDGE_CHILD_MATTER_BRIDGE: '1',
      },
    })

    // Handle child process events
    this.child.on('error', (error) => {
      this.log.error('Child process error:', error)
      this.status = MatterBridgeStatus.DOWN
      this.sendStatusUpdate()
    })

    this.child.on('exit', (code, signal) => {
      this.log.warn(`Child process exited (code: ${code}, signal: ${signal})`)
      this.status = MatterBridgeStatus.DOWN
      this.sendStatusUpdate()

      // Restart if not shutting down
      if (!this.shuttingDown && code !== 0) {
        this.log.info('Attempting to restart child process...')
        setTimeout(() => {
          this.startChildProcess().catch((error) => {
            this.log.error('Failed to restart child process:', error)
          })
        }, 5000)
      }
    })

    // Handle IPC messages from child
    this.child.on('message', (message: any) => {
      this.handleChildMessage(message)
    })

    // Wait for child to be ready
    await this.waitForChildReady()

    // Send configuration to child
    await this.loadChildPlugin()

    // Start the Matter bridge in child
    await this.startChildMatterBridge()
  }

  /**
   * Wait for child process to be ready
   */
  private async waitForChildReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Child process did not respond in time'))
      }, 10000)

      const messageHandler = (message: any) => {
        if (message?.id === ChildMatterMessageType.READY) {
          clearTimeout(timeout)
          this.child?.off('message', messageHandler)
          this.childProcessReady = true
          resolve()
        }
      }

      this.child?.on('message', messageHandler)
    })
  }

  /**
   * Send plugin configuration to child
   */
  private async loadChildPlugin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Child process did not load plugin in time'))
      }, 10000)

      const messageHandler = (message: any) => {
        if (message?.id === ChildMatterMessageType.LOADED) {
          clearTimeout(timeout)
          this.child?.off('message', messageHandler)
          this.log.debug(`Child loaded plugin version ${message.data?.version}`)
          resolve()
        }
      }

      this.child?.on('message', messageHandler)

      // Send load message with proper name
      const loadData: ChildMatterLoadEventData = {
        type: this.type,
        identifier: this.identifier,
        pluginPath: this.plugin.getPluginPath(),
        pluginConfig: this.pluginConfig,
        matterConfig: {
          ...this.matterConfig,
          // Ensure we have a proper name for the Matter bridge
          name: this.matterConfig.name || this.displayName,
        },
        homebridgeConfig: this.homebridgeConfig || {} as HomebridgeConfig,
        bridgeOptions: this.homebridgeOptions,
      }

      this.sendToChild(ChildMatterMessageType.LOAD, loadData)
    })
  }

  /**
   * Start Matter bridge in child process
   */
  private async startChildMatterBridge(): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false
      let timeout: ReturnType<typeof setTimeout> | null = null

      // Cleanup function to ensure all listeners are removed

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        if (this.child) {
          // eslint-disable-next-line ts/no-use-before-define
          this.child.off('message', messageHandler)
        }
      }

      // Define message handler
      const messageHandler = (message: any) => {
        if (resolved) {
          return
        } // Prevent multiple resolutions

        this.log.debug('Received message from child:', message?.id)
        if (message?.id === ChildMatterMessageType.ONLINE) {
          resolved = true
          cleanup()

          const data = message.data as ChildMatterStatusEventData
          this.status = MatterBridgeStatus.OK
          this.sendStatusUpdate()
          // Store the child bridge status
          this.childBridgeStatus = {
            port: data.port,
            serialNumber: data.serialNumber,
            commissioned: data.commissioned,
          }
          this.log.success(`Child Matter bridge started on port ${data.port}`)
          resolve()
        } else if (message?.id === ChildMatterMessageType.ERROR) {
          resolved = true
          cleanup()

          const errorData = message.data
          this.log.error(`Child Matter bridge failed to start: ${errorData.message}`)
          if (errorData.stack) {
            this.log.debug('Stack trace:', errorData.stack)
          }
          reject(new Error(`Child Matter bridge failed: ${errorData.message}`))
        }
      }

      // Set timeout
      const timeoutFn = () => {
        if (!resolved) {
          resolved = true
          cleanup()
          this.log.error('Child Matter bridge startup timeout - check logs for details')
          reject(new Error('Child Matter bridge did not start in time (60s timeout)'))
        }
      }
      timeout = setTimeout(timeoutFn, 60000) // 60 seconds

      this.child?.on('message', messageHandler)

      // Send start message
      this.sendToChild(ChildMatterMessageType.START)
    })
  }

  /**
   * Handle messages from child process
   */
  private handleChildMessage(message: any): void {
    if (!message?.id) {
      return
    }

    switch (message.id) {
      case ChildMatterMessageType.STATUS_UPDATE: {
        const data = message.data as ChildMatterStatusEventData
        this.status = data.status === 'ok'
          ? MatterBridgeStatus.OK
          : data.status === 'pending'
            ? MatterBridgeStatus.PENDING
            : MatterBridgeStatus.DOWN

        // Update child bridge status with commissioning info
        if (data.port) {
          this.childBridgeStatus.port = data.port
        }
        if (data.qrCode) {
          this.childBridgeStatus.qrCode = data.qrCode
        }
        if (data.manualPairingCode) {
          this.childBridgeStatus.manualPairingCode = data.manualPairingCode
        }
        if (data.serialNumber) {
          this.childBridgeStatus.serialNumber = data.serialNumber
        }
        if (data.commissioned !== undefined) {
          this.childBridgeStatus.commissioned = data.commissioned
        }

        this.sendStatusUpdate()
        this.log.debug(`Child status update: ${data.status}, devices: ${data.deviceCount}`)
        break
      }
      case ChildMatterMessageType.PORT_REQUEST: {
        void this.handlePortRequest(message.data)
        break
      }
    }
  }

  /**
   * Handle port request from child
   */
  private async handlePortRequest(data: any): Promise<void> {
    try {
      const port = await this.externalPortService.requestPort(data.identifier)
      this.sendToChild(ChildMatterMessageType.PORT_ALLOCATED, { port })
    } catch (error) {
      this.log.error('Failed to allocate port for child:', error)
      this.sendToChild(ChildMatterMessageType.PORT_ALLOCATED, { port: undefined })
    }
  }

  /**
   * Send message to child process
   */
  private sendToChild(type: ChildMatterMessageType, data?: any): void {
    if (this.child && !this.child.killed) {
      this.child.send({ id: type, data })
    }
  }

  /**
   * Add an accessory to the child Matter bridge
   */
  async addAccessory(accessory: PlatformAccessory): Promise<void> {
    if (this.accessories.has(accessory.UUID)) {
      this.log.debug(`Accessory ${accessory.displayName} already added to Matter bridge`)
      return
    }

    // Send accessory to child process
    if (!this.child || this.child.killed || !this.childProcessReady) {
      this.log.error('Cannot add accessory - child process not ready')
      return
    }

    try {
      // Serialize the accessory for IPC
      const serialized = PlatformAccessory.serialize(accessory)
      this.sendToChild(ChildMatterMessageType.ADD_ACCESSORY, { accessory: serialized })

      // Track locally
      this.accessories.set(accessory.UUID, accessory)
      this.log.info(`Sent ${accessory.displayName} to child Matter bridge`)
    } catch (error) {
      this.log.error(`Error sending accessory ${accessory.displayName} to child:`, error)
    }
  }

  /**
   * Remove an accessory from the child Matter bridge
   */
  async removeAccessory(accessory: PlatformAccessory): Promise<void> {
    if (!this.accessories.has(accessory.UUID)) {
      return
    }

    // Send removal to child process
    if (!this.child || this.child.killed || !this.childProcessReady) {
      this.log.error('Cannot remove accessory - child process not ready')
      return
    }

    try {
      // Serialize the accessory for IPC
      const serialized = PlatformAccessory.serialize(accessory)
      this.sendToChild(ChildMatterMessageType.REMOVE_ACCESSORY, { accessory: serialized })

      // Remove from local tracking
      this.accessories.delete(accessory.UUID)
      this.log.info(`Sent removal of ${accessory.displayName} to child Matter bridge`)
    } catch (error) {
      this.log.error(`Error sending accessory removal ${accessory.displayName} to child:`, error)
    }
  }

  /**
   * Get metadata about this child Matter bridge
   */
  getMetadata(): MatterBridgeMetadata {
    return {
      type: 'matter' as const, // Explicitly identify as Matter bridge
      status: this.status,
      port: this.childBridgeStatus.port || this.matterConfig.port,
      qrCode: this.childBridgeStatus.qrCode,
      manualPairingCode: this.childBridgeStatus.manualPairingCode,
      serialNumber: this.childBridgeStatus.serialNumber,
      name: this.displayName,
      plugin: this.plugin.getPluginIdentifier(),
      identifier: this.identifier,
      deviceCount: this.accessories.size,
      manuallyStopped: this.shuttingDown,
      pid: this.child?.pid,
      commissioned: this.childBridgeStatus.commissioned || false,
    }
  }

  /**
   * Get Matter accessories for this child bridge
   */
  getMatterAccessories() {
    const accessories = []

    for (const [uuid, accessory] of this.accessories) {
      // Convert accessory to Matter format for UI
      accessories.push({
        uuid,
        displayName: accessory.displayName,
        category: accessory.category,
        services: accessory.services.map(service => ({
          type: service.UUID,
          subtype: service.subtype,
          displayName: service.displayName,
          characteristics: service.characteristics.map(char => ({
            type: char.UUID,
            value: char.value,
            props: char.props,
          })),
        })),
        matterInfo: {
          bridged: true,
          childBridge: this.identifier,
        },
      })
    }

    return accessories
  }

  /**
   * Stop the child Matter bridge
   */
  async teardown(permanent: boolean = false): Promise<void> {
    if (this.status === MatterBridgeStatus.DOWN) {
      return
    }

    this.log.info('Stopping child Matter bridge...')
    this.status = MatterBridgeStatus.DOWN
    this.sendStatusUpdate()

    // Release allocated ports
    try {
      await portAllocator.releasePorts(this.identifier)
    } catch (error) {
      this.log.debug('Error releasing ports:', error)
    }

    // Match HAP child bridge behavior - just send SIGTERM
    if (this.child && this.child.connected) {
      this.child.kill('SIGTERM')
    }

    this.child = undefined
    this.childProcessReady = false
    this.accessories.clear()

    // If this is a permanent removal, clean up Matter storage
    if (permanent) {
      await this.cleanupMatterStorage()
    }

    this.log.info('Child Matter bridge stopped')
  }

  /**
   * Clean up Matter storage when bridge is permanently removed
   */
  private async cleanupMatterStorage(): Promise<void> {
    try {
      // Get the storage path for this Matter bridge
      // Use customStoragePath if set, otherwise use default Homebridge storage path
      const storagePath = this.homebridgeOptions.customStoragePath || path.join(os.homedir(), '.homebridge')
      if (!storagePath) {
        this.log.debug('No storage path found for Matter cleanup')
        return
      }

      // Construct the Matter storage directory path
      // Matter storage is typically in {storagePath}/.matter/{identifier}
      // Use the bridge's unique ID for storage path consistency
      const bridgeId = this.identifier.replace(/[^a-z0-9-]/gi, '_')
      const matterStoragePath = path.join(storagePath, '.matter', bridgeId)

      // Check if the directory exists
      try {
        await fs.access(matterStoragePath)
      } catch {
        // Directory doesn't exist, nothing to clean up
        this.log.debug(`Matter storage directory not found: ${matterStoragePath}`)
        return
      }

      // Remove the Matter storage directory
      this.log.info(`Cleaning up Matter storage for bridge: ${this.identifier}`)
      await fs.rm(matterStoragePath, { recursive: true, force: true })
      this.log.info(`Successfully removed Matter storage: ${matterStoragePath}`)

      // Also check for legacy storage locations that might exist
      const legacyPaths = [
        path.join(storagePath, `.matter-${this.identifier}`),
        path.join(storagePath, 'matter', this.identifier),
      ]

      for (const legacyPath of legacyPaths) {
        try {
          await fs.access(legacyPath)
          await fs.rm(legacyPath, { recursive: true, force: true })
          this.log.info(`Cleaned up legacy Matter storage: ${legacyPath}`)
        } catch {
          // Legacy path doesn't exist, skip
        }
      }
    } catch (error: any) {
      this.log.error('Failed to clean up Matter storage:', error)
    }
  }

  /**
   * Restart the child Matter bridge
   */
  async restart(): Promise<void> {
    this.log.info('Restarting Matter bridge...')
    // Send pending status immediately
    this.status = MatterBridgeStatus.PENDING
    this.sendStatusUpdate()

    await this.teardown()

    // Wait a moment before restarting
    await new Promise(resolve => setTimeout(resolve, 1000))

    await this.start()
    this.log.success('Matter bridge restarted')
  }

  /**
   * Restart child bridge (IPC interface)
   */
  async restartChildBridge(): Promise<void> {
    return this.restart()
  }

  /**
   * Stop child bridge (IPC interface)
   */
  async stopChildBridge(): Promise<void> {
    return this.teardown()
  }

  /**
   * Start child bridge (IPC interface)
   */
  async startChildBridge(): Promise<void> {
    return this.start()
  }

  /**
   * Allocate a port for the Matter bridge
   */
  private async allocatePort(): Promise<number> {
    // First try to get a port from the external port service
    try {
      const allocated = await this.externalPortService.requestPort(`matter-${this.identifier}`)
      if (allocated) {
        this.log.debug(`Allocated port ${allocated} from external port service`)
        return allocated
      }
    } catch (error) {
      this.log.debug('External port service allocation failed, trying automatic allocation')
    }

    // Fall back to automatic port allocation in Matter range
    const basePort = 5540
    const maxPort = 5580

    // Try to find an available port
    for (let port = basePort; port <= maxPort; port++) {
      if (await this.isPortAvailable(port)) {
        this.log.debug(`Found available port ${port}`)
        return port
      }
    }

    // If no ports available in default range, try random high ports
    for (let i = 0; i < 10; i++) {
      const port = 30000 + Math.floor(Math.random() * 20000)
      if (await this.isPortAvailable(port)) {
        this.log.debug(`Found available random port ${port}`)
        return port
      }
    }

    throw new Error(`Could not allocate port for Matter bridge ${this.displayName}`)
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', () => {
        resolve(false)
      })

      server.once('listening', () => {
        server.close()
        resolve(true)
      })

      server.listen(port, '0.0.0.0')
    })
  }

  /**
   * Send status update via IPC
   */
  private sendStatusUpdate(): void {
    if (this.ipcService) {
      this.ipcService.sendMessage(IpcOutgoingEvent.MATTER_BRIDGE_STATUS_UPDATE, this.getMetadata())
    }
  }

  /**
   * Check if the bridge is running
   */
  isRunning(): boolean {
    return this.status === MatterBridgeStatus.OK
  }

  /**
   * Get the plugin identifier
   */
  getPluginIdentifier(): string {
    return this.plugin.getPluginIdentifier()
  }

  /**
   * Get the display name
   */
  getDisplayName(): string {
    return this.displayName
  }

  /**
   * Get commissioning info for the Matter bridge
   */
  getCommissioningInfo(): {
    qrCode?: string
    manualPairingCode?: string
    commissioned: boolean
  } {
    const metadata = this.getMetadata()
    return {
      qrCode: metadata.qrCode,
      manualPairingCode: metadata.manualPairingCode,
      commissioned: this.childBridgeStatus.commissioned || false,
    }
  }
}
