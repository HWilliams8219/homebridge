/* global NodeJS */

/**
 * Matter Diagnostics
 *
 * Comprehensive diagnostics and health monitoring for Matter integration
 */

import * as os from 'node:os'
import process from 'node:process'

import { Logger } from '../logger.js'
import { errorHandler } from './matterErrorHandler.js'
import { networkMonitor } from './matterNetworkMonitor.js'

const log = Logger.withPrefix('Matter')

export interface DiagnosticInfo {
  timestamp: Date
  system: SystemInfo
  matter: MatterInfo
  network: NetworkInfo
  errors: ErrorInfo
  performance: PerformanceInfo
  health: HealthStatus
}

interface SystemInfo {
  platform: string
  arch: string
  nodeVersion: string
  uptime: number
  memory: {
    total: number
    free: number
    used: number
    percentage: number
  }
  cpu: {
    model: string
    cores: number
    usage: number
  }
}

interface MatterInfo {
  enabled: boolean
  initialized: boolean
  running: boolean
  port?: number
  deviceCount: number
  bridgeCount: number
  version?: string
}

interface NetworkInfo {
  online: boolean
  interfaces: string[]
  primaryInterface?: string
  lastCheck: Date
}

interface ErrorInfo {
  total: number
  byType: Record<string, number>
  recent: Array<{
    type: string
    message: string
    timestamp: Date
  }>
}

interface PerformanceInfo {
  syncLatency: number[]
  averageSyncTime: number
  memoryUsage: number
  eventLoopLag: number
}

interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy'
  issues: string[]
  recommendations: string[]
}

export class MatterDiagnostics {
  private static instance: MatterDiagnostics
  private performanceMetrics: {
    syncTimes: number[]
    startTime: Date
  }

  private diagnosticInterval: NodeJS.Timeout | null = null
  private isDiagnosticsEnabled = false
  private lastHealthStatus: 'healthy' | 'degraded' | 'unhealthy' | null = null

  private constructor() {
    this.performanceMetrics = {
      syncTimes: [],
      startTime: new Date(),
    }
  }

  static getInstance(): MatterDiagnostics {
    if (!MatterDiagnostics.instance) {
      MatterDiagnostics.instance = new MatterDiagnostics()
    }
    return MatterDiagnostics.instance
  }

  /**
   * Start diagnostics collection
   */
  startDiagnostics(intervalMs = 60000): void {
    if (this.isDiagnosticsEnabled) {
      return
    }

    this.isDiagnosticsEnabled = true
    log.debug('Starting Matter diagnostics collection')

    // Collect diagnostics periodically
    this.diagnosticInterval = setInterval(() => {
      // Fire-and-forget with error handling
      this.collectAndLogDiagnostics().catch((error) => {
        log.debug('Failed to collect diagnostics:', error)
      })
    }, intervalMs)
  }

  /**
   * Stop diagnostics collection
   */
  stopDiagnostics(): void {
    if (this.diagnosticInterval) {
      clearInterval(this.diagnosticInterval)
      this.diagnosticInterval = null
    }
    this.isDiagnosticsEnabled = false
    log.debug('Stopped Matter diagnostics collection')
  }

  /**
   * Record sync performance
   */
  recordSyncTime(timeMs: number): void {
    this.performanceMetrics.syncTimes.push(timeMs)

    // Keep only last 100 measurements
    if (this.performanceMetrics.syncTimes.length > 100) {
      this.performanceMetrics.syncTimes.shift()
    }

    // Log warning for slow syncs
    if (timeMs > 1000) {
      log.warn(`Slow Matter sync detected: ${timeMs}ms`)
    }
  }

  /**
   * Collect all diagnostic information
   */
  async collectDiagnostics(matterInfo?: MatterInfo): Promise<DiagnosticInfo> {
    return {
      timestamp: new Date(),
      system: this.collectSystemInfo(),
      matter: matterInfo || this.getDefaultMatterInfo(),
      network: this.collectNetworkInfo(),
      errors: this.collectErrorInfo(),
      performance: this.collectPerformanceInfo(),
      health: this.assessHealth(),
    }
  }

