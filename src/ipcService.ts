import { EventEmitter } from 'node:events'
import process from 'node:process'

// eslint-disable-next-line no-restricted-syntax
export const enum IpcIncomingEvent {
  RESTART_CHILD_BRIDGE = 'restartChildBridge',
  STOP_CHILD_BRIDGE = 'stopChildBridge',
  START_CHILD_BRIDGE = 'startChildBridge',
  CHILD_BRIDGE_METADATA_REQUEST = 'childBridgeMetadataRequest',
  RESTART_MATTER_BRIDGE = 'restartMatterBridge',
  STOP_MATTER_BRIDGE = 'stopMatterBridge',
  START_MATTER_BRIDGE = 'startMatterBridge',
  MATTER_BRIDGE_METADATA_REQUEST = 'matterBridgeMetadataRequest',
  MATTER_ACCESSORIES_REQUEST = 'matterAccessoriesRequest',
  TOGGLE_MATTER_DEVICE = 'toggleMatterDevice',
  MATTER_COMMISSIONING_INFO_REQUEST = 'matterCommissioningInfoRequest',
}

// eslint-disable-next-line no-restricted-syntax
export const enum IpcOutgoingEvent {
  SERVER_STATUS_UPDATE = 'serverStatusUpdate',
  CHILD_BRIDGE_METADATA_RESPONSE = 'childBridgeMetadataResponse',
  CHILD_BRIDGE_STATUS_UPDATE = 'childBridgeStatusUpdate',
  MATTER_BRIDGE_METADATA_RESPONSE = 'matterBridgeMetadataResponse',
  MATTER_BRIDGE_STATUS_UPDATE = 'matterBridgeStatusUpdate',
  MATTER_ACCESSORIES_RESPONSE = 'matterAccessoriesResponse',
  MATTER_DEVICE_STATUS_UPDATE = 'matterDeviceStatusUpdate',
  MATTER_COMMISSIONING_STATUS = 'matterCommissioningStatus',
  MATTER_COMMISSIONING_INFO_RESPONSE = 'matterCommissioningInfoResponse',
}

// eslint-disable-next-line ts/no-unsafe-declaration-merging
export declare interface IpcService {
  on: ((event: IpcIncomingEvent.RESTART_CHILD_BRIDGE, listener: (childBridgeUsername: string) => void) => this) & ((event: IpcIncomingEvent.STOP_CHILD_BRIDGE, listener: (childBridgeUsername: string) => void) => this) & ((event: IpcIncomingEvent.START_CHILD_BRIDGE, listener: (childBridgeUsername: string) => void) => this) & ((event: IpcIncomingEvent.CHILD_BRIDGE_METADATA_REQUEST, listener: () => void) => this) & ((event: IpcIncomingEvent.RESTART_MATTER_BRIDGE, listener: (matterBridgeId: string) => void) => this) & ((event: IpcIncomingEvent.STOP_MATTER_BRIDGE, listener: (matterBridgeId: string) => void) => this) & ((event: IpcIncomingEvent.START_MATTER_BRIDGE, listener: (matterBridgeId: string) => void) => this) & ((event: IpcIncomingEvent.MATTER_BRIDGE_METADATA_REQUEST, listener: () => void) => this) & ((event: IpcIncomingEvent.MATTER_ACCESSORIES_REQUEST, listener: () => void) => this) & ((event: IpcIncomingEvent.TOGGLE_MATTER_DEVICE, listener: (data: { uuid: string, enabled: boolean }) => void) => this) & ((event: IpcIncomingEvent.MATTER_COMMISSIONING_INFO_REQUEST, listener: (matterBridgeId: string) => void) => this)
}

// eslint-disable-next-line ts/no-unsafe-declaration-merging
export class IpcService extends EventEmitter {
  constructor() {
    super()
  }

  /**
   * Start the IPC service listeners/
   * Currently this will only listen for messages from a parent process.
   */
  public start(): void {
    process.on('message', (message: { id: string, data: never }) => {
      if (!message || typeof message !== 'object' || !message.id) {
        return
      }
      this.emit(message.id, message.data)
    })
  }

  /**
   * Send a message to connected IPC clients.
   * Currently, this will only send messages if Homebridge was launched as a child_process.fork()
   * from another Node.js process (such as hb-service).
   */
  public sendMessage(id: IpcOutgoingEvent, data: unknown): void {
    if (process.send) {
      process.send({
        id,
        data,
      })
    }
  }
}
