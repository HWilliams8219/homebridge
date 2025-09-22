import type { AccessoryConfig, PlatformConfig } from '../bridgeService.js'

import { Logger } from '../logger.js'
import { MatterConfiguration } from './matterTypes.js'

const log = Logger.withPrefix('Matter')

export interface MatterConfigValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Validate Matter configuration for production readiness
 */
export class MatterConfigValidator {
  /**
   * Validate a Matter configuration object
   */
  static validate(config: MatterConfiguration): MatterConfigValidationResult {
    const result: MatterConfigValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    }

    // Validate port configuration
    this.validatePort(config, result)

    // Validate device name
    this.validateDeviceName(config, result)

    result.isValid = result.errors.length === 0

    if (result.warnings.length > 0) {
      log.warn('Matter configuration warnings:')
      result.warnings.forEach(warning => log.warn(`  - ${warning}`))
    }

    if (result.errors.length > 0) {
      log.error('Matter configuration errors:')
      result.errors.forEach(error => log.error(`  - ${error}`))
    }

    return result
  }

  private static validatePort(config: MatterConfiguration, result: MatterConfigValidationResult): void {
    const port = config.port

    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        result.errors.push(`Port ${port} is invalid. Must be an integer between 1024-65535.`)
      }

      // Check for common conflicts
      const conflictPorts = [5353, 8080, 8443] // mDNS, common HTTP ports
      if (conflictPorts.includes(port)) {
        result.warnings.push(`Port ${port} may conflict with other services. Consider using a different port.`)
      }
    }
  }

  private static validateDeviceName(config: MatterConfiguration, result: MatterConfigValidationResult): void {
    const deviceName = config.name

    if (deviceName !== undefined) {
      if (deviceName.length === 0) {
        result.errors.push('Device name cannot be empty.')
        return
      }

      if (deviceName.length > 32) {
        result.errors.push(`Device name "${deviceName}" is too long. Must be 32 characters or less.`)
      }

      // Check for invalid characters
      if (!/^[\x20-\x7E]*$/.test(deviceName)) {
        result.errors.push(`Device name "${deviceName}" contains invalid characters. Use only printable ASCII characters.`)
      }
    }
  }

  /**
   * Validate child Matter configuration (_matter property)
   */
  static validateChildMatterConfig(
    config: PlatformConfig | AccessoryConfig,
    configType: 'platform' | 'accessory',
    identifier: string,
  ): MatterConfigValidationResult {
    const result: MatterConfigValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    }

    // If no _matter property, no validation needed
    if (!config._matter) {
      return result
    }

    const matterConfig = config._matter
    const prefix = `Child Matter bridge for ${configType} "${identifier}"`

    // Validate port if specified
    if (matterConfig.port !== undefined) {
      if (!Number.isInteger(matterConfig.port) || matterConfig.port < 1024 || matterConfig.port > 65535) {
        result.errors.push(`${prefix}: Port ${matterConfig.port} is invalid. Must be between 1024-65535.`)
        result.isValid = false
      }
    } else {
      result.warnings.push(`${prefix}: No port specified. Port will be auto-allocated.`)
    }

    // Validate name if specified
    if (matterConfig.name !== undefined) {
      if (matterConfig.name.length === 0) {
        result.errors.push(`${prefix}: Name cannot be empty.`)
        result.isValid = false
      } else if (matterConfig.name.length > 32) {
        result.errors.push(`${prefix}: Name "${matterConfig.name}" is too long. Must be 32 characters or less.`)
        result.isValid = false
      }
    }

    // Check for conflicts with HAP bridge
    if (config._bridge && config._matter) {
      result.warnings.push(`${prefix}: Both _bridge and _matter are configured. Accessories will be exposed via both HAP and Matter protocols.`)

      // Ensure ports don't conflict
      if (config._bridge.port && matterConfig.port && Math.abs(config._bridge.port - matterConfig.port) < 10) {
        result.warnings.push(`${prefix}: HAP and Matter ports are very close. Consider spacing them further apart.`)
      }
    }

    // Log validation results
    if (result.errors.length > 0) {
      log.error(`${prefix} validation errors:`)
      result.errors.forEach(error => log.error(`  - ${error}`))
    }

    if (result.warnings.length > 0) {
      log.warn(`${prefix} validation warnings:`)
      result.warnings.forEach(warning => log.warn(`  - ${warning}`))
    }

    return result
  }

  /**
   * Validate all child Matter configurations in a config
   */
  static validateAllChildMatterConfigs(
    platforms: PlatformConfig[],
    accessories: AccessoryConfig[],
  ): MatterConfigValidationResult {
    const result: MatterConfigValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    }

    const usedPorts = new Set<number>()

    // Validate platform _matter configs
    for (const platform of platforms) {
      if (platform._matter) {
        const validation = this.validateChildMatterConfig(
          platform,
          'platform',
          platform.platform || 'unknown',
        )

        result.errors.push(...validation.errors)
        result.warnings.push(...validation.warnings)
        result.isValid = result.isValid && validation.isValid

        // Check for port conflicts
        if (platform._matter.port) {
          if (usedPorts.has(platform._matter.port)) {
            result.errors.push(`Duplicate Matter port ${platform._matter.port} detected. Each Matter bridge must use a unique port.`)
            result.isValid = false
          }
          usedPorts.add(platform._matter.port)
        }
      }
    }

    // Validate accessory _matter configs
    for (const accessory of accessories) {
      if (accessory._matter) {
        const validation = this.validateChildMatterConfig(
          accessory,
          'accessory',
          accessory.accessory || 'unknown',
        )

        result.errors.push(...validation.errors)
        result.warnings.push(...validation.warnings)
        result.isValid = result.isValid && validation.isValid

        // Check for port conflicts
        if (accessory._matter.port) {
          if (usedPorts.has(accessory._matter.port)) {
            result.errors.push(`Duplicate Matter port ${accessory._matter.port} detected. Each Matter bridge must use a unique port.`)
            result.isValid = false
          }
          usedPorts.add(accessory._matter.port)
        }
      }
    }

    return result
  }
}
