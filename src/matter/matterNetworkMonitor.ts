/* global NodeJS */

/**
 * Matter Network Monitor
 *
 * Monitors network connectivity and handles recovery
 */

import * as net from 'node:net'
import * as os from 'node:os'

import { Logger } from '../logger.js'
import { errorHandler, MatterErrorType } from './matterErrorHandler.js'

const log = Logger.withPrefix('Matter')

export interface NetworkStatus {
  isOnline: boolean
  interfaces: string[]
  primaryInterface?: string
  lastCheck: Date
  consecutiveFailures: number
}

export class MatterNetworkMonitor {
  private static instance: MatterNetworkMonitor
  private status: NetworkStatus
  private checkInterval: NodeJS.Timeout | null = null
  private callbacks: Set<(status: NetworkStatus) => void> = new Set()
  private checkIntervalMs = 30000 // Check every 30 seconds
  private isMonitoring = false
  private stabilityCounter = 0
  private readonly STABILITY_THRESHOLD = 3

  private constructor() {
    this.status = {
      isOnline: true,
      interfaces: [],
      lastCheck: new Date(),
      consecutiveFailures: 0,
    }
  }

  static getInstance(): MatterNetworkMonitor {
    if (!MatterNetworkMonitor.instance) {
      MatterNetworkMonitor.instance = new MatterNetworkMonitor()
    }
    return MatterNetworkMonitor.instance
  }

  /**
   * Start monitoring network connectivity
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      return
    }

    this.isMonitoring = true
    log.debug('Starting Matter network monitoring')

    // Initial check (fire-and-forget with error handling)
    this.checkNetworkStatus().catch((error) => {
      log.debug('Error during initial network check:', error)
    })

    // Set up periodic checks
    this.checkInterval = setInterval(() => {
      // Fire-and-forget with error handling
      this.checkNetworkStatus().catch((error) => {
        log.debug('Error during periodic network check:', error)
      })
    }, this.checkIntervalMs)

    // Register recovery callback with error handler
    errorHandler.registerRecoveryCallback(
      MatterErrorType.NETWORK,
      async () => this.handleNetworkRecovery(),
    )
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    this.isMonitoring = false
    log.debug('Stopped Matter network monitoring')
  }

  /**
   * Check network status
   */
  private async checkNetworkStatus(): Promise<void> {
    try {
      // Get network interfaces
      const interfaces = this.getActiveInterfaces()

      // Test connectivity with a simple port check
      const isOnline = await this.testConnectivity()

      const previousStatus = this.status.isOnline

      this.status = {
        isOnline,
        interfaces: interfaces.map(i => i.name),
        primaryInterface: interfaces[0]?.name,
        lastCheck: new Date(),
        consecutiveFailures: isOnline ? 0 : this.status.consecutiveFailures + 1,
      }

      // Notify listeners if status changed
      if (previousStatus !== isOnline) {
        this.notifyStatusChange()

        if (!isOnline) {
          this.stabilityCounter = 0
          log.warn('Matter network connectivity lost')
          await errorHandler.handleError(
            new Error('Network connectivity lost'),
            'network-monitor',
          )
        } else {
          this.stabilityCounter = 0
          log.info('Matter network connectivity restored')
          errorHandler.resetErrorCount(MatterErrorType.NETWORK)
        }
      } else if (isOnline) {
        // Increment stability counter when consistently online
        this.stabilityCounter = Math.min(this.stabilityCounter + 1, this.STABILITY_THRESHOLD)
      }

      // Log warnings for repeated failures
      if (this.status.consecutiveFailures > 3) {
        log.error(`Network has been offline for ${this.status.consecutiveFailures} consecutive checks`)
      }
    } catch (error) {
      log.debug('Error checking network status:', error)
    }
  }

  /**
   * Get active network interfaces
   */
  private getActiveInterfaces(): Array<{ name: string, address: string }> {
    const interfaces: Array<{ name: string, address: string }> = []
    const networkInterfaces = os.networkInterfaces()

    for (const [name, addrs] of Object.entries(networkInterfaces)) {
      if (!addrs) {
        continue
      }

      for (const addr of addrs) {
        // Skip internal (loopback) and non-IPv4 addresses
        if (!addr.internal && addr.family === 'IPv4') {
          interfaces.push({ name, address: addr.address })
        }
      }
    }

    return interfaces
  }

  /**
   * Test network connectivity with optimizations
   */
  private async testConnectivity(): Promise<boolean> {
    // If we recently had a successful check, skip the test
    const timeSinceLastCheck = Date.now() - (this.status.lastCheck?.getTime() || 0)
    if (this.status.isOnline && timeSinceLastCheck < 5000 && this.stabilityCounter >= this.STABILITY_THRESHOLD) {
      log.debug('Skipping connectivity test - recent successful check')
      return true
    }

    return new Promise((resolve) => {
      const socket = new net.Socket()
      const timeout = 2000 // Reduced timeout for faster failure detection

      const cleanup = () => {
        socket.destroy()
      }

      socket.setTimeout(timeout)

      socket.once('connect', () => {
        cleanup()
        resolve(true)
      })

      socket.once('error', () => {
        cleanup()
        resolve(false)
      })

      socket.once('timeout', () => {
        cleanup()
        resolve(false)
      })

      // Try multiple fallback servers for redundancy
      const servers = [
        { host: '1.1.1.1', port: 53 }, // Cloudflare DNS
        { host: '8.8.8.8', port: 53 }, // Google DNS
        { host: '9.9.9.9', port: 53 }, // Quad9 DNS
      ]

      // Try first server, with fallback logic if needed
      const server = servers[this.status.consecutiveFailures % servers.length]
      socket.connect(server.port, server.host)
    })
  }

  /**
   * Handle network recovery
   */
  private async handleNetworkRecovery(): Promise<void> {
    log.info('Attempting network recovery...')

    // Force a network check
    await this.checkNetworkStatus()

    if (this.status.isOnline) {
      log.info('Network is online, recovery successful')
    } else {
      log.warn('Network still offline, will retry')
      throw new Error('Network recovery failed')
    }
  }

  /**
   * Register a callback for network status changes
   */
  onStatusChange(callback: (status: NetworkStatus) => void): void {
    this.callbacks.add(callback)
  }

  /**
   * Remove a status change callback
   */
  removeStatusChangeCallback(callback: (status: NetworkStatus) => void): void {
    this.callbacks.delete(callback)
  }

  /**
   * Notify all listeners of status change
   */
  private notifyStatusChange(): void {
    for (const callback of this.callbacks) {
      try {
        callback(this.status)
      } catch (error) {
        log.debug('Error in network status callback:', error)
      }
    }
  }

  /**
   * Get current network status
   */
  getStatus(): NetworkStatus {
    return { ...this.status }
  }

  /**
   * Check if network is healthy
   */
  isHealthy(): boolean {
    return this.status.isOnline && this.status.consecutiveFailures === 0
  }
}

// Export singleton instance
export const networkMonitor = MatterNetworkMonitor.getInstance()
