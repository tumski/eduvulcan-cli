import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnv, parse as parseEnv } from 'dotenv';
import { CliError, EXIT_CODES } from './types.js';

const ENV_FILES = ['.env.local', '.env'];

function findEnvFiles(startDir: string, maxLevels = 5): string[] {
  const files: string[] = [];
  let current = resolve(startDir);

  for (let i = 0; i <= maxLevels; i += 1) {
    for (const name of ENV_FILES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) {
        files.push(candidate);
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return files;
}

export function loadEnvironment(cwd = process.cwd()): string[] {
  const envFiles = findEnvFiles(cwd);
  if (envFiles.length > 0) {
    loadEnv({ path: envFiles, quiet: true, override: false });
  }
  return envFiles;
}

function resolveFromFiles(varNames: string[], envFiles: string[]): string | undefined {
  for (const envFile of envFiles) {
    try {
      const parsed = parseEnv(readFileSync(envFile));
      for (const varName of varNames) {
        const value = parsed[varName];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim();
        }
      }
    } catch {
      // Ignore malformed env files and continue.
    }
  }

  return undefined;
}

function resolveValue(varNames: string[], envFiles: string[]): string | undefined {
  for (const varName of varNames) {
    const runtimeValue = process.env[varName];
    if (typeof runtimeValue === 'string' && runtimeValue.trim().length > 0) {
      return runtimeValue.trim();
    }
  }

  return resolveFromFiles(varNames, envFiles);
}

export interface RuntimeConfig {
  username: string;
  password: string;
  headless: boolean;
  envFiles: string[];
}

export function getRuntimeConfig(cwd = process.cwd()): RuntimeConfig {
  const envFiles = loadEnvironment(cwd);
  const username = resolveValue(['EDUVULCAN_USERNAME', 'SITE_EDUVULCAN_USERNAME'], envFiles);
  const password = resolveValue(['EDUVULCAN_PASSWORD', 'SITE_EDUVULCAN_PASSWORD'], envFiles);

  if (!username || !password) {
    throw new CliError(
      `Missing credentials. Set EDUVULCAN_USERNAME / EDUVULCAN_PASSWORD (or legacy SITE_EDUVULCAN_USERNAME / SITE_EDUVULCAN_PASSWORD). Checked env files: ${envFiles.join(', ') || '(none found)'}`,
      EXIT_CODES.MISSING_CREDENTIALS,
    );
  }

  const headless = process.env.BROWSER_HEADLESS !== 'false';

  return {
    username,
    password,
    headless,
    envFiles,
  };
}
