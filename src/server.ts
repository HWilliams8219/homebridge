import type { MacAddress } from 'hap-nodejs'

import type {
  AccessoryIdentifier,
  AccessoryName,
  AccessoryPlugin,
  AccessoryPluginConstructor,
  PlatformIdentifier,
  PlatformName,
  PlatformPlugin,
  PlatformPluginConstructor,
} from './api.js'
import type { BridgeConfiguration, BridgeOptions, HomebridgeConfig, PlatformConfig } from './bridgeService.js'
import type { Plugin } from './plugin.js'
import type { PluginManagerOptions } from './pluginManager.js'

import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

import chalk from 'chalk'
import { AccessoryEventTypes, MDNSAdvertiser } from 'hap-nodejs'
import qrcode from 'qrcode-terminal'

import { HomebridgeAPI, InternalAPIEvent, PluginType } from './api.js'
import { BridgeService } from './bridgeService.js'
import { ChildBridgeService } from './childBridgeService.js'
import { ChildMatterBridgeService } from './childMatterBridgeService.js'
import { ExternalPortService } from './externalPortService.js'
import { IpcIncomingEvent, IpcOutgoingEvent, IpcService } from './ipcService.js'
import { Logger } from './logger.js'
import { MatterConfigValidator } from './matter/matterConfigValidator.js'
import { PlatformAccessory } from './platformAccessory.js'
import { PluginManager } from './pluginManager.js'
import { User } from './user.js'
import { validMacAddress } from './util/mac.js'

const log = Logger.internal

export interface HomebridgeOptions {
  keepOrphanedCachedAccessories?: boolean
  hideQRCode?: boolean
  insecureAccess?: boolean
  customPluginPath?: string
  noLogTimestamps?: boolean
  debugModeEnabled?: boolean
  forceColourLogging?: boolean
  customStoragePath?: string
  strictPluginResolution?: boolean
}

// eslint-disable-next-line no-restricted-syntax
export const enum ServerStatus {
  /**
   * When the server is starting up
   */
  PENDING = 'pending',

  /**
   * When the server is online and has published the main bridge
   */
  OK = 'ok',

  /**
   * When the server is shutting down
   */
  DOWN = 'down',
}

export class Server {
  private readonly api: HomebridgeAPI
  private readonly pluginManager: PluginManager
  private readonly bridgeService: BridgeService
  private readonly ipcService: IpcService
  private readonly externalPortService: ExternalPortService

  private readonly config: HomebridgeConfig

  // used to keep track of child bridges
  private readonly childBridges: Map<MacAddress, ChildBridgeService> = new Map()
  private readonly childMatterBridges: Map<string, ChildMatterBridgeService> = new Map()

  // Track platform configurations for routing accessories
  private readonly platformConfigs: Map<string, PlatformConfig> = new Map()

  // current server status
  private serverStatus: ServerStatus = ServerStatus.PENDING

