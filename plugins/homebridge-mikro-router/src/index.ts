import type { API } from '../../../src/api';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MikroRouterPlatform } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MikroRouterPlatform);
};
