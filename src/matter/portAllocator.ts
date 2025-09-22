/**
 * Port Allocator for Matter Bridges
 *
 * Thread-safe port allocation with conflict prevention
 * and automatic port discovery
 */

import * as net from 'node:net'

import { Logger } from '../logger.js'

const log = Logger.withPrefix('Matter')

/**
 * Simple mutex implementation for synchronization
 */
class Mutex {
  private queue: Array<() => void> = []
  private locked = false
  private readonly MAX_QUEUE_SIZE = 100 // Prevent unbounded growth

  /**
   * Acquire the lock
   */
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }

    // Prevent queue from growing unbounded
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error(`Port allocator queue exceeded maximum size (${this.MAX_QUEUE_SIZE})`)
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  /**
   * Release the lock
   */
  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  /**
   * Run a function exclusively with the lock
   */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/**
 * Port allocation result
 */
export interface PortAllocation {
  port: number
  type: 'matter' | 'hap'
  identifier: string
  allocated: Date
}

/**
 * Port allocator with thread-safe allocation and tracking
 */
export class PortAllocator {
  private static instance: PortAllocator
  private allocatedPorts = new Map<number, PortAllocation>()
  private reservedRanges = new Map<string, { start: number, end: number }>()
  private mutex = new Mutex()
  private defaultMatterStart = 5540
  private defaultMatterEnd = 5580
  private defaultHAPStart = 51826
  private defaultHAPEnd = 51926

  private constructor() {
    // Reserve default ranges
    this.reservedRanges.set('matter', {
      start: this.defaultMatterStart,
      end: this.defaultMatterEnd,
    })
    this.reservedRanges.set('hap', {
      start: this.defaultHAPStart,
      end: this.defaultHAPEnd,
    })
  }

  /**
   * Get singleton instance
   */
  static getInstance(): PortAllocator {
    if (!PortAllocator.instance) {
      PortAllocator.instance = new PortAllocator()
    }
    return PortAllocator.instance
  }

  /**
   * Allocate a port for Matter or HAP
   */
  async allocatePort(
    type: 'matter' | 'hap',
    identifier: string,
    preferredPort?: number,
  ): Promise<number> {
    return this.mutex.runExclusive(async () => {
      // Try preferred port first
      if (preferredPort) {
        if (await this.isPortAvailable(preferredPort)) {
          this.allocatedPorts.set(preferredPort, {
            port: preferredPort,
            type,
            identifier,
            allocated: new Date(),
          })
          log.info(`Allocated port ${preferredPort} for ${type} bridge: ${identifier}`)
          return preferredPort
        } else {
          log.warn(`Preferred port ${preferredPort} is not available for ${identifier}`)
        }
      }

      // Find an available port in the appropriate range
      const range = this.reservedRanges.get(type)
      if (!range) {
        throw new Error(`No port range defined for type: ${type}`)
      }

      for (let port = range.start; port <= range.end; port++) {
        if (!this.allocatedPorts.has(port) && await this.isPortAvailable(port)) {
          this.allocatedPorts.set(port, {
            port,
            type,
            identifier,
            allocated: new Date(),
          })
          log.info(`Allocated port ${port} for ${type} bridge: ${identifier}`)
          return port
        }
      }

      // If no port in range is available, try to find any available port
      const fallbackPort = await this.findAvailablePort()
      this.allocatedPorts.set(fallbackPort, {
        port: fallbackPort,
        type,
        identifier,
        allocated: new Date(),
      })
      log.warn(`Allocated fallback port ${fallbackPort} for ${type} bridge: ${identifier}`)
      return fallbackPort
    })
  }

  /**
   * Release an allocated port
   */
  async releasePort(port: number): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const allocation = this.allocatedPorts.get(port)
      if (allocation) {
        this.allocatedPorts.delete(port)
        log.debug(`Released port ${port} (was allocated to ${allocation.identifier})`)
      }
    })
  }

  /**
   * Release all ports for an identifier
   */
  async releasePorts(identifier: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const portsToRelease: number[] = []

      for (const [port, allocation] of this.allocatedPorts) {
        if (allocation.identifier === identifier) {
          portsToRelease.push(port)
        }
      }

      for (const port of portsToRelease) {
        this.allocatedPorts.delete(port)
        log.debug(`Released port ${port} for identifier ${identifier}`)
      }
    })
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    // Check if already allocated by us
    if (this.allocatedPorts.has(port)) {
      return false
    }

    // Check if port is actually available on the system
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false)
        } else {
          // Other errors, assume port is not available
          resolve(false)
        }
      })

      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })

      server.listen(port, '0.0.0.0')
    })
  }

  /**
   * Find any available port
   */
  private async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()

      server.once('error', (err) => {
        reject(err)
      })

      server.once('listening', () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          const port = address.port
          server.close(() => {
            resolve(port)
          })
        } else {
          server.close()
          reject(new Error('Could not determine port'))
        }
      })

      // Listen on port 0 to get a random available port
      server.listen(0, '0.0.0.0')
    })
  }

  /**
   * Get all allocated ports
   */
  getAllocatedPorts(): Map<number, PortAllocation> {
    return new Map(this.allocatedPorts)
  }

  /**
   * Check for port conflicts
   */
  async checkForConflicts(): Promise<Array<{ port: number, identifier: string, available: boolean }>> {
    const conflicts: Array<{ port: number, identifier: string, available: boolean }> = []

    for (const [port, allocation] of this.allocatedPorts) {
      const available = await this.isPortAvailable(port)
      if (!available) {
        conflicts.push({
          port,
          identifier: allocation.identifier,
          available,
        })
      }
    }

    return conflicts
  }

  /**
   * Clear all allocations (use with caution)
   */
  clearAllocations(): void {
    this.allocatedPorts.clear()
    log.warn('Cleared all port allocations')
  }

  /**
   * Set custom port range for a type
   */
  setPortRange(type: 'matter' | 'hap', start: number, end: number): void {
    if (start < 1024 || end > 65535 || start > end) {
      throw new Error('Invalid port range')
    }

    this.reservedRanges.set(type, { start, end })
    log.info(`Set ${type} port range to ${start}-${end}`)
  }

  /**
   * Get statistics about port allocation
   */
  getStats(): {
    totalAllocated: number
    matterPorts: number
    hapPorts: number
    oldestAllocation?: Date
    newestAllocation?: Date
  } {
    let matterPorts = 0
    let hapPorts = 0
    let oldest: Date | undefined
    let newest: Date | undefined

    for (const allocation of this.allocatedPorts.values()) {
      if (allocation.type === 'matter') {
        matterPorts++
      } else {
        hapPorts++
      }

      if (!oldest || allocation.allocated < oldest) {
        oldest = allocation.allocated
      }
      if (!newest || allocation.allocated > newest) {
        newest = allocation.allocated
      }
    }

    return {
      totalAllocated: this.allocatedPorts.size,
      matterPorts,
      hapPorts,
      oldestAllocation: oldest,
      newestAllocation: newest,
    }
  }
}

// Export singleton instance
export const portAllocator = PortAllocator.getInstance()
