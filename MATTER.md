# Matter Protocol Support in Homebridge

Homebridge 2.0 includes comprehensive support for the Matter protocol alongside the existing HomeKit HAP support. This allows accessories to be exposed via both protocols simultaneously, making them available to a wider range of smart home ecosystems.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
  - [Child Matter Bridges](#child-matter-bridges)
  - [Configuration Options](#configuration-options)
- [Architecture](#architecture)
  - [Process Structure](#process-structure)
  - [Child Matter Bridges](#child-matter-bridges-1)
  - [IPC Communication](#ipc-communication)
- [Plugin Development](#plugin-development)
  - [API Methods](#api-methods)
  - [Matter Device Types and Clusters](#matter-device-types-and-clusters)
  - [Helper Functions](#helper-functions)
- [Production Features](#production-features)
  - [Configuration Validation](#configuration-validation)
  - [Security Features](#security-features)
  - [CLI Tools](#cli-tools)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Migration Guide](#migration-guide)
- [Technical Implementation](#technical-implementation)
- [Current Status & Limitations](#current-status--limitations)
- [Resources](#resources)

## Overview

Matter is an open-source connectivity standard for smart home devices, allowing devices from different manufacturers to work together seamlessly. With Homebridge's Matter support, plugins can expose accessories to both HomeKit and Matter-compatible controllers such as:

- Apple Home (via HomeKit and Matter)
- Google Home (via Matter)
- Amazon Alexa (via Matter)
- Samsung SmartThings (via Matter)
- Philips Hue Bridge (via Matter)
- And any other Matter-compatible controller

## Configuration

### Child Matter Bridges

Matter support in Homebridge works exclusively through child Matter bridges. There is no main/root Matter bridge. To expose accessories via Matter, configure the `_matter` property on individual accessories or platforms.

Homebridge creates child Matter bridges that run in separate processes when you configure an accessory or platform with the `_matter` property. This provides isolation, stability, and resource management - exactly parallel to how `_bridge` works for HAP child bridges.

#### Accessory with Child Matter Bridge

```json
{
  "accessories": [
    {
      "accessory": "SmartSwitch",
      "name": "Living Room Switch",
      "_matter": {
        "enabled": true,
        "name": "Living Room Switch Matter",
        "port": 5541
      }
    }
  ]
}
```

#### Platform with Child Matter Bridge

```json
{
  "platforms": [
    {
      "platform": "SmartHomePlatform",
      "name": "Smart Home",
      "_matter": {
        "enabled": true,
        "name": "Smart Home Matter Bridge",
        "port": 5542
      }
    }
  ]
}
```

#### Dual Protocol with Child Bridges

Expose accessories via both HomeKit and Matter, each in their own child process:

```json
{
  "accessories": [
    {
      "accessory": "SmartLight",
      "name": "Bedroom Light",
      "_bridge": {
        "username": "CC:22:3D:E3:CE:31",
        "port": 51827
      },
      "_matter": {
        "enabled": true,
        "name": "Bedroom Light Matter",
        "port": 5543
      }
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable Matter support |
| `name` | string | Auto-generated | Display name for the Matter bridge |
| `port` | number | Dynamic | UDP port for Matter communication (5540-5580 recommended) |
| `debug` | boolean | `false` | Enable debug logging for this Matter bridge |

## Architecture

### Process Structure

```
Homebridge Main Process
├── HAP Bridge (Main)
├── Matter Bridge (Main, if configured)
├── Child HAP Bridges (if configured with _bridge)
└── Child Matter Bridges (if configured with _matter)
    ├── Matter Bridge 1 (Child Process)
    ├── Matter Bridge 2 (Child Process)
    └── Matter Bridge N (Child Process)
```

### Child Matter Bridges

When you configure an accessory or platform with `_matter`, Homebridge automatically:

1. **Creates a child process** - Each Matter bridge runs in its own isolated process
2. **Manages lifecycle** - Automatic startup, restart on failure, and graceful shutdown
3. **Handles IPC** - Communication between parent and child for configuration and status
4. **Allocates ports** - Dynamic port assignment with conflict detection

Benefits of child processes:
- **Process Isolation**: Crashes in one Matter bridge don't affect others
- **Better Resource Management**: Each process has its own memory space
- **Scalability**: Handle more devices by distributing load
- **Parallel Execution**: Multiple bridges run concurrently

### IPC Communication

Child Matter bridges communicate with the parent process using:

- **Configuration Loading**: Parent sends plugin and Matter configuration
- **Status Updates**: Child reports bridge status and device count
- **Port Allocation**: Dynamic port assignment through parent
- **Accessory Management**: Add/remove accessories via IPC messages
- **Graceful Shutdown**: Coordinated cleanup on termination

## Plugin Development

### No API Changes Required

Plugins do not need any changes to support Matter. Matter exposure is handled entirely through configuration using the `_matter` property, exactly parallel to how `_bridge` works for child HAP bridges.

There are no Matter-specific API methods. All Matter functionality is configuration-driven.

### Matter Device Types and Clusters

Homebridge provides access to standard Matter device types and clusters imported from Matter.js through the API:

```typescript
import { API } from 'homebridge'

export default class MyPlatform {
  constructor(public readonly api: API) {
    // Access Matter device types
    const onOffLight = this.api.matter.deviceTypes.OnOffLight
    const dimmableLight = this.api.matter.deviceTypes.DimmableLight
    const temperatureSensor = this.api.matter.deviceTypes.TemperatureSensor

    // Access Matter clusters
    const onOffCluster = this.api.matter.clusters.OnOffCluster
    const levelControlCluster = this.api.matter.clusters.LevelControlCluster
    const temperatureMeasurementCluster = this.api.matter.clusters.TemperatureMeasurementCluster
  }
}
```

#### Available Device Types

The following Matter device types are available through `api.matter.deviceTypes`:

**Lighting:**
- `OnOffLight` - Basic on/off light
- `DimmableLight` - Dimmable light with brightness control
- `ColorTemperatureLight` - Light with color temperature adjustment
- `ExtendedColorLight` - Full-color light with hue, saturation, brightness

**Switches & Outlets:**
- `OnOffLightSwitch` - Basic on/off switch
- `DimmerSwitch` - Dimmer switch with level control
- `ColorDimmerSwitch` - Color dimmer switch
- `GenericSwitch` - Generic programmable switch
- `OnOffPlugInUnit` - Smart outlet/plug
- `DimmablePlugInUnit` - Dimmable smart outlet

**Sensors:**
- `TemperatureSensor` - Temperature measurement
- `HumiditySensor` - Humidity measurement
- `LightSensor` - Illuminance measurement
- `OccupancySensor` - Motion/occupancy detection
- `ContactSensor` - Contact/door sensor
- `PressureSensor` - Pressure measurement
- `FlowSensor` - Flow measurement

**Security:**
- `DoorLock` - Smart door lock
- `SmokeCoAlarm` - Smoke and CO alarm
- `WaterLeakDetector` - Water leak sensor
- `WaterFreezeDetector` - Water freeze sensor

**HVAC & Climate:**
- `Thermostat` - Temperature control
- `Fan` - Fan with speed control
- `WindowCovering` - Blinds, shades, curtains

#### Available Clusters

The following Matter clusters are available through `api.matter.clusters`:

**Basic Clusters:**
- `OnOffCluster` - On/off control
- `LevelControlCluster` - Brightness/level control
- `ColorControlCluster` - Color control (hue, saturation, color temperature)
- `IdentifyCluster` - Device identification

**Sensor Clusters:**
- `TemperatureMeasurementCluster` - Temperature measurement
- `RelativeHumidityMeasurementCluster` - Humidity measurement
- `IlluminanceMeasurementCluster` - Light level measurement
- `OccupancySensingCluster` - Motion/occupancy sensing
- `PressureMeasurementCluster` - Pressure measurement
- `FlowMeasurementCluster` - Flow measurement

**Control Clusters:**
- `DoorLockCluster` - Door lock control
- `ThermostatCluster` - Thermostat control
- `FanControlCluster` - Fan control
- `WindowCoveringCluster` - Window covering control
- `SwitchCluster` - Switch/button control

### Helper Functions

#### `getMatterDeviceTypeForHAPService(serviceType, characteristics?)`

Returns the appropriate Matter device type for a given HomeKit service:

```typescript
// Basic lightbulb
const deviceType1 = this.api.matter.getMatterDeviceTypeForHAPService('Lightbulb')
// Returns: 'OnOffLight'

// Dimmable lightbulb
const deviceType2 = this.api.matter.getMatterDeviceTypeForHAPService('Lightbulb', ['Brightness'])
// Returns: 'DimmableLight'

// Color lightbulb
const deviceType3 = this.api.matter.getMatterDeviceTypeForHAPService('Lightbulb', ['Brightness', 'Hue', 'Saturation'])
// Returns: 'ExtendedColorLight'
```

#### `getMatterClustersForHAPService(serviceType, characteristics?)`

Returns the appropriate Matter clusters for a given HomeKit service:

```typescript
// Basic lightbulb
const clusters1 = this.api.matter.getMatterClustersForHAPService('Lightbulb')
// Returns: ['OnOffCluster', 'IdentifyCluster']

// Dimmable lightbulb
const clusters2 = this.api.matter.getMatterClustersForHAPService('Lightbulb', ['Brightness'])
// Returns: ['OnOffCluster', 'LevelControlCluster', 'IdentifyCluster']
```

## Production Features

### Configuration Validation

All Matter configurations are automatically validated for security and correctness:

```typescript
import { MatterConfigValidator } from 'homebridge/matterConfigValidator'

// Validate configuration
const result = MatterConfigValidator.validate(matterConfig)
if (!result.isValid) {
  console.error('Configuration errors:', result.errors)
}

// Generate secure values
const securePasscode = MatterConfigValidator.generateSecurePasscode()
const randomDiscriminator = MatterConfigValidator.generateRandomDiscriminator()
```

#### Validation Features

- **Input Validation**: All parameters validated for type, range, and security
- **Passcode Security**: Prevents weak patterns and common sequences
- **Production Warnings**: Alerts about default values that should be changed
- **Error Prevention**: Stops server startup with invalid configurations

### Security Features

- **Secure Defaults**: Automatically generates secure passcodes and discriminators
- **Passcode Validation**: Prevents weak and common passcodes (e.g., 11111111, 12345678)
- **Configuration Security**: Validates all security-sensitive parameters
- **Secure Generation**: Cryptographically secure random value generation
- **Production Warnings**: Alerts for default values that should be changed

### CLI Tools

Matter configuration management is integrated into the main Homebridge CLI and configuration UI. There is no separate `homebridge-matter` CLI tool at this time.

## Examples

### Complete Configuration Example

```json
{
  "bridge": {
    "name": "Homebridge",
    "username": "CC:22:3D:E3:CE:30",
    "port": 51826,
    "pin": "031-45-154"
  },
  "accessories": [
    {
      "accessory": "ExampleSwitch",
      "name": "Example Switch with Matter Bridge",
      "_matter": {
        "enabled": true,
        "name": "Example Switch Matter Bridge",
        "port": 5541
      }
    }
  ],
  "platforms": [
    {
      "platform": "ExamplePlatform",
      "name": "Example Platform with Dual Protocols",
      "_bridge": {
        "username": "CC:22:3D:E3:CE:32",
        "port": 51827
      },
      "_matter": {
        "enabled": true,
        "name": "Platform Matter Bridge",
        "port": 5543
      }
    }
  ]
}
```

## Troubleshooting

### Child Process Won't Start

1. Check the logs for error messages
2. Verify port availability (5540-5580 range recommended)
3. Check file permissions for the child process script
4. Enable debug logging with `"debug": true` in the `_matter` configuration

### Port Conflicts

If you see port conflict errors:
- Use explicit port assignments for each bridge
- Ensure ports are in the valid range (1024-65535) and not in use
- Check for other services using the same ports with `netstat -an | grep 5540`

### Memory Usage

Child processes use additional memory. If experiencing issues:
- Monitor system resources with `top` or `htop`
- Reduce the number of child processes by combining accessories
- Consider using a single platform instead of multiple accessories

### Validation Errors

Common validation errors and solutions:
- **Port in use**: Choose a different port in the 5540-5580 range
- **Invalid name**: Ensure the name is not empty and under 32 characters

## Migration Guide

### Exposing Accessories via Matter

To expose accessories via Matter:
1. Add the `_matter` configuration to your accessory or platform (exactly like you would use `_bridge` for child HAP bridges)
2. Restart Homebridge
3. Pair the new Matter bridge with your Matter controller

### Dual Protocol Support

To expose a Matter accessory via both Matter and HAP:
1. Add the `_bridge` configuration alongside your existing `_matter` configuration
2. Restart Homebridge
3. Both bridges will run in separate child processes

### Configuration Patterns

- Use `_bridge` to expose accessories via a child HAP bridge
- Use `_matter` to expose accessories via a child Matter bridge
- Use both `_bridge` and `_matter` to expose via both protocols in separate child processes
- If neither is specified, accessories are exposed via the main HAP bridge only

## Technical Implementation

### Key Components

1. **ChildMatterBridgeService** (`src/childMatterBridgeService.ts`)
   - Manages lifecycle of child Matter bridges
   - Handles IPC communication with child processes
   - Tracks accessory registration and status

2. **ChildMatterBridgeFork** (`src/childMatterBridgeFork.ts`)
   - Standalone script executed as a child process
   - Initializes Matter server in isolated environment
   - Handles plugin loading and accessory management

3. **MatterConfigValidator** (`src/matter/matterConfigValidator.ts`)
   - Validates all Matter configurations
   - Generates secure passcodes and discriminators
   - Provides production warnings

### IPC Protocol

Child Matter bridges use the following message types:

- `READY`: Child signals readiness to receive configuration
- `LOAD`/`LOADED`: Plugin configuration exchange
- `START`/`ONLINE`: Matter bridge initialization
- `ADD_ACCESSORY`/`REMOVE_ACCESSORY`: Dynamic accessory management
- `STATUS_UPDATE`: Real-time status reporting
- `PORT_REQUEST`/`PORT_ALLOCATED`: Dynamic port allocation
- `SHUTDOWN`: Graceful termination

### Configuration Consistency

The `_matter` configuration follows the same pattern as `_bridge`:
- Both automatically create child processes when configured
- No additional flags needed to enable child process mode
- Consistent behavior across HAP and Matter protocols

## Current Status & Limitations

### What's Working

✅ **Complete Production Framework**
- Configuration validation and security
- Child process architecture
- Device type and cluster definitions exported from Matter.js
- Plugin API with TypeScript support
- Health monitoring and status APIs
- Comprehensive error handling
- Automatic HAP to Matter mapping

✅ **Security & Validation**
- Production-level input validation
- Secure passcode generation
- Configuration security checking
- Production warnings

✅ **Developer Experience**
- Complete plugin API
- TypeScript definitions
- Helper functions
- Comprehensive documentation

✅ **Operations**
- Child process management
- Automatic restart on failure
- Status monitoring
- Comprehensive logging

### Current Limitations

The Matter support in Homebridge is actively being developed. Current limitations include:

1. **Matter.js Integration**: Full Matter.js protocol integration is in progress with basic device types working
2. **Commissioning**: The Matter server auto-generates secure pairing codes and QR codes internally
3. **Thread Support**: Thread network provisioning not yet implemented
4. **Fabric Management**: Multiple controller fabric support needs implementation
5. **OTA Updates**: Over-the-air update support not implemented
6. **Device Naming**: Individual device names properly display via BridgedDeviceBasicInformationServer
7. **Bridge Naming**: Bridge names may be cached by Matter controllers (like Apple Home)

### Future Development

Areas for continued development:
- Complete Matter.js protocol integration
- Thread network provisioning and WiFi setup
- Device commissioning flows with real QR code support
- Fabric management for multiple controllers
- Performance optimization for very large deployments (1000+ devices)
- OTA firmware update support

## Performance Considerations

- Child processes add ~20-50MB memory overhead per process
- IPC communication adds minimal latency (<1ms typically)
- Startup time increases slightly with child processes
- CPU usage scales linearly with number of processes

## Compatibility

- Requires Node.js 20.17.0 or later (Node.js 24 supported in alpha)
- Compatible with Matter-certified controllers
- Works alongside traditional HAP bridges
- Supports all Homebridge plugins without modification (Matter exposure is configuration-driven)

## Best Practices

1. **Use Child Bridges for Large Platforms**: Platforms with many accessories benefit most from isolation
2. **Assign Unique Ports**: Explicitly set ports to avoid conflicts
3. **Use Secure Passcodes**: Never use default or weak passcodes in production
4. **Monitor Resource Usage**: Keep an eye on memory and CPU usage
5. **Test Configuration**: Validate your configuration before deploying to production

## Contributing

This is an evolving feature and contributions are welcome! Key areas where help is needed:

1. Complete Matter.js protocol integration
2. Thread network support implementation
3. Device commissioning flow
4. Testing with different Matter controllers
5. Performance optimization
6. Documentation improvements

Please see the Contributing Guide for more information.

## Resources

- [Matter Specification](https://csa-iot.org/all-solutions/matter/)
- [Matter.js Documentation](https://github.com/project-chip/matter.js)
- [HomeKit Accessory Protocol](https://developer.apple.com/homekit/)
- [Homebridge Plugin Development](https://developers.homebridge.io/)
- [Homebridge Documentation](https://github.com/homebridge/homebridge/wiki)
