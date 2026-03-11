#!/usr/bin/env node
import { resolve } from 'node:path';
import { getRuntimeConfig, loadEnvironment } from './config.js';
import { fetchSnapshot } from './fetch.js';
import { writeJsonAtomic } from './storage.js';
import { CliError, EXIT_CODES, type FetchProfile } from './types.js';

interface ParsedArgs {
  command: 'fetch' | 'help';
  output?: string;
  outputDir?: string;
  debugDir?: string;
  headlessOverride?: boolean;
  date?: string;
  timezone?: string;
  profile: FetchProfile;
}

function usage(): string {
  return [
    'eduvulcan-fetch',
    '',
    'Usage:',
    '  eduvulcan-fetch [fetch] [--date today|tomorrow|YYYY-MM-DD] [--profile standard|comprehensive] [--timezone Europe/Warsaw] [--output <path>] [--output-dir <dir>] [--debug-dir <dir>] [--headless|--headed]',
    '  eduvulcan-fetch help',
    '',
    'Examples:',
    '  eduvulcan-fetch',
    '  eduvulcan-fetch --date tomorrow',
    '  eduvulcan-fetch --date 2026-03-13 --profile comprehensive',
    '  eduvulcan-fetch --output-dir ./data --debug-dir ./logs',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const [maybeCommand, ...rest] = argv;
  const command = !maybeCommand || maybeCommand === 'fetch' ? 'fetch' : maybeCommand === 'help' || maybeCommand === '--help' || maybeCommand === '-h' ? 'help' : null;

  if (!command) {
    throw new CliError(`Unknown command: ${maybeCommand}\n\n${usage()}`, EXIT_CODES.UNEXPECTED);
  }

  const parsed: ParsedArgs = { command, profile: 'standard' };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];

    switch (arg) {
      case '--output':
        if (!next) throw new CliError('--output requires a path value', EXIT_CODES.UNEXPECTED);
        parsed.output = next;
        index += 1;
        break;
      case '--output-dir':
        if (!next) throw new CliError('--output-dir requires a directory value', EXIT_CODES.UNEXPECTED);
        parsed.outputDir = next;
        index += 1;
        break;
      case '--debug-dir':
        if (!next) throw new CliError('--debug-dir requires a directory value', EXIT_CODES.UNEXPECTED);
        parsed.debugDir = next;
        index += 1;
        break;
      case '--date':
        if (!next) throw new CliError('--date requires a value', EXIT_CODES.UNEXPECTED);
        parsed.date = next;
        index += 1;
        break;
      case '--timezone':
        if (!next) throw new CliError('--timezone requires a value', EXIT_CODES.UNEXPECTED);
        parsed.timezone = next;
        index += 1;
        break;
      case '--profile':
        if (!next || (next !== 'standard' && next !== 'comprehensive')) {
          throw new CliError('--profile requires standard or comprehensive', EXIT_CODES.UNEXPECTED);
        }
        parsed.profile = next;
        index += 1;
        break;
      case '--headless':
        parsed.headlessOverride = true;
        break;
      case '--headed':
        parsed.headlessOverride = false;
        break;
      case '--help':
      case '-h':
        parsed.command = 'help';
        break;
      default:
        throw new CliError(`Unknown argument: ${arg}\n\n${usage()}`, EXIT_CODES.UNEXPECTED);
    }
  }

  return parsed;
}

async function runFetch(args: ParsedArgs): Promise<void> {
  const config = getRuntimeConfig(process.cwd());
  const headless = args.headlessOverride ?? config.headless;

  const snapshot = await fetchSnapshot({
    username: config.username,
    password: config.password,
    headless,
    debugDir: args.debugDir ? resolve(args.debugDir) : undefined,
    targetDate: args.date,
    timezone: args.timezone,
    profile: args.profile,
  });

  if (args.outputDir) {
    const outputDir = resolve(args.outputDir);
    const suffix = args.profile === 'comprehensive' ? '.comprehensive' : '';
    await writeJsonAtomic(resolve(outputDir, `${snapshot.targetDate}${suffix}.json`), snapshot);
    await writeJsonAtomic(resolve(outputDir, `latest${suffix}.json`), snapshot);
  }

  if (args.output) {
    await writeJsonAtomic(resolve(args.output), snapshot);
  }

  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

async function main(): Promise<void> {
  loadEnvironment(process.cwd());
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    process.exit(EXIT_CODES.SUCCESS);
  }

  try {
    await runFetch(args);
    process.exit(EXIT_CODES.SUCCESS);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.exitCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(EXIT_CODES.UNEXPECTED);
  }
}

void main();
