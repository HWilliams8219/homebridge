/**
 * Matter Device Implementation
 *
 * Handles creation of individual Matter devices from HAP accessories
 * with proper Matter.js integration and type safety
 */

import { Endpoint, EndpointType } from '@matter/main'
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors'
import {
  ContactSensorDevice,
  DimmableLightDevice,
  DimmablePlugInUnitDevice,
  GenericSwitchDevice,
  HumiditySensorDevice,
  LightSensorDevice,
  OccupancySensorDevice,
  OnOffLightDevice,
  OnOffLightSwitchDevice,
  OnOffPlugInUnitDevice,
  OnOffSensorDevice,
  PressureSensorDevice,
  PumpDevice,
  RoomAirConditionerDevice,
  SmokeCoAlarmDevice,
  TemperatureSensorDevice,
  ThermostatDevice,
  WaterLeakDetectorDevice,
  WindowCoveringDevice,
} from '@matter/main/devices'
import { Characteristic, Service } from 'hap-nodejs'

import { Logger } from '../logger.js'
import { PlatformAccessory } from '../platformAccessory.js'

const log = Logger.withPrefix('Matter')

/**
 * Strongly typed endpoint state interface for Matter clusters
 */
interface MatterEndpointState {
  onOff?: {
    onOff: boolean
  }
  levelControl?: {
    currentLevel: number | null
    minLevel?: number
    maxLevel?: number
  }
  colorControl?: {
    currentHue?: number
    currentSaturation?: number
    colorTemperatureMireds?: number
    colorMode?: number
  }
  temperatureMeasurement?: {
    measuredValue: number | null
    minMeasuredValue?: number
    maxMeasuredValue?: number
  }
  relativeHumidityMeasurement?: {
    measuredValue: number | null
    minMeasuredValue?: number
    maxMeasuredValue?: number
  }
  illuminanceMeasurement?: {
    measuredValue: number | null
    minMeasuredValue?: number
    maxMeasuredValue?: number
  }
  occupancySensing?: {
    occupancy: {
      occupied: boolean
    }
  }
  booleanState?: {
    stateValue: boolean
  }
  doorLock?: {
    lockState: number
    lockType?: number
  }
  windowCovering?: {
    targetPositionLiftPercent100ths: number | null
    currentPositionLiftPercent100ths?: number | null
  }
  fanControl?: {
    percentSetting: number | null
    fanMode?: number
    speedSetting?: number | null
  }
  thermostat?: {
    localTemperature?: number | null
    occupiedCoolingSetpoint?: number
    occupiedHeatingSetpoint?: number
    systemMode?: number
  }
  flowMeasurement?: {
    measuredValue: number | null
    minMeasuredValue?: number
    maxMeasuredValue?: number
  }
  pressureMeasurement?: {
    measuredValue: number | null
    minMeasuredValue?: number
    maxMeasuredValue?: number
  }
  valveConfigurationAndControl?: {
    currentState?: number
    targetState?: number
  }
  pumpConfigurationAndControl?: {
    operationMode: number
    controlMode?: number
  }
  smokeCoAlarm?: {
    smokeState?: number
    coState?: number
    batteryAlert?: number
  }
  switch?: {
    currentPosition?: number
    numberOfPositions?: number
  }
}

/**
 * Type-safe wrapper for Matter endpoint with proper state handling
 */
class TypedMatterEndpoint {
  constructor(
    private endpoint: Endpoint,
    private stateProxy: MatterEndpointState = {},
  ) {}

  /**
   * Get typed state for a cluster
   */
  getClusterState<K extends keyof MatterEndpointState>(
    cluster: K,
  ): MatterEndpointState[K] | undefined {
    return this.stateProxy[cluster]
  }

  /**
   * Update cluster state with type safety
   */
  async updateClusterState<K extends keyof MatterEndpointState>(
    cluster: K,
    updates: Partial<MatterEndpointState[K]>,
  ): Promise<void> {
    if (!this.stateProxy[cluster]) {
      this.stateProxy[cluster] = {} as MatterEndpointState[K]
    }

    Object.assign(this.stateProxy[cluster]!, updates)

    // Trigger Matter.js state update
    // This would normally interact with the endpoint's behaviors
    // For now, we'll log the update
    log.debug(`Updated ${String(cluster)} state:`, updates)
  }

