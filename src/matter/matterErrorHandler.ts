/**
 * Matter Error Handler
 *
 * Centralized error handling and recovery for Matter.js integration
 * with circuit breaker pattern and contextual recovery
 */

import { Logger } from '../logger.js'

const log = Logger.withPrefix('Matter')

export enum MatterErrorType {
  INITIALIZATION = 'INITIALIZATION',
  NETWORK = 'NETWORK',
  COMMISSIONING = 'COMMISSIONING',
  DEVICE_SYNC = 'DEVICE_SYNC',
  SERVER = 'SERVER',
  STORAGE = 'STORAGE',
  CONFIGURATION = 'CONFIGURATION',
  UNKNOWN = 'UNKNOWN',
}

export interface MatterError extends Error {
  type: MatterErrorType
  code?: string
  recoverable?: boolean
  details?: any
  timestamp?: Date
}

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failure threshold exceeded, blocking requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

/**
 * Circuit breaker for error recovery
 */
class CircuitBreaker {
  private state = CircuitState.CLOSED
  private failureCount = 0
  private successCount = 0
  private lastFailureTime = 0
  private nextAttemptTime = 0

  constructor(
    private readonly threshold = 5,
    private readonly timeout = 60000, // 1 minute
    private readonly successThreshold = 3,
  ) {}

  /**
   * Check if operation should be allowed
   */
  canAttempt(): boolean {
    const now = Date.now()

    switch (this.state) {
      case CircuitState.CLOSED:
        return true

      case CircuitState.OPEN:
        if (now >= this.nextAttemptTime) {
          this.state = CircuitState.HALF_OPEN
          return true
        }
        return false

      case CircuitState.HALF_OPEN:
        return true

      default:
        return false
    }
  }

  /**
   * Record success
   */
  recordSuccess(): void {
    this.failureCount = 0

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++
      if (this.successCount >= this.successThreshold) {
        this.state = CircuitState.CLOSED
        this.successCount = 0
      }
    }
  }

  /**
   * Record failure
   */
  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    this.successCount = 0

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN
      this.nextAttemptTime = Date.now() + this.timeout
    } else if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN
      this.nextAttemptTime = Date.now() + this.timeout
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = 0
    this.nextAttemptTime = 0
  }
}

/**
 * Recovery context for tracking recovery attempts
 */
interface RecoveryContext {
  errorType: MatterErrorType
  attemptCount: number
  lastAttemptTime: number
  backoffMultiplier: number
}

export class MatterErrorHandler {
  private static instance: MatterErrorHandler
  private errorCount = new Map<MatterErrorType, number>()
  private lastErrors = new Map<MatterErrorType, MatterError>()
  private recoveryCallbacks = new Map<MatterErrorType, (() => Promise<void>)[]>()
  private circuitBreakers = new Map<MatterErrorType, CircuitBreaker>()
  private recoveryContexts = new Map<MatterErrorType, RecoveryContext>()
  private maxRetries = 3
  private retryDelays = [1000, 5000, 10000] // Exponential backoff
  private readonly MAX_RECOVERY_ATTEMPTS = 5
  private contextualRetryLimits = new Map<MatterErrorType, number>([
    [MatterErrorType.NETWORK, 5],
    [MatterErrorType.DEVICE_SYNC, 3],
    [MatterErrorType.STORAGE, 2],
    [MatterErrorType.SERVER, 1],
  ])

  private constructor() {}

  static getInstance(): MatterErrorHandler {
    if (!MatterErrorHandler.instance) {
      MatterErrorHandler.instance = new MatterErrorHandler()
    }
    return MatterErrorHandler.instance
  }

