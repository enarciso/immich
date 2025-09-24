#! /usr/bin/env node
import { Command, Option } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { upload } from 'src/commands/asset';
import { login, logout } from 'src/commands/auth';
import { serverInfo } from 'src/commands/server-info';
import { storageS3Migrate, storageS3Plan, storageS3Verify } from 'src/commands/storage';
import { version } from '../package.json';

const defaultConfigDirectory = path.join(os.homedir(), '.config/immich/');

const program = new Command()
  .name('immich')
  .version(version)
  .description('Command line interface for Immich')
  .addOption(
    new Option('-d, --config-directory <directory>', 'Configuration directory where auth.yml will be stored')
      .env('IMMICH_CONFIG_DIR')
      .default(defaultConfigDirectory),
  )
  .addOption(new Option('-u, --url [url]', 'Immich server URL').env('IMMICH_INSTANCE_URL'))
  .addOption(new Option('-k, --key [key]', 'Immich API key').env('IMMICH_API_KEY'));

program
  .command('login')
  .alias('login-key')
  .description('Login using an API key')
  .argument('url', 'Immich server URL')
  .argument('key', 'Immich API key')
  .action((url, key) => login(url, key, program.opts()));

program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => logout(program.opts()));

program
  .command('server-info')
  .description('Display server information')
  .action(() => serverInfo(program.opts()));

program
  .command('upload')
  .description('Upload assets')
  .usage('[paths...] [options]')
  .addOption(new Option('-r, --recursive', 'Recursive').env('IMMICH_RECURSIVE').default(false))
  .addOption(new Option('-i, --ignore <pattern>', 'Pattern to ignore').env('IMMICH_IGNORE_PATHS'))
  .addOption(new Option('-h, --skip-hash', "Don't hash files before upload").env('IMMICH_SKIP_HASH').default(false))
  .addOption(new Option('-H, --include-hidden', 'Include hidden folders').env('IMMICH_INCLUDE_HIDDEN').default(false))
  .addOption(
    new Option('-a, --album', 'Automatically create albums based on folder name')
      .env('IMMICH_AUTO_CREATE_ALBUM')
      .default(false),
  )
  .addOption(
    new Option('-A, --album-name <name>', 'Add all assets to specified album')
      .env('IMMICH_ALBUM_NAME')
      .conflicts('album'),
  )
  .addOption(
    new Option('-n, --dry-run', "Don't perform any actions, just show what will be done")
      .env('IMMICH_DRY_RUN')
      .default(false)
      .conflicts('skipHash'),
  )
  .addOption(
    new Option('-c, --concurrency <number>', 'Number of assets to upload at the same time')
      .env('IMMICH_UPLOAD_CONCURRENCY')
      .default(4),
  )
  .addOption(
    new Option('-j, --json-output', 'Output detailed information in json format')
      .env('IMMICH_JSON_OUTPUT')
      .default(false),
  )
  .addOption(new Option('--delete', 'Delete local assets after upload').env('IMMICH_DELETE_ASSETS'))
  .addOption(new Option('--no-progress', 'Hide progress bars').env('IMMICH_PROGRESS_BAR').default(true))
  .addOption(
    new Option('--watch', 'Watch for changes and upload automatically')
      .env('IMMICH_WATCH_CHANGES')
      .default(false)
      .implies({ progress: false }),
  )
  .argument('[paths...]', 'One or more paths to assets to be uploaded')
  .action((paths, options) => upload(paths, program.opts(), options));

// storage subcommands
const storage = program.command('storage').description('Storage utilities');

storage
  .command('s3-plan')
  .description('Print suggested commands to migrate from local storage to S3')
  .addOption(
    new Option('--media-base <path>', 'Absolute path to Immich media directory (on the server host)')
      .env('IMMICH_MEDIA_LOCATION')
      .makeOptionMandatory(true),
  )
  .addOption(new Option('--bucket <name>', 'Destination S3 bucket').env('S3_BUCKET').makeOptionMandatory(true))
  .addOption(new Option('--prefix <prefix>', 'Destination S3 prefix').env('S3_PREFIX'))
  .addOption(new Option('--profile <name>', 'AWS CLI profile to use').env('AWS_PROFILE'))
  .addOption(new Option('--tool <tool>', 'Tool to target: aws|s5cmd|both').choices(['aws', 's5cmd', 'both']))
  .action((options) => storageS3Plan(program.opts(), options));

storage
  .command('s3-migrate')
  .description('Execute a local-to-S3 sync using AWS CLI or s5cmd')
  .addOption(
    new Option('--media-base <path>', 'Absolute path to Immich media directory (on the server host)')
      .env('IMMICH_MEDIA_LOCATION')
      .makeOptionMandatory(true),
  )
  .addOption(new Option('--bucket <name>', 'Destination S3 bucket').env('S3_BUCKET').makeOptionMandatory(true))
  .addOption(new Option('--prefix <prefix>', 'Destination S3 prefix').env('S3_PREFIX'))
  .addOption(new Option('--profile <name>', 'AWS CLI profile to use').env('AWS_PROFILE'))
  .addOption(new Option('--tool <tool>', 'Tool to use: auto|aws|s5cmd').choices(['auto', 'aws', 's5cmd']).default('auto'))
  .addOption(new Option('--concurrency <number>', 'Concurrency (s5cmd: workers)').env('S3_MIGRATE_CONCURRENCY'))
  .addOption(new Option('--dry-run', 'Preview without copying (aws: --dryrun, s5cmd: -n)'))
  .action((options) => storageS3Migrate(program.opts(), options));

storage
  .command('s3-verify')
  .description('Verify that assets on the server now reference s3:// paths')
  .addOption(new Option('--sample <number>', 'Number of assets to sample').default(100))
  .addOption(new Option('--expect-prefix <s3://bucket/prefix>', 'Expected S3 URI prefix for assets'))
  .action((options) => storageS3Verify(program.opts(), options));

program.parse(process.argv);
