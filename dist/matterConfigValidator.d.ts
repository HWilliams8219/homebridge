import { MatterConfiguration } from './matterService.js';
export interface MatterConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validate Matter configuration for production readiness
 */
export declare class MatterConfigValidator {
    /**
     * Validate a Matter configuration object
     */
    static validate(config: MatterConfiguration): MatterConfigValidationResult;
    private static validateRequired;
    private static validatePort;
    private static validateDiscriminator;
    private static validatePasscode;
    private static validateVendorProductIds;
    private static validateDeviceName;
    private static validateTimeouts;
    private static checkProductionReadiness;
    private static hasRepeatingPattern;
    private static isWeakPasscode;
    /**
     * Generate a secure random passcode
     */
    static generateSecurePasscode(): number;
    /**
     * Generate a random discriminator
     */
    static generateRandomDiscriminator(): number;
}
//# sourceMappingURL=matterConfigValidator.d.ts.map