  /**
   * Handle a Matter error with context-aware recovery
   */
  async handleError(error: Error | MatterError, context?: string): Promise<void> {
    const matterError = this.categorizeError(error, context)

    // Log the error with appropriate level
    this.logError(matterError)

    // Track error occurrence
    this.trackError(matterError)

    // Check circuit breaker before attempting recovery
    const circuitBreaker = this.getOrCreateCircuitBreaker(matterError.type)

    if (matterError.recoverable && circuitBreaker.canAttempt()) {
      // Check if we should attempt recovery based on context
      if (this.shouldAttemptRecovery(matterError)) {
        this.attemptContextualRecovery(matterError, circuitBreaker).catch((err) => {
          log.debug(`Recovery attempt failed for ${matterError.type}:`, err)
          circuitBreaker.recordFailure()
        })
      }
    } else if (!circuitBreaker.canAttempt()) {
      log.debug(`Circuit breaker OPEN for ${matterError.type}, skipping recovery`)
    }
  }

  /**
   * Categorize error into Matter error types
   */
  private categorizeError(error: Error | MatterError, context?: string): MatterError {
    if ('type' in error) {
      return error as MatterError
    }

    const matterError = error as MatterError
    matterError.timestamp = new Date()

    // Categorize based on error message and context
    if (error.message.includes('EADDRINUSE')) {
      matterError.type = MatterErrorType.NETWORK
      matterError.code = 'PORT_IN_USE'
      matterError.recoverable = false
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
      matterError.type = MatterErrorType.NETWORK
      matterError.code = 'CONNECTION_FAILED'
      matterError.recoverable = true
    } else if (error.message.includes('commissioning') || error.message.includes('pairing')) {
      matterError.type = MatterErrorType.COMMISSIONING
      matterError.recoverable = false
    } else if (error.message.includes('storage') || error.message.includes('ENOENT')) {
      matterError.type = MatterErrorType.STORAGE
      matterError.recoverable = true
    } else if (error.message.includes('config') || error.message.includes('invalid')) {
      matterError.type = MatterErrorType.CONFIGURATION
      matterError.recoverable = false
    } else if (context?.includes('sync')) {
      matterError.type = MatterErrorType.DEVICE_SYNC
      matterError.recoverable = true
    } else if (context?.includes('server')) {
      matterError.type = MatterErrorType.SERVER
      matterError.recoverable = true
    } else if (context?.includes('init')) {
      matterError.type = MatterErrorType.INITIALIZATION
      matterError.recoverable = true
    } else {
      matterError.type = MatterErrorType.UNKNOWN
      matterError.recoverable = false
    }

    return matterError
  }

  /**
   * Log error with appropriate severity
   */
  private logError(error: MatterError): void {
    const errorCount = this.errorCount.get(error.type) || 0

    switch (error.type) {
      case MatterErrorType.NETWORK:
        if (error.code === 'PORT_IN_USE') {
          log.error('Matter port is already in use. Please configure a different port.')
        } else {
          log.warn(`Matter network error: ${error.message}`)
        }
        break

      case MatterErrorType.COMMISSIONING:
        log.info(`Matter commissioning issue: ${error.message}`)
        break

      case MatterErrorType.DEVICE_SYNC:
        if (errorCount < 3) {
          log.debug(`Device sync error: ${error.message}`)
        } else {
          log.warn(`Repeated device sync errors: ${error.message}`)
        }
        break

      case MatterErrorType.SERVER:
        log.error(`Matter server error: ${error.message}`)
        break

      case MatterErrorType.STORAGE:
        log.warn(`Matter storage error: ${error.message}`)
        break

      case MatterErrorType.CONFIGURATION:
        log.error(`Matter configuration error: ${error.message}`)
        break

      case MatterErrorType.INITIALIZATION:
        log.error(`Matter initialization error: ${error.message}`)
        break

      default:
        log.error(`Unknown Matter error: ${error.message}`)
    }

    // Log stack trace for non-recoverable errors
    if (!error.recoverable && error.stack) {
      log.debug('Stack trace:', error.stack)
    }
  }

