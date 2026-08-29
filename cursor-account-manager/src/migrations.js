"use strict";

const DEFAULT_MANUAL_TOKEN_LOCATIONS = Object.freeze([
    Object.freeze({ section: "cursorAccountManager", key: "manualCursorToken" }),
    Object.freeze({ section: "keepchat", key: "manualCursorToken" })
]);

class MigrationError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = "MigrationError";
        this.code = code;
        if (cause !== undefined)
            this.cause = cause;
    }
}

function requireAdapter(configuration) {
    if (!configuration || typeof configuration.get !== "function")
        throw new MigrationError("ERR_INVALID_CONFIGURATION_ADAPTER", "configuration adapter must implement get(section, key)");
    if (typeof configuration.clear !== "function" && typeof configuration.update !== "function") {
        throw new MigrationError(
            "ERR_INVALID_CONFIGURATION_ADAPTER",
            "configuration adapter must implement clear(section, key) or update(section, key, value)"
        );
    }
}

function requireRepository(repository) {
    if (!repository ||
        typeof repository.getManualToken !== "function" ||
        typeof repository.setManualToken !== "function") {
        throw new MigrationError(
            "ERR_INVALID_ACCOUNT_REPOSITORY",
            "repository must implement getManualToken() and setManualToken()"
        );
    }
}

function normalizeLocations(locations) {
    if (locations === undefined)
        return DEFAULT_MANUAL_TOKEN_LOCATIONS.map(item => ({ ...item }));
    if (!Array.isArray(locations) || locations.length === 0)
        throw new MigrationError("ERR_INVALID_MIGRATION_LOCATIONS", "manual token locations must be a non-empty array");
    return locations.map((location, index) => {
        if (!location ||
            typeof location.section !== "string" ||
            !location.section ||
            typeof location.key !== "string" ||
            !location.key) {
            throw new MigrationError("ERR_INVALID_MIGRATION_LOCATIONS", `manual token location ${index} is invalid`);
        }
        return {
            section: location.section,
            key: location.key
        };
    });
}

async function clearLocation(configuration, location) {
    if (typeof configuration.clear === "function")
        await configuration.clear(location.section, location.key);
    else
        await configuration.update(location.section, location.key, undefined);

    const observed = await configuration.get(location.section, location.key);
    if (typeof observed === "string" && observed.trim()) {
        throw new MigrationError(
            "ERR_PLAINTEXT_CONFIG_DELETE",
            `plaintext configuration ${location.section}.${location.key} still exists after deletion`
        );
    }
}

/**
 * Moves the old manualCursorToken setting into SecretStorage.
 *
 * The injected configuration adapter is deliberately independent of vscode:
 *   get(section, key) -> string | undefined
 *   clear(section, key) -> Promise<void>
 * or update(section, key, undefined) -> Promise<void>
 */
async function migrateManualTokenFromConfiguration(options) {
    if (!options || typeof options !== "object")
        throw new MigrationError("ERR_INVALID_MIGRATION_OPTIONS", "migration options are required");
    const repository = options.repository;
    const configuration = options.configuration;
    requireRepository(repository);
    requireAdapter(configuration);
    const locations = normalizeLocations(options.locations);

    const plaintext = [];
    for (const location of locations) {
        const value = await configuration.get(location.section, location.key);
        if (typeof value === "string" && value.trim()) {
            plaintext.push({
                ...location,
                token: value.trim()
            });
        }
    }
    if (!plaintext.length)
        return { migrated: false, cleared: 0, source: null };

    const distinctTokens = new Set(plaintext.map(item => item.token));
    if (distinctTokens.size !== 1) {
        throw new MigrationError(
            "ERR_MANUAL_TOKEN_CONFLICT",
            "plaintext manual token settings disagree; no setting was deleted"
        );
    }

    const token = plaintext[0].token;
    const existing = await repository.getManualToken();
    if (existing && existing !== token) {
        throw new MigrationError(
            "ERR_MANUAL_TOKEN_CONFLICT",
            "SecretStorage and plaintext manual token settings disagree; no setting was deleted"
        );
    }

    if (!existing)
        await repository.setManualToken(token);
    const verified = await repository.getManualToken();
    if (verified !== token) {
        throw new MigrationError(
            "ERR_MANUAL_TOKEN_VERIFY",
            "manual token did not verify in SecretStorage; plaintext was retained"
        );
    }

    let cleared = 0;
    for (const location of plaintext) {
        await clearLocation(configuration, location);
        cleared += 1;
    }
    return {
        migrated: !existing,
        cleared,
        source: {
            section: plaintext[0].section,
            key: plaintext[0].key
        }
    };
}

const migratePlaintextConfiguration = migrateManualTokenFromConfiguration;

module.exports = {
    DEFAULT_MANUAL_TOKEN_LOCATIONS,
    MigrationError,
    migrateManualTokenFromConfiguration,
    migratePlaintextConfiguration
};