  /**
   * Get the raw endpoint
   */
  getRawEndpoint(): Endpoint {
    return this.endpoint
  }
}

/**
 * Represents a single Matter device created from a HAP accessory
 */
export class MatterDevice {
  private endpoint: Endpoint | null = null
  private typedEndpoint: TypedMatterEndpoint | null = null
  private deviceType: string | null = null
  private primaryService: Service | null = null
  private readonly characteristicSubscriptions = new Map<string, any>()
  private readonly cleanupCallbacks: Array<() => void | Promise<void>> = []
  private isDestroyed = false

  constructor(private accessory: PlatformAccessory) {
    // Identify primary service
    this.identifyPrimaryService()
  }

  /**
   * Get the HAP accessory
   */
  getAccessory(): PlatformAccessory {
    return this.accessory
  }

  /**
   * Identify the primary service from the accessory
   */
  private identifyPrimaryService(): void {
    const services = this.accessory.services || []

    // Find the primary service (not AccessoryInformation)
    for (const service of services) {
      const serviceName = service.constructor.name
      if (serviceName !== 'AccessoryInformation' && serviceName !== 'ProtocolInformation') {
        this.primaryService = service
        break
      }
    }

    if (!this.primaryService && services.length > 0) {
      // Fallback to first service if no primary found
      this.primaryService = services[0]
    }
  }