  /**
   * Track error occurrences with bounds checking
   */
  private trackError(error: MatterError): void {
    // Limit total error types tracked to prevent unbounded growth
    const MAX_ERROR_TYPES = 50
    const MAX_ERRORS_PER_TYPE = 100

    if (!this.errorCount.has(error.type) && this.errorCount.size >= MAX_ERROR_TYPES) {
      // Remove oldest error type
      const firstKey = this.errorCount.keys().next().value
      if (firstKey) {
        this.errorCount.delete(firstKey)
        this.lastErrors.delete(firstKey)
        this.recoveryContexts.delete(firstKey)
        this.circuitBreakers.delete(firstKey)
      }
    }

    const count = (this.errorCount.get(error.type) || 0) + 1

    // Cap error count per type
    this.errorCount.set(error.type, Math.min(count, MAX_ERRORS_PER_TYPE))
    this.lastErrors.set(error.type, error)

    // Auto-cleanup old errors after 1 hour
    setTimeout(() => {
      const currentError = this.lastErrors.get(error.type)
      if (currentError && currentError.timestamp === error.timestamp) {
        this.clearErrors(error.type)
      }
    }, 3600000) // 1 hour
  }

  /**
   * Clear errors for a specific type
   */
  private clearErrors(errorType: MatterErrorType): void {
    this.errorCount.delete(errorType)
    this.lastErrors.delete(errorType)
  }

  /**
   * Attempt contextual recovery from error
   */
  private async attemptContextualRecovery(
    error: MatterError,
    circuitBreaker: CircuitBreaker,
  ): Promise<void> {
    // Get or create recovery context
    let context = this.recoveryContexts.get(error.type)
    if (!context) {
      context = {
        errorType: error.type,
        attemptCount: 0,
        lastAttemptTime: 0,
        backoffMultiplier: 1,
      }
      this.recoveryContexts.set(error.type, context)
    }
    context.attemptCount++
    context.lastAttemptTime = Date.now()

    const delay = this.getContextualDelay(error.type, context.attemptCount - 1)
    log.info(`Attempting recovery from ${error.type} error (attempt ${context.attemptCount}) in ${delay}ms`)

    // Use global.setTimeout so it can be mocked in tests
    await new Promise(resolve => globalThis.setTimeout(resolve, delay))

    try {
      const callbacks = this.recoveryCallbacks.get(error.type) || []
      let anySuccess = false

      for (const callback of callbacks) {
        try {
          await callback()
          anySuccess = true
        } catch (callbackError) {
          log.debug(`Recovery callback failed for ${error.type}:`, callbackError)
        }
      }

      if (anySuccess) {
        circuitBreaker.recordSuccess()
        // Reset context on success
        this.recoveryContexts.delete(error.type)
        this.errorCount.set(error.type, 0)
        log.info(`✅ Recovery successful for ${error.type}`)
      } else {
        circuitBreaker.recordFailure()
        // Increase backoff multiplier but don't delete context
        context.backoffMultiplier = Math.min(context.backoffMultiplier * 2, 10)
        // Keep the context so attemptCount persists
      }
    } catch (recoveryError) {
      log.error(`Recovery failed for ${error.type}:`, recoveryError)
      circuitBreaker.recordFailure()
      context.backoffMultiplier = Math.min(context.backoffMultiplier * 2, 10)
      // Keep the context so attemptCount persists
    }
  }

  /**
   * Backward compatibility wrapper
   */
  private async attemptRecovery(error: MatterError): Promise<void> {
    const circuitBreaker = this.getOrCreateCircuitBreaker(error.type)
    if (this.shouldAttemptRecovery(error) && circuitBreaker.canAttempt()) {
      await this.attemptContextualRecovery(error, circuitBreaker)
    }
  }

  /**
   * Get or create a circuit breaker for an error type
   */
  private getOrCreateCircuitBreaker(type: MatterErrorType): CircuitBreaker {
    let breaker = this.circuitBreakers.get(type)
    if (!breaker) {
      breaker = new CircuitBreaker()
      this.circuitBreakers.set(type, breaker)
    }
    return breaker
  }