  constructor(
    private options: HomebridgeOptions = {},
  ) {
    this.config = Server.loadConfig()

    // object we feed to Plugins and BridgeService
    this.api = new HomebridgeAPI()
    this.ipcService = new IpcService()
    this.externalPortService = new ExternalPortService(this.config.ports)

    // set status to pending
    this.setServerStatus(ServerStatus.PENDING)

    // create new plugin manager
    const pluginManagerOptions: PluginManagerOptions = {
      activePlugins: this.config.plugins,
      disabledPlugins: this.config.disabledPlugins,
      customPluginPath: options.customPluginPath,
      strictPluginResolution: options.strictPluginResolution,
    }
    this.pluginManager = new PluginManager(this.api, pluginManagerOptions)

    // create new bridge service
    const bridgeConfig: BridgeOptions = {
      cachedAccessoriesDir: User.cachedAccessoryPath(),
      cachedAccessoriesItemName: 'cachedAccessories',
    }

    // shallow copy the homebridge options to the bridge options object
    Object.assign(bridgeConfig, this.options)

    this.bridgeService = new BridgeService(
      this.api,
      this.pluginManager,
      this.externalPortService,
      bridgeConfig,
      this.config.bridge,
      this.config,
    )

    // Matter is handled via _matter configuration, not API events

    // Intercept platform accessory registration to route to Matter bridges if needed
    this.api.on(InternalAPIEvent.REGISTER_PLATFORM_ACCESSORIES, this.handleRegisterPlatformAccessories.bind(this))
    this.api.on(InternalAPIEvent.UNREGISTER_PLATFORM_ACCESSORIES, this.handleUnregisterPlatformAccessories.bind(this))

    // Handle external accessories (cameras, etc.) for Matter
    this.api.on(InternalAPIEvent.PUBLISH_EXTERNAL_ACCESSORIES, this.handlePublishExternalAccessories.bind(this))

    // watch bridge events to check when server is online
    this.bridgeService.bridge.on(AccessoryEventTypes.ADVERTISED, () => {
      this.setServerStatus(ServerStatus.OK)
    })

    // watch for the paired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.PAIRED, () => {
      this.setServerStatus(this.serverStatus)
    })

    // watch for the unpaired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.UNPAIRED, () => {
      this.setServerStatus(this.serverStatus)
    })
  }

  /**
   * Set the current server status and update parent via IPC
   * @param status
   */
  private setServerStatus(status: ServerStatus) {
    this.serverStatus = status

    // Collect child Matter bridge statuses
    const childMatterBridgeStatuses = Array.from(this.childMatterBridges.values()).map(bridge => bridge.getMetadata())

    // Get Matter bridges status (child bridges only)
    const matterStatus = childMatterBridgeStatuses.length > 0
      ? {
          children: childMatterBridgeStatuses,
        }
      : undefined

    this.ipcService.sendMessage(IpcOutgoingEvent.SERVER_STATUS_UPDATE, {
      type: 'hap' as const, // Main bridge is HAP
      status: this.serverStatus,
      paired: this.bridgeService?.bridge?._accessoryInfo?.paired() ?? null,
      setupUri: this.bridgeService?.bridge?.setupURI() ?? null,
      name: this.bridgeService?.bridge?.displayName || this.config.bridge.name,
      username: this.config.bridge.username,
      pin: this.config.bridge.pin,
      matterStatus,
    })
  }

  public async start(): Promise<void> {
    if (this.config.bridge.disableIpc !== true) {
      this.initializeIpcEventHandlers()
    }

    // Track existing Matter bridges before loading new configuration
    const existingMatterBridgeIds = new Set(this.childMatterBridges.keys())

    // Validate child Matter configurations
    const matterValidation = MatterConfigValidator.validateAllChildMatterConfigs(
      this.config.platforms,
      this.config.accessories,
    )

    if (!matterValidation.isValid) {
      log.error('Child Matter configuration validation failed. Please fix the errors above.')
      // Continue anyway but child Matter bridges may not work properly
    }

    const promises: Promise<void>[] = []

    // load the cached accessories
    await this.bridgeService.loadCachedPlatformAccessoriesFromDisk()

    // initialize plugins
    await this.pluginManager.initializeInstalledPlugins()

    if (this.config.platforms.length > 0) {
      promises.push(...this.loadPlatforms())
    }
    if (this.config.accessories.length > 0) {
      this.loadAccessories()
    }

    // Track which Matter bridges are still in the configuration
    const currentMatterBridgeIds = new Set<string>()

    // Check platforms for Matter bridges
    this.config.platforms.forEach((platformConfig) => {
      if (platformConfig._matter && platformConfig.platform) {
        try {
          const plugin = this.pluginManager.getPluginForPlatform(platformConfig.platform)
          const matterIdentifier = `${plugin.getPluginIdentifier()}-${platformConfig.platform}`
          currentMatterBridgeIds.add(matterIdentifier)
        } catch {
          // Plugin not found, skip
        }
      }
    })

    // Check accessories for Matter bridges
    this.config.accessories.forEach((accessoryConfig) => {
      if (accessoryConfig._matter && accessoryConfig.accessory) {
        try {
          const plugin = this.pluginManager.getPluginForAccessory(accessoryConfig.accessory)
          const matterIdentifier = `${plugin.getPluginIdentifier()}-${accessoryConfig.accessory}`
          currentMatterBridgeIds.add(matterIdentifier)
        } catch {
          // Plugin not found, skip
        }
      }
    })

    // Clean up Matter bridges that were removed from configuration
    for (const bridgeId of existingMatterBridgeIds) {
      if (!currentMatterBridgeIds.has(bridgeId) && this.childMatterBridges.has(bridgeId)) {
        const removedBridge = this.childMatterBridges.get(bridgeId)!
        log.info(`Matter bridge "${bridgeId}" was removed from configuration, cleaning up...`)

        // Stop and clean up the removed bridge (with permanent flag)
        await removedBridge.teardown(true)
        this.childMatterBridges.delete(bridgeId)
      }
    }

    // start child HAP bridges
    for (const childBridge of this.childBridges.values()) {
      childBridge.start()
    }

    // start child Matter bridges
    for (const childMatterBridge of this.childMatterBridges.values()) {
      promises.push(childMatterBridge.start())
    }

    // restore cached accessories
    this.bridgeService.restoreCachedPlatformAccessories()

    this.api.signalFinished()

    // wait for all platforms to publish their accessories before we publish the bridge
    await Promise.all(promises)
      .then(() => this.publishBridge())
  }

  /**
   * Get the status of all Matter bridges (child bridges only)
   */
  public getMatterBridgesStatus(): any[] {
    return Array.from(this.childMatterBridges.values()).map(bridge => bridge.getMetadata())
  }

  public teardown(): void {
    this.bridgeService.teardown()

    // Stop all child Matter bridges
    for (const childMatterBridge of this.childMatterBridges.values()) {
      childMatterBridge.teardown().catch((error: any) => {
        log.error(`Failed to stop child Matter bridge ${childMatterBridge.getDisplayName()}:`, error)
      })
    }

    this.setServerStatus(ServerStatus.DOWN)
  }

  private publishBridge(): void {
    this.bridgeService.publishBridge()

    this.printSetupInfo(this.config.bridge.pin)
  }

  // Matter accessories are managed via _matter configuration, not API methods

  private handlePublishExternalAccessories(accessories: PlatformAccessory[]): void {
    log.info(`Publishing ${accessories.length} external accessories`)

    // External accessories are only published to child Matter bridges, not main bridge

    // Group accessories by plugin
    const accessoriesByPlugin = new Map<string, PlatformAccessory[]>()

    accessories.forEach((accessory) => {
      const pluginIdentifier = accessory._associatedPlugin
      if (!pluginIdentifier) {
        log.warn(`External accessory "${accessory.displayName}" has no plugin identifier`)
        return
      }

      if (!accessoriesByPlugin.has(pluginIdentifier)) {
        accessoriesByPlugin.set(pluginIdentifier, [])
      }
      accessoriesByPlugin.get(pluginIdentifier)!.push(accessory)
    })

    // Process each plugin's external accessories
    accessoriesByPlugin.forEach((pluginAccessories, pluginIdentifier) => {
      // Check if there's already an external Matter bridge for this plugin
      const externalMatterBridgeId = `${pluginIdentifier}-external`
      let externalMatterBridge = this.childMatterBridges.get(externalMatterBridgeId)

      if (!externalMatterBridge) {
        // Check if this plugin has any Matter-enabled platform config
        let hasMatterConfig = false
        let baseMatterConfig: any = {}

        // Look for any platform with Matter config from this plugin
        for (const [bridgeId, childBridge] of this.childMatterBridges) {
          if (bridgeId.startsWith(`${pluginIdentifier}-`) && childBridge.type === PluginType.PLATFORM) {
            hasMatterConfig = true
            // Use existing Matter bridge configuration as template
            baseMatterConfig = {
              // Port will be auto-allocated
            }
            break
          }
        }

        // If plugin has Matter-enabled platforms, create external bridge automatically
        if (hasMatterConfig) {
          log.info(`Automatically creating external Matter bridge for ${pluginIdentifier}`)

          const plugin = this.pluginManager.getPlugin(pluginIdentifier)
          if (!plugin) {
            log.warn(`Could not find plugin ${pluginIdentifier} to create external Matter bridge`)
            return
          }

          // Create synthetic config for external bridge
          const externalConfig: PlatformConfig = {
            platform: '__external__',
            name: `${pluginIdentifier} External`,
            _matter: {
              ...baseMatterConfig,
              name: `${pluginIdentifier} External Matter`,
            },
          }

          externalMatterBridge = new ChildMatterBridgeService(
            PluginType.PLATFORM,
            plugin,
            externalConfig._matter!,
            externalConfig,
            this.api,
            this.externalPortService,
            this.options,
            this.ipcService,
            this.config,
          )

          this.childMatterBridges.set(externalMatterBridgeId, externalMatterBridge)

          // Start the external bridge
          externalMatterBridge.start().catch((error: any) => {
            log.error(`Failed to start external Matter bridge for ${pluginIdentifier}:`, error)
          })
        }
      }

      // Publish accessories to appropriate bridge
      if (externalMatterBridge) {
        pluginAccessories.forEach((accessory) => {
          externalMatterBridge.addAccessory(accessory)
          log.info(`External accessory "${accessory.displayName}" added to automatic external Matter bridge`)
        })
      } else {
        // Check if any child Matter bridge from this plugin can handle it
        let publishedToChildBridge = false
        for (const [bridgeId, childBridge] of this.childMatterBridges) {
          if (bridgeId.startsWith(`${pluginIdentifier}-`)) {
            pluginAccessories.forEach((accessory) => {
              childBridge.addAccessory(accessory)
              log.info(`External accessory "${accessory.displayName}" added to plugin's Matter bridge`)
            })
            publishedToChildBridge = true
            break
          }
        }

        // External accessories are only published to child Matter bridges, not main bridge
        if (!publishedToChildBridge) {
          pluginAccessories.forEach((accessory) => {
            log.debug(`External accessory "${accessory.displayName}" not published to Matter - configure _matter property for Matter support`)
          })
        }
      }
    })
  }

  private handleRegisterPlatformAccessories(accessories: PlatformAccessory[]): void {
    // Route to HAP bridge (default behavior)
    this.bridgeService.handleRegisterPlatformAccessories(accessories)

    // Check if we need to also route to Matter bridges
    for (const accessory of accessories) {
      const platformKey = `${accessory._associatedPlugin}-${accessory._associatedPlatform}`
      const platformConfig = this.platformConfigs.get(platformKey)

      if (platformConfig) {
        // Check if platform has child Matter bridge
        if (platformConfig._matter && typeof platformConfig._matter === 'object') {
          const matterIdentifier = `${accessory._associatedPlugin}-${accessory._associatedPlatform}`
          const childMatterBridge = this.childMatterBridges.get(matterIdentifier)

          if (childMatterBridge) {
            childMatterBridge.addAccessory(accessory).catch((error: any) => {
              log.error(`Failed to add accessory "${accessory.displayName}" to child Matter bridge:`, error)
            })
          }
        }
      }
    }
  }

  private handleUnregisterPlatformAccessories(accessories: PlatformAccessory[]): void {
    // Route to HAP bridge (default behavior)
    this.bridgeService.handleUnregisterPlatformAccessories(accessories)

    // Check if we need to also unregister from Matter bridges
    for (const accessory of accessories) {
      const platformKey = `${accessory._associatedPlugin}-${accessory._associatedPlatform}`
      const platformConfig = this.platformConfigs.get(platformKey)

      if (platformConfig) {
        // Check if platform has child Matter bridge
        if (platformConfig._matter && typeof platformConfig._matter === 'object') {
          const matterIdentifier = `${accessory._associatedPlugin}-${accessory._associatedPlatform}`
          const childMatterBridge = this.childMatterBridges.get(matterIdentifier)

          if (childMatterBridge) {
            childMatterBridge.removeAccessory(accessory).catch((error: any) => {
              log.error(`Failed to remove accessory "${accessory.displayName}" from child Matter bridge:`, error)
            })
          }
        }
      }
    }
  }

  private static loadConfig(): HomebridgeConfig {
    // Look for the configuration file
    const configPath = User.configPath()

    const defaultBridge: BridgeConfiguration = {
      name: 'Homebridge',
      username: 'CC:22:3D:E3:CE:30',
      pin: '031-45-154',
    }

    if (!existsSync(configPath)) {
      log.warn('config.json (%s) not found.', configPath)
      return { // return a default configuration
        bridge: defaultBridge,
        accessories: [],
        platforms: [],
      }
    }

    let config: Partial<HomebridgeConfig>
    try {
      config = JSON.parse(readFileSync(configPath, { encoding: 'utf8' }))
    } catch (error: any) {
      log.error('There was a problem reading your config.json file.')
      log.error('Please try pasting your config.json file here to validate it: https://jsonlint.com')
      log.error('')
      throw error
    }

    if (config.ports !== undefined) {
      if (config.ports.start && config.ports.end) {
        if (config.ports.start > config.ports.end) {
          log.error('Invalid port pool configuration. End should be greater than or equal to start.')
          config.ports = undefined
        }
      } else {
        log.error('Invalid configuration for \'ports\'. Missing \'start\' and \'end\' properties! Ignoring it!')
        config.ports = undefined
      }
    }

    const bridge: BridgeConfiguration = config.bridge || defaultBridge
    bridge.name = bridge.name || defaultBridge.name
    bridge.username = bridge.username || defaultBridge.username
    bridge.pin = bridge.pin || defaultBridge.pin
    config.bridge = bridge

    const username = config.bridge.username
    if (!validMacAddress(username)) {
      throw new Error(`Not a valid username: ${username}. Must be 6 pairs of colon-separated hexadecimal chars (A-F 0-9), like a MAC address.`)
    }

    config.accessories = config.accessories || []
    config.platforms = config.platforms || []

    if (!Array.isArray(config.accessories)) {
      log.error('Value provided for accessories must be an array[]')
      config.accessories = []
    }

    if (!Array.isArray(config.platforms)) {
      log.error('Value provided for platforms must be an array[]')
      config.platforms = []
    }

    log.info('Loaded config.json with %s accessories and %s platforms.', config.accessories.length, config.platforms.length)

    if (config.bridge.advertiser) {
      if (![
        MDNSAdvertiser.BONJOUR,
        MDNSAdvertiser.CIAO,
        MDNSAdvertiser.AVAHI,
        MDNSAdvertiser.RESOLVED,
      ].includes(config.bridge.advertiser)) {
        config.bridge.advertiser = undefined
        log.error('Value provided in bridge.advertiser is not valid, reverting to platform default.')
      }
    } else {
      config.bridge.advertiser = undefined
    }

    return config as HomebridgeConfig
  }

  private loadAccessories(): void {
    log.info(`Loading ${this.config.accessories.length} accessories...`)

    this.config.accessories.forEach((accessoryConfig, index) => {
      if (!accessoryConfig.accessory) {
        log.warn('Your config.json contains an illegal accessory configuration object at position %d. '
          + 'Missing property \'accessory\'. Skipping entry...', index + 1) // we rather count from 1 for the normal people?
        return
      }

      const accessoryIdentifier: AccessoryName | AccessoryIdentifier = accessoryConfig.accessory
      const displayName = accessoryConfig.name
      if (!displayName) {
        log.warn('Could not load accessory %s at position %d as it is missing the required \'name\' property!', accessoryIdentifier, index + 1)
        return
      }

      let plugin: Plugin
      let constructor: AccessoryPluginConstructor

      try {
        plugin = this.pluginManager.getPluginForAccessory(accessoryIdentifier)
      } catch (error: any) {
        log.error(error.message)
        return
      }

      // check the plugin is not disabled
      if (plugin.disabled) {
        log.warn(`Ignoring config for the accessory "${accessoryIdentifier}" in your config.json as the plugin "${plugin.getPluginIdentifier()}" has been disabled.`)
        return
      }

      try {
        constructor = plugin.getAccessoryConstructor(accessoryIdentifier)
      } catch (error: any) {
        log.error(`Error loading the accessory "${accessoryIdentifier}" requested in your config.json at position ${index + 1} - this is likely an issue with the "${plugin.getPluginIdentifier()}" plugin.`)
        log.error(error) // error message contains more information and full stack trace
        return
      }

      const logger = Logger.withPrefix(displayName)
      logger('Initializing %s accessory...', accessoryIdentifier)

      if (accessoryConfig._bridge) {
        // ensure the username is always uppercase
        accessoryConfig._bridge.username = accessoryConfig._bridge.username.toUpperCase()

        try {
          this.validateChildBridgeConfig(PluginType.ACCESSORY, accessoryIdentifier, accessoryConfig._bridge)
        } catch (error: any) {
          log.error(error.message)
          return
        }

        let childBridge: ChildBridgeService

        if (this.childBridges.has(accessoryConfig._bridge.username)) {
          childBridge = this.childBridges.get(accessoryConfig._bridge.username)!
          logger(`Adding to existing child bridge ${accessoryConfig._bridge.username}`)
        } else {
          logger(`Initializing child bridge ${accessoryConfig._bridge.username}`)
          childBridge = new ChildBridgeService(
            PluginType.ACCESSORY,
            accessoryIdentifier,
            plugin,
            accessoryConfig._bridge,
            this.config,
            this.options,
            this.api,
            this.ipcService,
            this.externalPortService,
          )

          this.childBridges.set(accessoryConfig._bridge.username, childBridge)
        }

        // add config to child bridge service
        childBridge.addConfig(accessoryConfig)

        // If _matter is not defined, we're done - this accessory only uses HAP child bridge
        if (!accessoryConfig._matter) {
          return
        }
      }

      // Handle child Matter bridge for accessories
      if (accessoryConfig._matter && typeof accessoryConfig._matter === 'object') {
        const matterIdentifier = `${plugin.getPluginIdentifier()}-${accessoryIdentifier}`
        logger(`Initializing child Matter bridge for accessory ${accessoryIdentifier}`)

        // Ensure Matter config has proper name
        // Try to get a human-friendly name from the accessory
        // Convert CamelCase accessory identifier to spaces
        const formattedAccessoryId = accessoryIdentifier.replace(/([A-Z])/g, ' $1').trim()
        // Get plugin name without 'homebridge-' prefix and replace dashes with spaces
        const pluginDisplayName = plugin.getPluginIdentifier()
          .replace('homebridge-', '')
          .replace(/-/g, ' ')
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ')

        const defaultName = accessoryConfig.name || formattedAccessoryId || pluginDisplayName
        const matterConfig = {
          ...accessoryConfig._matter,
          name: accessoryConfig._matter.name || defaultName,
        }

        const childMatterBridge = new ChildMatterBridgeService(
          PluginType.ACCESSORY,
          plugin,
          matterConfig,
          accessoryConfig,
          this.api,
          this.externalPortService,
          this.options,
          this.ipcService,
        )

        this.childMatterBridges.set(matterIdentifier, childMatterBridge)

        // If _bridge is also defined, we're done - accessory uses both protocols
        if (accessoryConfig._bridge) {
          return
        }
      }

      // If both _bridge and _matter are defined, the accessory is handled by child bridges
      if (accessoryConfig._bridge || accessoryConfig._matter) {
        return
      }

      const accessoryInstance: AccessoryPlugin = new constructor(logger, accessoryConfig, this.api)

      // pass accessoryIdentifier for UUID generation, and optional parameter uuid_base which can be used instead of displayName for UUID generation
      const accessory = this.bridgeService.createHAPAccessory(plugin, accessoryInstance, displayName, accessoryIdentifier, accessoryConfig.uuid_base)

      if (accessory) {
        try {
          this.bridgeService.bridge.addBridgedAccessory(accessory)
        } catch (error: any) {
          logger.error(`Error loading the accessory "${accessoryIdentifier}" from "${plugin.getPluginIdentifier()}" requested in your config.json:`, error.message)
        }
      } else {
        logger.info('Accessory %s returned empty set of services; not adding it to the bridge.', accessoryIdentifier)
      }
    })
  }

  private loadPlatforms(): Promise<void>[] {
    log.info(`Loading ${this.config.platforms.length} platforms...`)

    const promises: Promise<void>[] = []
    this.config.platforms.forEach((platformConfig, index) => {
      if (!platformConfig.platform) {
        log.warn('Your config.json contains an illegal platform configuration object at position %d. '
          + 'Missing property \'platform\'. Skipping entry...', index + 1) // we rather count from 1 for the normal people?
        return
      }

      const platformIdentifier: PlatformName | PlatformIdentifier = platformConfig.platform
      const displayName = platformConfig.name || platformIdentifier

      let plugin: Plugin
      let constructor: PlatformPluginConstructor

      // do not load homebridge-config-ui-x when running in service mode
      if (platformIdentifier === 'config' && process.env.UIX_SERVICE_MODE === '1') {
        return
      }

      try {
        plugin = this.pluginManager.getPluginForPlatform(platformIdentifier)
      } catch (error: any) {
        log.error(error.message)
        return
      }

      // check the plugin is not disabled
      if (plugin.disabled) {
        log.warn(`Ignoring config for the platform "${platformIdentifier}" in your config.json as the plugin "${plugin.getPluginIdentifier()}" has been disabled.`)
        return
      }

      try {
        constructor = plugin.getPlatformConstructor(platformIdentifier)
      } catch (error: any) {
        log.error(`Error loading the platform "${platformIdentifier}" requested in your config.json at position ${index + 1} - this is likely an issue with the "${plugin.getPluginIdentifier()}" plugin.`)
        log.error(error) // error message contains more information and full stack trace
        return
      }

      const logger = Logger.withPrefix(displayName)
      logger('Initializing %s platform...', platformIdentifier)

      // Store platform config for later routing
      const platformKey = `${plugin.getPluginIdentifier()}-${platformIdentifier}`
      this.platformConfigs.set(platformKey, platformConfig)

      // Handle child HAP bridge
      if (platformConfig._bridge) {
        // ensure the username is always uppercase
        platformConfig._bridge.username = platformConfig._bridge.username.toUpperCase()

        try {
          this.validateChildBridgeConfig(PluginType.PLATFORM, platformIdentifier, platformConfig._bridge)
        } catch (error: any) {
          log.error(error.message)
          return
        }

        logger(`Initializing child bridge ${platformConfig._bridge.username}`)
        const childBridge = new ChildBridgeService(
          PluginType.PLATFORM,
          platformIdentifier,
          plugin,
          platformConfig._bridge,
          this.config,
          this.options,
          this.api,
          this.ipcService,
          this.externalPortService,
        )

        this.childBridges.set(platformConfig._bridge.username, childBridge)

        // add config to child bridge service
        childBridge.addConfig(platformConfig)

        // If _matter is not defined, we're done - this platform only uses HAP child bridge
        if (!platformConfig._matter) {
          return
        }
      }

      // Handle child Matter bridge
      if (platformConfig._matter && typeof platformConfig._matter === 'object') {
        const matterIdentifier = `${plugin.getPluginIdentifier()}-${platformIdentifier}`
        logger(`Initializing child Matter bridge for ${platformIdentifier}`)

        // Ensure Matter config has proper name
        // Try to get a human-friendly name from the platform
        // Convert CamelCase platform identifier to spaces (e.g., "Ring" stays "Ring", "MySmartHome" becomes "My Smart Home")
        const formattedPlatformId = platformIdentifier.replace(/([A-Z])/g, ' $1').trim()
        // Get plugin name without 'homebridge-' prefix and replace dashes with spaces
        const pluginDisplayName = plugin.getPluginIdentifier()
          .replace('homebridge-', '')
          .replace(/-/g, ' ')
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ')

        const defaultName = platformConfig.name || formattedPlatformId || pluginDisplayName
        const matterConfig = {
          ...platformConfig._matter,
          name: platformConfig._matter.name || defaultName,
        }

        const childMatterBridge = new ChildMatterBridgeService(
          PluginType.PLATFORM,
          plugin,
          matterConfig,
          platformConfig,
          this.api,
          this.externalPortService,
          this.options,
          this.ipcService,
        )

        this.childMatterBridges.set(matterIdentifier, childMatterBridge)

        // If _bridge is also defined, we're done - platform uses both protocols
        if (platformConfig._bridge) {
          return
        }
      }

      // If both _bridge and _matter are defined, the platform is handled by child bridges
      if (platformConfig._bridge || platformConfig._matter) {
        return
      }

      const platform: PlatformPlugin = new constructor(logger, platformConfig, this.api)

      if (HomebridgeAPI.isDynamicPlatformPlugin(platform)) {
        plugin.assignDynamicPlatform(platformIdentifier, platform)
      } else if (HomebridgeAPI.isStaticPlatformPlugin(platform)) { // Plugin 1.0, load accessories
        promises.push(this.bridgeService.loadPlatformAccessories(plugin, platform, platformIdentifier, logger))
      } else {
        // otherwise it's a IndependentPlatformPlugin which doesn't expose any methods at all.
        // We just call the constructor and let it be enabled.
      }
    })

    return promises
  }

  /**
   * Validate an external bridge config
   */
  private validateChildBridgeConfig(type: PluginType, identifier: string, bridgeConfig: BridgeConfiguration): void {
    if (!validMacAddress(bridgeConfig.username)) {
      throw new Error(
        `Error loading the ${type} "${identifier}" requested in your config.json - `
        + `not a valid username in _bridge.username: "${bridgeConfig.username}". Must be 6 pairs of colon-separated hexadecimal chars (A-F 0-9), like a MAC address.`,
      )
    }

    if (this.childBridges.has(bridgeConfig.username)) {
      const childBridge = this.childBridges.get(bridgeConfig.username)
      if (type === PluginType.PLATFORM) {
        // only a single platform can exist on one child bridge
        throw new Error(
          `Error loading the ${type} "${identifier}" requested in your config.json - `
          + `Duplicate username found in _bridge.username: "${bridgeConfig.username}". Each platform child bridge must have it's own unique username.`,
        )
      } else if (childBridge?.identifier !== identifier) {
        // only accessories of the same type can be added to the same child bridge
        throw new Error(
          `Error loading the ${type} "${identifier}" requested in your config.json - `
          + `Duplicate username found in _bridge.username: "${bridgeConfig.username}". You can only group accessories of the same type in a child bridge.`,
        )
      }
    }

    if (bridgeConfig.username === this.config.bridge.username.toUpperCase()) {
      throw new Error(
        `Error loading the ${type} "${identifier}" requested in your config.json - `
        + `Username found in _bridge.username: "${bridgeConfig.username}" is the same as the main bridge. Each child bridge platform/accessory must have it's own unique username.`,
      )
    }
  }

  /**
   * Takes care of the IPC Events sent to Homebridge
   */
  private initializeIpcEventHandlers() {
    // start ipc service
    this.ipcService.start()

    // handle restart child bridge event
    this.ipcService.on(IpcIncomingEvent.RESTART_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.restartChildBridge()
      }
    })

    // handle stop child bridge event
    this.ipcService.on(IpcIncomingEvent.STOP_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.stopChildBridge()
      }
    })

    // handle start child bridge event
    this.ipcService.on(IpcIncomingEvent.START_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.startChildBridge()
      }
    })

    this.ipcService.on(IpcIncomingEvent.CHILD_BRIDGE_METADATA_REQUEST, () => {
      this.ipcService.sendMessage(
        IpcOutgoingEvent.CHILD_BRIDGE_METADATA_RESPONSE,
        Array.from(this.childBridges.values()).map(x => x.getMetadata()),
      )
    })

    // Matter bridge IPC handlers
    this.ipcService.on(IpcIncomingEvent.RESTART_MATTER_BRIDGE, (matterBridgeId: string) => {
      log.info(`Received restart request for Matter bridge: ${matterBridgeId}`)
      if (typeof matterBridgeId === 'string') {
        const matterBridge = this.childMatterBridges.get(matterBridgeId)
        if (matterBridge) {
          log.info(`Restarting Matter bridge: ${matterBridgeId}`)
          matterBridge.restartChildBridge()
        } else {
          log.warn(`Matter bridge not found: ${matterBridgeId}`)
          log.debug('Available Matter bridges:', Array.from(this.childMatterBridges.keys()))
        }
      }
    })

    this.ipcService.on(IpcIncomingEvent.STOP_MATTER_BRIDGE, (matterBridgeId: string) => {
      log.info(`Received stop request for Matter bridge: ${matterBridgeId}`)
      if (typeof matterBridgeId === 'string') {
        const matterBridge = this.childMatterBridges.get(matterBridgeId)
        if (matterBridge) {
          log.info(`Stopping Matter bridge: ${matterBridgeId}`)
          matterBridge.stopChildBridge()
        } else {
          log.warn(`Matter bridge not found: ${matterBridgeId}`)
        }
      }
    })

    this.ipcService.on(IpcIncomingEvent.START_MATTER_BRIDGE, (matterBridgeId: string) => {
      log.info(`Received start request for Matter bridge: ${matterBridgeId}`)
      if (typeof matterBridgeId === 'string') {
        const matterBridge = this.childMatterBridges.get(matterBridgeId)
        if (matterBridge) {
          log.info(`Starting Matter bridge: ${matterBridgeId}`)
          matterBridge.startChildBridge()
        } else {
          log.warn(`Matter bridge not found: ${matterBridgeId}`)
        }
      }
    })

    this.ipcService.on(IpcIncomingEvent.MATTER_BRIDGE_METADATA_REQUEST, () => {
      // Return all child Matter bridge metadata
      this.ipcService.sendMessage(
        IpcOutgoingEvent.MATTER_BRIDGE_METADATA_RESPONSE,
        Array.from(this.childMatterBridges.values()).map(x => x.getMetadata()),
      )
    })

    this.ipcService.on(IpcIncomingEvent.MATTER_ACCESSORIES_REQUEST, () => {
      // Collect Matter accessories from all child bridges
      const allMatterAccessories: {
        children: { [key: string]: any[] }
      } = {
        children: {},
      }

      // Add child bridge accessories
      for (const [bridgeId, childBridge] of this.childMatterBridges) {
        allMatterAccessories.children[bridgeId] = childBridge.getMatterAccessories ? childBridge.getMatterAccessories() : []
      }

      this.ipcService.sendMessage(
        IpcOutgoingEvent.MATTER_ACCESSORIES_RESPONSE,
        allMatterAccessories,
      )
    })

    // Handle new Matter IPC events
    this.ipcService.on(IpcIncomingEvent.TOGGLE_MATTER_DEVICE, (data: { uuid: string, enabled: boolean }) => {
      if (data && data.uuid) {
        // This would toggle Matter for a specific device
        // Implementation depends on how devices are managed
        log.debug(`Toggle Matter for device ${data.uuid}: ${data.enabled}`)

        // Send status update
        this.ipcService.sendMessage(
          IpcOutgoingEvent.MATTER_DEVICE_STATUS_UPDATE,
          {
            uuid: data.uuid,
            matterEnabled: data.enabled,
          },
        )
      }
    })

    this.ipcService.on(IpcIncomingEvent.MATTER_COMMISSIONING_INFO_REQUEST, (matterBridgeId: string) => {
      let commissioningInfo = null

      // Get child bridge commissioning info
      const childBridge = this.childMatterBridges.get(matterBridgeId)
      if (childBridge && (childBridge as any).getCommissioningInfo) {
        commissioningInfo = (childBridge as any).getCommissioningInfo()
      }

      this.ipcService.sendMessage(
        IpcOutgoingEvent.MATTER_COMMISSIONING_INFO_RESPONSE,
        commissioningInfo || { commissioned: false },
      )
    })
  }

  private printSetupInfo(pin: string): void {
    /* eslint-disable no-console */
    console.log('Setup Payload:')
    console.log(this.bridgeService.bridge.setupURI())

    if (!this.options.hideQRCode) {
      console.log('Scan this code with your HomeKit app on your iOS device to pair with Homebridge:')
      qrcode.setErrorLevel('M') // HAP specifies level M or higher for ECC
      qrcode.generate(this.bridgeService.bridge.setupURI())
      console.log('Or enter this code with your HomeKit app on your iOS device to pair with Homebridge:')
    } else {
      console.log('Enter this code with your HomeKit app on your iOS device to pair with Homebridge:')
    }

    console.log(chalk.black.bgWhite('                       '))
    console.log(chalk.black.bgWhite('    ┌────────────┐     '))
    console.log(chalk.black.bgWhite(`    │ ${pin} │     `))
    console.log(chalk.black.bgWhite('    └────────────┘     '))
    console.log(chalk.black.bgWhite('                       '))
    /* eslint-enable no-console */
  }
}