  /**
   * Determine the Matter device type based on HAP service
   */
  private getMatterDeviceType(): { deviceType: string, endpointType: EndpointType } | null {
    if (!this.primaryService) {
      return null
    }

    const serviceName = this.primaryService.constructor.name
    log.debug(`Mapping HAP service '${serviceName}' for accessory '${this.accessory.displayName}'`)

    const hasCharacteristic = (name: string) =>
      this.primaryService!.characteristics.some(c => c.constructor.name === name)

    // Enhanced HAP to Matter device type mapping
    let deviceTypeName: string
    let endpointType: EndpointType

    switch (serviceName) {
      case 'Lightbulb':
        // Simplify to avoid color control initialization issues
        if (hasCharacteristic('Brightness')) {
          deviceTypeName = 'DimmableLight'
          endpointType = DimmableLightDevice.with(BridgedDeviceBasicInformationServer)
        } else {
          deviceTypeName = 'OnOffLight'
          endpointType = OnOffLightDevice.with(BridgedDeviceBasicInformationServer)
        }
        break

      case 'Outlet':
        if (hasCharacteristic('Brightness')) {
          deviceTypeName = 'DimmablePlugInUnit'
          endpointType = DimmablePlugInUnitDevice.with(BridgedDeviceBasicInformationServer)
        } else {
          deviceTypeName = 'OnOffPlugInUnit'
          endpointType = OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer)
        }
        break

      case 'Switch':
        if (hasCharacteristic('ProgrammableSwitchEvent')) {
          deviceTypeName = 'GenericSwitch'
          endpointType = GenericSwitchDevice.with(BridgedDeviceBasicInformationServer)
        } else if (hasCharacteristic('Brightness')) {
          // Note: DimmerSwitch not available in Matter.js v0.15, use light switch
          deviceTypeName = 'OnOffLightSwitch'
          endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        } else {
          deviceTypeName = 'OnOffLightSwitch'
          endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        }
        break

      case 'TemperatureSensor':
        deviceTypeName = 'TemperatureSensor'
        endpointType = TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'HumiditySensor':
        deviceTypeName = 'HumiditySensor'
        endpointType = HumiditySensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'LightSensor':
        deviceTypeName = 'LightSensor'
        endpointType = LightSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'OccupancySensor':
        deviceTypeName = 'OccupancySensor'
        endpointType = OccupancySensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'ContactSensor':
        deviceTypeName = 'ContactSensor'
        endpointType = ContactSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'LockManagement':
      case 'Lock':
      case 'LockMgmt':
      case 'LockMechanism':
        // DoorLock has issues with actuatorEnabled, use simpler switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'WindowCovering':
      case 'Window':
        deviceTypeName = 'WindowCovering'
        endpointType = WindowCoveringDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Thermostat':
        deviceTypeName = 'Thermostat'
        endpointType = ThermostatDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Fan':
      case 'Fanv2':
        // Fan has issues with fanModeSequence and percentCurrent, use switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'GarageDoorOpener':
      case 'Door':
        // DoorLock has issues with actuatorEnabled, use simpler switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'HeaterCooler':
        deviceTypeName = 'RoomAirConditioner'
        endpointType = RoomAirConditionerDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'HumidifierDehumidifier':
        // Fan has issues with fanModeSequence and percentCurrent, use switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Valve':
      case 'Faucet':
        // WaterValve has issues with open/close commands, use switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'IrrigationSystem':
        deviceTypeName = 'Pump'
        endpointType = PumpDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'LeakSensor':
        deviceTypeName = 'WaterLeakDetector'
        endpointType = WaterLeakDetectorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'MotionSensor':
        deviceTypeName = 'OccupancySensor'
        endpointType = OccupancySensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'SmokeSensor':
      case 'CarbonMonoxideSensor':
      case 'CarbonDioxideSensor':
        deviceTypeName = 'SmokeCoAlarm'
        endpointType = SmokeCoAlarmDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'PressureSensor':
        deviceTypeName = 'PressureSensor'
        endpointType = PressureSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'SecuritySystem':
        deviceTypeName = 'OnOffSensor'
        endpointType = OnOffSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'StatelessProgrammableSwitch':
        deviceTypeName = 'GenericSwitch'
        endpointType = GenericSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Doorbell':
        deviceTypeName = 'GenericSwitch'
        endpointType = GenericSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Battery':
      case 'BatteryService':
        deviceTypeName = 'OnOffSensor'
        endpointType = OnOffSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'Slat':
        deviceTypeName = 'WindowCovering'
        endpointType = WindowCoveringDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Television/Media accessories
      case 'Television':
      case 'TelevisionSpeaker':
      case 'InputSource':
        // Use basic switch for TV control
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Speaker accessories
      case 'Speaker':
      case 'AirPlaySpeaker':
        // Use basic switch for speaker control
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Camera accessories
      case 'Camera':
      case 'CameraRTPStreamManagement':
      case 'CameraRecordingManagement':
      case 'CameraOperatingMode':
      case 'CameraEventRecordingManagement':
        // Cameras aren't directly supported in Matter, use sensor
        deviceTypeName = 'OccupancySensor'
        endpointType = OccupancySensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Audio/Video accessories
      case 'Microphone':
      case 'AudioStreamManagement':
        // Use basic switch for audio control
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Service/Management types
      case 'AccessoryInformation':
      case 'AccessoryRuntimeInformation':
      case 'ServiceLabel':
      case 'ThreadTransport':
      case 'WiFiTransport':
      case 'PowerManagement':
      case 'TransferTransportManagement':
      case 'TimeInformation':
      case 'FirmwareUpdate':
      case 'DiagnosticsSnapshot':
        // Skip service/management types - return null
        log.debug(`Skipping service type: ${serviceName}`)
        return null

      // Siri/Assistant
      case 'Siri':
      case 'SiriEndpoint':
      case 'Assistant':
      case 'TargetControlManagement':
      case 'TargetControl':
        // Use basic switch for assistant control
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Additional sensors
      case 'AirQualitySensor':
        // Use temperature sensor as closest match
        deviceTypeName = 'TemperatureSensor'
        endpointType = TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'FilterMaintenance':
      case 'AirPurifier':
        // Map to switch for air purifier control
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      // Additional common types
      case 'WiFiRouter':
      case 'WiFiSatellite':
        // Network devices - use basic switch
        deviceTypeName = 'OnOffLightSwitch'
        endpointType = OnOffLightSwitchDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'PowerStrip':
        // Multiple outlets - use outlet
        deviceTypeName = 'OnOffPlugInUnit'
        endpointType = OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer)
        break