  /**
   * Collect system information
   */
  private collectSystemInfo(): SystemInfo {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem

    const cpus = os.cpus()
    const avgLoad = os.loadavg()[0]

    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptime: os.uptime(),
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        percentage: (usedMem / totalMem) * 100,
      },
      cpu: {
        model: cpus[0]?.model || 'Unknown',
        cores: cpus.length,
        usage: avgLoad,
      },
    }
  }

  /**
   * Get default Matter info
   */
  private getDefaultMatterInfo(): MatterInfo {
    return {
      enabled: false,
      initialized: false,
      running: false,
      deviceCount: 0,
      bridgeCount: 0,
    }
  }

  /**
   * Collect network information
   */
  private collectNetworkInfo(): NetworkInfo {
    const status = networkMonitor.getStatus()
    return {
      online: status.isOnline,
      interfaces: status.interfaces,
      primaryInterface: status.primaryInterface,
      lastCheck: status.lastCheck,
    }
  }

  /**
   * Collect error information
   */
  private collectErrorInfo(): ErrorInfo {
    const errorStats = errorHandler.getErrorStats()
    let total = 0
    const byType: Record<string, number> = {}
    const recent: Array<{ type: string, message: string, timestamp: Date }> = []

    for (const [type, stats] of Object.entries(errorStats)) {
      total += stats.count
      byType[type] = stats.count

      if (stats.lastError) {
        recent.push({
          type,
          message: stats.lastError.message,
          timestamp: stats.lastError.timestamp,
        })
      }
    }

    // Sort recent errors by timestamp
    recent.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    return {
      total,
      byType,
      recent: recent.slice(0, 10), // Keep only 10 most recent
    }
  }

  /**
   * Collect performance information
   */
  private collectPerformanceInfo(): PerformanceInfo {
    const syncTimes = this.performanceMetrics.syncTimes
    const avgSyncTime = syncTimes.length > 0
      ? syncTimes.reduce((a, b) => a + b, 0) / syncTimes.length
      : 0

    return {
      syncLatency: syncTimes.slice(-10), // Last 10 measurements
      averageSyncTime: avgSyncTime,
      memoryUsage: process.memoryUsage().heapUsed,
      eventLoopLag: 0, // Would need additional monitoring
    }
  }

  /**
   * Assess overall health
   */
  private assessHealth(): HealthStatus {
    const issues: string[] = []
    const recommendations: string[] = []

    // Check network
    const networkStatus = networkMonitor.getStatus()
    if (!networkStatus.isOnline) {
      issues.push('Network is offline')
      recommendations.push('Check network connectivity')
    } else if (networkStatus.consecutiveFailures > 0) {
      issues.push('Intermittent network issues detected')
      recommendations.push('Monitor network stability')
    }

    // Check errors
    const errorStats = errorHandler.getErrorStats()
    const totalErrors = Object.values(errorStats)
      .reduce((sum, stat: any) => sum + stat.count, 0)

    if (totalErrors > 10) {
      issues.push(`High error rate: ${totalErrors} errors`)
      recommendations.push('Review error logs for patterns')
    }

    // Check performance
    const perfInfo = this.collectPerformanceInfo()
    if (perfInfo.averageSyncTime > 500) {
      issues.push(`Slow sync performance: ${perfInfo.averageSyncTime.toFixed(0)}ms average`)
      recommendations.push('Consider reducing device count or optimizing sync frequency')
    }

    // Check memory (raised threshold to 95% to reduce false positives)
    const systemInfo = this.collectSystemInfo()
    if (systemInfo.memory.percentage > 95) {
      issues.push(`High memory usage: ${systemInfo.memory.percentage.toFixed(1)}%`)
      recommendations.push('Consider increasing system memory or reducing load')
    } else if (systemInfo.memory.percentage > 90) {
      // Only log in debug mode for 90-95% range
      log.debug(`Memory usage at ${systemInfo.memory.percentage.toFixed(1)}%`)
    }

    // Determine overall health
    let overall: 'healthy' | 'degraded' | 'unhealthy'
    if (issues.length === 0) {
      overall = 'healthy'
    } else if (issues.length <= 2) {
      overall = 'degraded'
    } else {
      overall = 'unhealthy'
    }

    return {
      overall,
      issues,
      recommendations,
    }
  }

  /**
   * Collect and log diagnostics
   */
  private async collectAndLogDiagnostics(): Promise<void> {
    const diagnostics = await this.collectDiagnostics()

    // Only log health status if it changed or is unhealthy
    if (diagnostics.health.overall !== this.lastHealthStatus) {
      this.lastHealthStatus = diagnostics.health.overall

      if (diagnostics.health.overall !== 'healthy') {
        log.warn(`Matter health status: ${diagnostics.health.overall}`)
        for (const issue of diagnostics.health.issues) {
          log.warn(`  - ${issue}`)
        }
        for (const recommendation of diagnostics.health.recommendations) {
          log.info(`  💡 ${recommendation}`)
        }
      } else {
        log.info('Matter health status: healthy')
      }
    }

    // Log debug information
    log.debug('Matter diagnostics:', {
      health: diagnostics.health.overall,
      errors: diagnostics.errors.total,
      devices: diagnostics.matter.deviceCount,
      avgSyncTime: `${diagnostics.performance.averageSyncTime.toFixed(0)}ms`,
      memory: `${(diagnostics.system.memory.percentage).toFixed(1)}%`,
    })
  }

  /**
   * Generate diagnostic report
   */
  async generateReport(matterInfo?: MatterInfo): Promise<string> {
    const diagnostics = await this.collectDiagnostics(matterInfo)

    return `
Matter Diagnostics Report
========================
Generated: ${diagnostics.timestamp.toISOString()}

System Information
------------------
Platform: ${diagnostics.system.platform} (${diagnostics.system.arch})
Node Version: ${diagnostics.system.nodeVersion}
System Uptime: ${(diagnostics.system.uptime / 3600).toFixed(1)} hours
Memory: ${(diagnostics.system.memory.used / 1024 / 1024 / 1024).toFixed(1)}GB / ${(diagnostics.system.memory.total / 1024 / 1024 / 1024).toFixed(1)}GB (${diagnostics.system.memory.percentage.toFixed(1)}%)
CPU: ${diagnostics.system.cpu.model} (${diagnostics.system.cpu.cores} cores)

Matter Status
-------------
Enabled: ${diagnostics.matter.enabled}
Initialized: ${diagnostics.matter.initialized}
Running: ${diagnostics.matter.running}
Port: ${diagnostics.matter.port || 'N/A'}
Devices: ${diagnostics.matter.deviceCount}
Bridges: ${diagnostics.matter.bridgeCount}

Network Status
--------------
Online: ${diagnostics.network.online}
Interfaces: ${diagnostics.network.interfaces.join(', ') || 'None'}
Primary: ${diagnostics.network.primaryInterface || 'N/A'}
Last Check: ${diagnostics.network.lastCheck.toISOString()}

Error Summary
-------------
Total Errors: ${diagnostics.errors.total}
${Object.entries(diagnostics.errors.byType)
  .map(([type, count]) => `  ${type}: ${count}`)
  .join('\n')}

Performance
-----------
Average Sync Time: ${diagnostics.performance.averageSyncTime.toFixed(0)}ms
Memory Usage: ${(diagnostics.performance.memoryUsage / 1024 / 1024).toFixed(1)}MB

Health Assessment
-----------------
Overall: ${diagnostics.health.overall.toUpperCase()}
${diagnostics.health.issues.length > 0 ? `Issues:\n${diagnostics.health.issues.map(i => `  - ${i}`).join('\n')}` : ''}
${diagnostics.health.recommendations.length > 0 ? `Recommendations:\n${diagnostics.health.recommendations.map(r => `  - ${r}`).join('\n')}` : ''}
`
  }
}

// Export singleton instance
export const diagnostics = MatterDiagnostics.getInstance()