  /**
   * Check if we should attempt recovery
   */
  private shouldAttemptRecovery(error: MatterError): boolean {
    // Don't attempt recovery for non-recoverable errors
    if (!error.recoverable) {
      return false
    }

    // Check if we've exceeded max recovery attempts
    const context = this.recoveryContexts.get(error.type)
    if (context && context.attemptCount >= this.MAX_RECOVERY_ATTEMPTS) {
      return false
    }

    return true
  }

  /**
   * Get contextual delay based on error type and attempt count
   */
  private getContextualDelay(type: MatterErrorType, attemptCount: number): number {
    // Base delays by error type
    const baseDelays: Record<MatterErrorType, number> = {
      [MatterErrorType.NETWORK]: 5000,
      [MatterErrorType.STORAGE]: 1000,
      [MatterErrorType.DEVICE_SYNC]: 2000,
      [MatterErrorType.COMMISSIONING]: 3000,
      [MatterErrorType.CONFIGURATION]: 1000,
      [MatterErrorType.INITIALIZATION]: 2000,
      [MatterErrorType.SERVER]: 1000,
      [MatterErrorType.UNKNOWN]: 2000,
    }

    const baseDelay = baseDelays[type] || 2000
    // Exponential backoff with jitter
    const backoffDelay = Math.min(baseDelay * 2 ** attemptCount, 30000)
    const jitter = Math.random() * 1000
    return backoffDelay + jitter
  }

  /**
   * Register a recovery callback for specific error type
   */
  registerRecoveryCallback(type: MatterErrorType, callback: () => Promise<void>): void {
    const callbacks = this.recoveryCallbacks.get(type) || []
    callbacks.push(callback)
    this.recoveryCallbacks.set(type, callbacks)
  }

  /**
   * Reset error counts (useful after successful recovery)
   */
  resetErrorCount(type?: MatterErrorType): void {
    if (type) {
      this.errorCount.delete(type)
      this.lastErrors.delete(type)
      this.recoveryContexts.delete(type)

      // Reset circuit breaker
      const circuitBreaker = this.circuitBreakers.get(type)
      if (circuitBreaker) {
        circuitBreaker.reset()
      }
    } else {
      this.errorCount.clear()
      this.lastErrors.clear()
      this.recoveryContexts.clear()

      // Reset all circuit breakers
      for (const breaker of this.circuitBreakers.values()) {
        breaker.reset()
      }
    }
  }

  /**
   * Get error statistics
   */
  getErrorStats(): Map<MatterErrorType, {
    count: number
    lastError?: MatterError
    circuitState?: CircuitState
    recoveryAttempts?: number
  }> {
    const stats = new Map()

    for (const [type, count] of this.errorCount) {
      const lastError = this.lastErrors.get(type)
      const circuitBreaker = this.circuitBreakers.get(type)
      const context = this.recoveryContexts.get(type)

      stats.set(type, {
        count,
        lastError,
        circuitState: circuitBreaker?.getState(),
        recoveryAttempts: context?.attemptCount,
      })
    }

    return stats
  }

  /**
   * Create a wrapped function with error handling
   */
  wrapAsync<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    context: string,
  ): T {
    return (async (...args: Parameters<T>) => {
      try {
        return await fn(...args)
      } catch (error) {
        await this.handleError(error as Error, context)
        throw error
      }
    }) as T
  }

  /**
   * Create a wrapped function with error suppression
   */
  wrapAsyncSafe<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    context: string,
    defaultValue?: ReturnType<T>,
  ): T {
    return (async (...args: Parameters<T>) => {
      try {
        return await fn(...args)
      } catch (error) {
        await this.handleError(error as Error, context)
        return defaultValue
      }
    }) as T
  }
}

// Export singleton instance
export const errorHandler = MatterErrorHandler.getInstance()