      case 'ChargerService':
        // EV Charger or device charger
        deviceTypeName = 'OnOffPlugInUnit'
        endpointType = OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer)
        break

      default:
        // Log all available services for debugging
        if (this.accessory.services && this.accessory.services.length > 0) {
          const serviceTypes = this.accessory.services.map(s => s.constructor.name).join(', ')
          log.warn(`Unknown HAP service type: ${serviceName} for accessory: ${this.accessory.displayName}. Available services: ${serviceTypes}`)
        } else {
          log.warn(`Unknown HAP service type: ${serviceName} for accessory: ${this.accessory.displayName}`)
        }
        // Default to basic on/off sensor
        deviceTypeName = 'OnOffSensor'
        endpointType = OnOffSensorDevice.with(BridgedDeviceBasicInformationServer)
    }

    this.deviceType = deviceTypeName
    return { deviceType: deviceTypeName, endpointType }
  }

  /**
   * Create Matter endpoint from HAP accessory
   */
  async createEndpoint(): Promise<Endpoint | null> {
    try {
      // Identify primary service
      this.primaryService = this.getPrimaryService()
      if (!this.primaryService) {
        log.warn(`No primary service found for: ${this.accessory.displayName}`)
        return null
      }

      // Determine device type based on service
      const deviceMapping = this.getMatterDeviceType()

      if (!deviceMapping) {
        // Always log the service type for unsupported devices
        const serviceName = this.primaryService.constructor.name
        log.warn(`Unsupported device type for: ${this.accessory.displayName} (Service: ${serviceName})`)
        return null
      }

      const { deviceType, endpointType } = deviceMapping
      this.deviceType = deviceType

      log.info(`Creating Matter endpoint: ${deviceType} for ${this.accessory.displayName}`)

      // Create endpoint with proper configuration
      this.endpoint = await this.createMatterEndpoint(endpointType)

      if (!this.endpoint) {
        log.error(`Failed to create Matter endpoint for: ${this.accessory.displayName}`)
        return null
      }

      // Create typed endpoint wrapper for type-safe state management
      this.typedEndpoint = new TypedMatterEndpoint(this.endpoint)

      // Initialize with current HAP values
      await this.initializeFromHAP()

      log.debug(`✅ Created Matter endpoint: ${this.deviceType} for ${this.accessory.displayName}`)
      return this.endpoint
    } catch (error) {
      log.error(`Failed to create endpoint for ${this.accessory.displayName}:`, error)
      return null
    }
  }

  /**
   * Parse version string to number (major version only)
   */
  private parseVersion(versionString: string): number {
    try {
      const parts = versionString.split('.')
      const major = Number.parseInt(parts[0], 10)
      return Number.isNaN(major) ? 1 : Math.min(major, 65535) // Limit to UINT16
    } catch {
      return 1
    }
  }

  /**
   * Get AccessoryInformation values from HAP accessory
   */
  private getAccessoryInformation() {
    // Try to get AccessoryInformation service from the accessory
    const infoService = this.accessory.services?.find(
      service => service.constructor.name === 'AccessoryInformation',
    )

    // Default values matching Homebridge HAP bridge defaults
    let manufacturer = 'homebridge.io'
    let model = 'homebridge'
    let serialNumber = this.accessory.UUID.substring(0, 32)
    let firmwareRevision = '2.0.0'
    let hardwareRevision = '1.0.0'

    if (infoService) {
      // Get Manufacturer characteristic
      const manufacturerChar = infoService.characteristics?.find(
        c => c.constructor.name === 'Manufacturer',
      )
      if (manufacturerChar?.value !== null && manufacturerChar?.value !== undefined) {
        manufacturer = String(manufacturerChar.value) || manufacturer
      }

      // Get Model characteristic
      const modelChar = infoService.characteristics?.find(
        c => c.constructor.name === 'Model',
      )
      if (modelChar?.value !== null && modelChar?.value !== undefined) {
        model = String(modelChar.value) || model
      }

      // Get SerialNumber characteristic
      const serialChar = infoService.characteristics?.find(
        c => c.constructor.name === 'SerialNumber',
      )
      if (serialChar?.value !== null && serialChar?.value !== undefined) {
        const serialValue = String(serialChar.value)
        serialNumber = serialValue ? serialValue.substring(0, 32) : serialNumber
      }

      // Get FirmwareRevision characteristic
      const firmwareChar = infoService.characteristics?.find(
        c => c.constructor.name === 'FirmwareRevision',
      )
      if (firmwareChar?.value !== null && firmwareChar?.value !== undefined) {
        firmwareRevision = String(firmwareChar.value) || firmwareRevision
      }

      // Get HardwareRevision characteristic
      const hardwareChar = infoService.characteristics?.find(
        c => c.constructor.name === 'HardwareRevision',
      )
      if (hardwareChar?.value !== null && hardwareChar?.value !== undefined) {
        hardwareRevision = String(hardwareChar.value) || hardwareRevision
      }
    }

    return {
      manufacturer,
      model,
      serialNumber,
      firmwareRevision,
      hardwareRevision,
    }
  }

  /**
   * Create the specific Matter endpoint with proper type
   */
  private async createMatterEndpoint(endpointType: EndpointType): Promise<Endpoint | null> {
    // Generate unique identifiers
    const uuidClean = this.accessory.UUID.replace(/-/g, '')
    const uniqueId = uuidClean.padEnd(32, '0').substring(0, 32)
    const deviceName = this.accessory.displayName

    // Get AccessoryInformation from HAP accessory
    const accessoryInfo = this.getAccessoryInformation()
    log.debug(`AccessoryInformation for ${deviceName}:`, {
      manufacturer: accessoryInfo.manufacturer,
      model: accessoryInfo.model,
      serialNumber: accessoryInfo.serialNumber,
      firmware: accessoryInfo.firmwareRevision,
      hardware: accessoryInfo.hardwareRevision,
    })

    // Create bridged device configuration using HAP AccessoryInformation values
    // IMPORTANT: Both nodeLabel and productLabel must be set to the device name for it to appear correctly in Home app
    const bridgedDeviceConfig = {
      nodeLabel: deviceName.slice(0, 32), // Maximum 32 characters for nodeLabel
      productLabel: deviceName.slice(0, 64), // Maximum 64 characters for productLabel
      productName: accessoryInfo.model.slice(0, 32), // Model from HAP AccessoryInformation
      serialNumber: accessoryInfo.serialNumber.slice(0, 32), // SerialNumber from HAP
      uniqueId,
      vendorName: accessoryInfo.manufacturer.slice(0, 32), // Manufacturer from HAP
      vendorId: 0xFFF1, // Homebridge vendor ID
      productId: 0x8001,
      reachable: true,
      softwareVersion: this.parseVersion(accessoryInfo.firmwareRevision),
      softwareVersionString: accessoryInfo.firmwareRevision.slice(0, 64),
      hardwareVersion: this.parseVersion(accessoryInfo.hardwareRevision),
      hardwareVersionString: accessoryInfo.hardwareRevision.slice(0, 64),
    }

    try {
      // Create endpoint configuration with initial state based on device type
      const endpointConfig: any = {
        id: `endpoint-${this.accessory.UUID}`,
        bridgedDeviceBasicInformation: bridgedDeviceConfig,
      }

      // Set initial state based on device type
      // This maps HAP characteristics to Matter cluster attributes
      await this.setInitialEndpointState(endpointConfig)

      // Create the endpoint with BridgedDeviceBasicInformation
      // The endpoint needs the bridged device information for proper naming
      const endpoint = new Endpoint(endpointType, endpointConfig)

      return endpoint
    } catch (error) {
      log.error(`Failed to create Matter device: ${error}`)
      return null
    }
  }

  /**
   * Set initial endpoint state based on HAP values
   */
  private async setInitialEndpointState(config: any): Promise<void> {
    // Map common characteristics
    switch (this.deviceType) {
      case 'OnOffLight':
      case 'OnOffPlugInUnit':
      case 'OnOffLightSwitch': {
        config.onOff = {
          onOff: this.getHAPValue('On') || false,
        }
        break
      }

      case 'DimmableLight':
      case 'DimmablePlugInUnit': {
        config.onOff = {
          onOff: this.getHAPValue('On') || false,
        }
        config.levelControl = {
          currentLevel: Math.round((this.getHAPValue('Brightness') || 0) * 2.54),
          minLevel: 1,
          maxLevel: 254,
        }
        break
      }

      case 'ColorTemperatureLight': {
        config.onOff = {
          onOff: this.getHAPValue('On') || false,
        }
        config.levelControl = {
          currentLevel: Math.round((this.getHAPValue('Brightness') || 0) * 2.54),
          minLevel: 1,
          maxLevel: 254,
        }
        const colorTemp = this.getHAPValue('ColorTemperature') || 370
        const mireds = Math.round(1000000 / colorTemp)
        config.colorControl = {
          colorMode: 2,
          colorTemperatureMireds: Math.max(153, Math.min(500, mireds)),
          colorTempPhysicalMinMireds: 153,
          colorTempPhysicalMaxMireds: 500,
        }
        break
      }

      case 'ExtendedColorLight': {
        config.onOff = {
          onOff: this.getHAPValue('On') || false,
        }
        config.levelControl = {
          currentLevel: Math.round((this.getHAPValue('Brightness') || 0) * 2.54),
          minLevel: 1,
          maxLevel: 254,
        }
        config.colorControl = {
          colorMode: 0,
          currentHue: Math.round((this.getHAPValue('Hue') || 0) * 254 / 360),
          currentSaturation: Math.round((this.getHAPValue('Saturation') || 0) * 2.54),
          colorTemperatureMireds: 370,
          colorTempPhysicalMinMireds: 153,
          colorTempPhysicalMaxMireds: 500,
        }
        break
      }

      case 'TemperatureSensor': {
        config.temperatureMeasurement = {
          measuredValue: Math.round((this.getHAPValue('CurrentTemperature') || 20) * 100),
          minMeasuredValue: -27315,
          maxMeasuredValue: 32767,
        }
        break
      }

      case 'HumiditySensor': {
        config.relativeHumidityMeasurement = {
          measuredValue: Math.round((this.getHAPValue('CurrentRelativeHumidity') || 50) * 100),
          minMeasuredValue: 0,
          maxMeasuredValue: 10000,
        }
        break
      }

      case 'LightSensor': {
        const lux = this.getHAPValue('CurrentAmbientLightLevel') || 100
        config.illuminanceMeasurement = {
          measuredValue: Math.round(Math.log10(Math.max(1, lux)) * 10000),
          minMeasuredValue: 0,
          maxMeasuredValue: 65534,
        }
        break
      }

      case 'OccupancySensor': {
        config.occupancySensing = {
          occupancy: {
            occupied: Boolean(this.getHAPValue('OccupancyDetected') || this.getHAPValue('MotionDetected')),
          },
        }
        break
      }

      case 'ContactSensor': {
        config.booleanState = {
          stateValue: (this.getHAPValue('ContactSensorState') || 0) === 0,
        }
        break
      }

      case 'DoorLock': {
        const lockState = this.getHAPValue('LockCurrentState') || 0
        config.doorLock = {
          lockState: lockState === 1 ? 1 : 2,
          lockType: 0,
        }
        break
      }

      case 'WindowCovering': {
        const position = this.getHAPValue('CurrentPosition') || 0
        config.windowCovering = {
          currentPositionLiftPercent100ths: position * 100,
          targetPositionLiftPercent100ths: (this.getHAPValue('TargetPosition') || position) * 100,
        }
        break
      }

      case 'Thermostat': {
        config.thermostat = {
          localTemperature: Math.round((this.getHAPValue('CurrentTemperature') || 20) * 100),
          occupiedCoolingSetpoint: Math.round((this.getHAPValue('CoolingThresholdTemperature') || 26) * 100),
          occupiedHeatingSetpoint: Math.round((this.getHAPValue('HeatingThresholdTemperature') || 20) * 100),
          systemMode: this.getHAPValue('CurrentHeatingCoolingState') || 0,
        }
        break
      }

      case 'Fan': {
        const speed = this.getHAPValue('RotationSpeed') || 0
        config.fanControl = {
          percentSetting: Math.round(speed),
          fanMode: speed > 0 ? 3 : 0,
        }
        break
      }

      case 'WaterLeakDetector': {
        config.booleanState = {
          stateValue: Boolean(this.getHAPValue('LeakDetected')),
        }
        break
      }

      case 'SmokeCoAlarm': {
        config.smokeCoAlarm = {
          smokeState: this.getHAPValue('SmokeDetected') ? 1 : 0,
          coState: this.getHAPValue('CarbonMonoxideDetected') ? 1 : 0,
        }
        break
      }

      case 'GenericSwitch': {
        // Generic switch for programmable switches
        config.switch = {
          currentPosition: 0,
          numberOfPositions: 2,
        }
        break
      }

      default: {
        // Default to basic on/off if we have the characteristic
        if (this.getHAPValue('On') !== undefined) {
          config.onOff = {
            onOff: this.getHAPValue('On') || false,
          }
        }
        break
      }
    }
  }

  /**
   * Initialize Matter endpoint from HAP values
   */
  private async initializeFromHAP(): Promise<void> {
    if (!this.endpoint || !this.primaryService || !this.typedEndpoint) {
      return
    }

    // Initial values are already set during endpoint creation
    // This method is for future use when we need to refresh values
    log.debug(`Initialized Matter device with HAP values for: ${this.accessory.displayName}`)
  }

  /**
   * Start bidirectional sync between HAP and Matter
   */
  startSync(): void {
    if (!this.primaryService || !this.endpoint || this.isDestroyed) {
      return
    }

    log.debug(`Starting sync for: ${this.accessory.displayName}`)

    // Limit number of subscriptions to prevent memory issues
    const MAX_SUBSCRIPTIONS = 50 // Prevent memory leaks from unbounded subscriptions
    let subscriptionCount = 0

    // Subscribe to HAP characteristic changes
    for (const characteristic of this.primaryService.characteristics) {
      const charType = characteristic.constructor.name

      // Skip non-data characteristics
      if (charType === 'Name' || charType === 'ServiceLabelIndex') {
        continue
      }

      // Check subscription limit
      if (subscriptionCount >= MAX_SUBSCRIPTIONS) {
        log.warn(`Subscription limit reached (${MAX_SUBSCRIPTIONS}) for ${this.accessory.displayName}, skipping additional characteristics`)
        break
      }

      // Prevent duplicate subscriptions
      if (this.characteristicSubscriptions.has(charType)) {
        log.debug(`Already subscribed to ${charType} for ${this.accessory.displayName}`)
        continue
      }

      const handler = this.createHAPChangeHandler(charType)
      if (handler) {
        characteristic.on('change', handler)
        this.characteristicSubscriptions.set(charType, handler)
        this.cleanupCallbacks.push(() => {
          characteristic.off('change', handler)
        })
        subscriptionCount++
      }
    }

    log.debug(`✅ Sync started for: ${this.accessory.displayName}`)
  }

  /**
   * Create HAP change handler for a characteristic
   */
  private createHAPChangeHandler(characteristicType: string): ((change: any) => void) | null {
    return (change: any) => {
      if (this.isDestroyed || !this.typedEndpoint) {
        return
      }

      const { newValue } = change
      log.debug(`HAP change for ${this.accessory.displayName}: ${characteristicType} = ${newValue}`)

      // Map HAP changes to Matter updates
      // This would be expanded to handle all characteristic types
      this.updateMatterFromHAP(characteristicType, newValue).catch((error) => {
        log.error(`Failed to update Matter from HAP for ${this.accessory.displayName}:`, error)
      })
    }
  }

  /**
   * Update Matter state from HAP change
   */
  private async updateMatterFromHAP(characteristicType: string, value: any): Promise<void> {
    if (!this.typedEndpoint) {
      return
    }

    // Map HAP characteristics to Matter cluster updates
    switch (characteristicType) {
      case 'On':
        await this.typedEndpoint.updateClusterState('onOff', { onOff: Boolean(value) })
        break

      case 'Brightness':
        await this.typedEndpoint.updateClusterState('levelControl', {
          currentLevel: Math.round(value * 2.54),
        })
        break

      case 'Hue':
        await this.typedEndpoint.updateClusterState('colorControl', {
          currentHue: Math.round(value * 254 / 360),
        })
        break

      case 'Saturation':
        await this.typedEndpoint.updateClusterState('colorControl', {
          currentSaturation: Math.round(value * 2.54),
        })
        break

      case 'ColorTemperature': {
        const mireds = Math.round(1000000 / value)
        await this.typedEndpoint.updateClusterState('colorControl', {
          colorTemperatureMireds: Math.max(153, Math.min(500, mireds)),
        })
        break
      }

      case 'CurrentTemperature':
        await this.typedEndpoint.updateClusterState('temperatureMeasurement', {
          measuredValue: Math.round(value * 100),
        })
        break

      case 'CurrentRelativeHumidity':
        await this.typedEndpoint.updateClusterState('relativeHumidityMeasurement', {
          measuredValue: Math.round(value * 100),
        })
        break

      case 'OccupancyDetected':
      case 'MotionDetected':
        await this.typedEndpoint.updateClusterState('occupancySensing', {
          occupancy: { occupied: Boolean(value) },
        })
        break

      case 'ContactSensorState':
        await this.typedEndpoint.updateClusterState('booleanState', {
          stateValue: value === 0,
        })
        break

      case 'LockCurrentState':
        await this.typedEndpoint.updateClusterState('doorLock', {
          lockState: value === 1 ? 1 : 2,
        })
        break

      // Add more characteristic mappings as needed
    }
  }

  /**
   * Stop synchronization
   */
  stopSync(): void {
    // Remove all HAP characteristic subscriptions
    if (this.primaryService) {
      for (const [charType, handler] of this.characteristicSubscriptions) {
        const characteristic = this.primaryService.characteristics.find(
          c => c.constructor.name === charType,
        )
        if (characteristic && typeof handler === 'function') {
          characteristic.off('change', handler)
        }
      }
    }
    this.characteristicSubscriptions.clear()

    // Run all cleanup callbacks
    for (const cleanup of this.cleanupCallbacks) {
      try {
        const result = cleanup()
        if (result instanceof Promise) {
          result.catch(error => log.debug('Cleanup error:', error))
        }
      } catch (error) {
        log.debug('Cleanup error:', error)
      }
    }
    this.cleanupCallbacks.length = 0 // Clear array contents

    log.debug(`Sync stopped for: ${this.accessory.displayName}`)
  }

  /**
   * Get the primary service from accessory
   */
  private getPrimaryService(): Service | null {
    const utilityServices = [
      'AccessoryInformation',
      'BridgingState',
      'HAPProtocolInformation',
      'Pairing',
      'BridgeConfiguration',
    ]

    for (const service of this.accessory.services) {
      // Try multiple ways to get the service type
      const serviceType = service.constructor.name
        || (service as any).displayName
        || (service as any).UUID

      // Also check the service's UUID/subtype
      const serviceName = (service as any).displayName || serviceType

      if (!utilityServices.includes(serviceType)) {
        log.debug(`Found primary service for ${this.accessory.displayName}: ${serviceName} (type: ${serviceType})`)
        return service
      }
    }

    return null
  }

  /**
   * Get HAP characteristic value
   */
  private getHAPValue(characteristicType: string): any {
    const characteristic = this.getHAPCharacteristic(characteristicType)
    return characteristic?.value
  }

  /**
   * Get HAP characteristic by type
   */
  private getHAPCharacteristic(characteristicType: string): Characteristic | null {
    if (!this.primaryService) {
      return null
    }

    return this.primaryService.characteristics.find(
      c => c.constructor.name === characteristicType,
    ) || null
  }

  /**
   * Convert Kelvin to Mireds
   */
  private kelvinToMireds(kelvin: number): number {
    return Math.round(1000000 / kelvin)
  }

  /**
   * Convert Mireds to Kelvin
   */
  private miredsToKelvin(mireds: number): number {
    return Math.round(1000000 / mireds)
  }

  /**
   * Get the device type
   */
  getDeviceType(): string | null {
    return this.deviceType
  }

  /**
   * Get the Matter endpoint
   */
  async getEndpoint(): Promise<Endpoint | null> {
    return this.endpoint
  }

  /**
   * Clean up the device
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) {
      return
    }

    this.isDestroyed = true
    this.stopSync()

    // Clear all references
    this.endpoint = null
    this.typedEndpoint = null
    this.primaryService = null
    this.deviceType = null
    this.characteristicSubscriptions.clear()
    this.cleanupCallbacks.length = 0 // Clear array contents

    log.debug(`Destroyed Matter device for: ${this.accessory.displayName}`)
  }
}
